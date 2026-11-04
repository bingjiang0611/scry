import { createHash } from 'node:crypto'
import {
  readSideChatItemBodyPage, readSideChatManifestItem, readSideChatManifestItems, readSideChatMessagePage,
  assertSideChatSnapshotDescriptor,
  type SideChatManifestItem, type SideChatSnapshotDescriptor
} from './conversation-side-chat-manifest'
import { readRecorderContentPage } from '../core/turn-recorder/content-store'
import { isToolContentRef } from '../shared/tool-content'
import {
  conversationCoverage, conversationItemKey, sideChatSnapshotIndexOf, sideChatSnapshotRunId,
  type Conversation, type ConversationItemRef, type SideChatSnapshotArtifact, type SideChatSnapshotItem
} from '../shared/conversation'
import type { SideChatSnapshotBodyItem, SideChatSnapshotBodyPage } from '../shared/conversation-api'
import { MAX_SIDE_CHAT_SNAPSHOT_BYTES } from './conversation-schema'
import { conversationHistoryRoot, type HistoryMessage } from './conversation-history-content'
import { MAX_HANDOFF_BYTES } from './conversation-handoff-budget'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The recorder content pager caps one read at 256 KiB; bodies are read in bounded pages. */
const SNAPSHOT_READ_PAGE_BYTES = 256 * 1024

/**
 * Side chats keep their frozen source prefix under their own content root. This is
 * child-owned evidence: deleting the source conversation must not remove it, and it
 * is never a trace archive or an execution turn of this child.
 */
interface SealedSnapshotArtifact {
  version: 3
  kind: 'side-chat-snapshot'
  conversationId: string
  cwd: string
  snapshotId: string
  throughOrdinal: number
  throughRunId: string
  prefixFingerprint: string
  messages: HistoryMessage[]
}

export type SideChatSnapshotOwner = Pick<Conversation, 'id' | 'cwd' | 'sideChat'>
/** Identity fields known before the body is sealed; the child id already exists. */

function origin(conversation: SideChatSnapshotOwner) {
  if (!conversation.sideChat) throw new Error('该对话没有冻结的侧聊快照')
  return conversation.sideChat
}

/** Format 3 artifact, or undefined for a format 4 record. */
function artifactOf(conversation: SideChatSnapshotOwner): SideChatSnapshotArtifact | undefined {
  const snapshot = origin(conversation).snapshot
  return snapshot.format === 4 ? undefined : snapshot
}

/** Format 4 descriptor, or undefined for a legacy format 3 record. */
function descriptor(conversation: SideChatSnapshotOwner): SideChatSnapshotDescriptor | undefined {
  const snapshot = origin(conversation).snapshot
  if (snapshot.format !== 4) return undefined
  assertSideChatSnapshotDescriptor(snapshot)
  return snapshot
}

/** True only for refs of this child's own snapshot; a source ref never matches. */
export function belongsToSideChatSnapshot(conversation: Pick<Conversation, 'sideChat'>, ref: { runId: string }): boolean {
  return conversation.sideChat !== undefined &&
    ref.runId.startsWith(`side-chat:${conversation.sideChat.snapshot.id}:`)
}

function assertMessage(item: SideChatSnapshotItem, message: HistoryMessage): void {
  if (conversationItemKey(message.ref) !== conversationItemKey(item.ref) || message.role !== item.role ||
    message.ordinal !== item.sourceOrdinal || message.providerId !== item.providerId ||
    typeof message.text !== 'string' || hash(message.text) !== item.ref.contentHash) {
    throw new Error('侧聊快照正文与冻结元数据不一致')
  }
}

/** Reopens the child-owned body; it never falls back to a source archive. */
export async function loadSideChatSnapshotMessages(
  userData: string,
  conversation: SideChatSnapshotOwner
): Promise<HistoryMessage[]> {
  const frozen = origin(conversation)
  const v4 = descriptor(conversation)
  if (v4) {
    const root = conversationHistoryRoot(userData, conversation)
    const messages: HistoryMessage[] = []
    for (let from = 0; from < v4.messageCount; from += 32) {
      const count = Math.min(32, v4.messageCount - from)
      const page = await readSideChatManifestItems(root, v4, from, count)
      for (const [offset, item] of page.entries()) messages.push(await messageOf(root, v4, item, from + offset))
    }
    return messages
  }
  const artifact = frozen.snapshot
  if (artifact.format === 4 || !isToolContentRef(artifact.content) || artifact.content.encoding !== 'json' ||
    artifact.content.bytes > MAX_SIDE_CHAT_SNAPSHOT_BYTES) throw new Error('侧聊快照正文引用无效')
  const chunks: Buffer[] = []
  let offset = 0
  do {
    const page = await readRecorderContentPage(conversationHistoryRoot(userData, conversation), artifact.content,
      { offset, limit: SNAPSHOT_READ_PAGE_BYTES })
    chunks.push(Buffer.from(page.dataBase64, 'base64'))
    offset = page.nextOffset
    if (!page.hasMore) break
  } while (offset < artifact.content.bytes)
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SealedSnapshotArtifact
  if (value.version !== 3 || value.kind !== 'side-chat-snapshot' || value.conversationId !== conversation.id ||
    value.cwd !== conversation.cwd || value.snapshotId !== artifact.id ||
    value.throughOrdinal !== artifact.throughOrdinal || value.throughRunId !== artifact.throughRunId ||
    value.prefixFingerprint !== artifact.prefixFingerprint || !Array.isArray(value.messages) ||
    value.messages.length !== artifact.items.length) throw new Error('侧聊快照正文身份不匹配')
  const messages: HistoryMessage[] = []
  for (const [index, item] of artifact.items.entries()) {
    const message = value.messages[index]
    assertMessage(item, message)
    messages.push({ ...message, ref: { ...message.ref } })
  }
  return messages
}

/** Snapshot item by position, for callers that page metadata instead of holding it. */
export async function readSideChatSnapshotItem(
  userData: string,
  conversation: SideChatSnapshotOwner,
  index: number
): Promise<SideChatSnapshotItem> {
  const v4 = descriptor(conversation)
  if (!v4) {
    const item = artifactOf(conversation)?.items[index]
    if (!item) throw new Error('侧聊快照消息位置越界')
    return { ...item, ref: { ...item.ref } }
  }
  const item = await readSideChatManifestItem(conversationHistoryRoot(userData, conversation), v4, index)
  return { ref: { ...item.ref }, sourceOrdinal: item.sourceOrdinal, providerId: item.providerId as SideChatSnapshotItem['providerId'], role: item.role }
}

/** One frozen message by position, read and hash-verified without loading its siblings. */
export async function readSideChatSnapshotMessageAt(
  userData: string,
  conversation: SideChatSnapshotOwner,
  index: number
): Promise<HistoryMessage> {
  const v4 = descriptor(conversation)
  const root = conversationHistoryRoot(userData, conversation)
  if (!v4) return (await loadSideChatSnapshotMessages(userData, conversation))[index]
  const item = await readSideChatManifestItem(root, v4, index)
  return messageOf(root, v4, item, index)
}

function indexOfRef(conversation: SideChatSnapshotOwner, ref: ConversationItemRef): number {
  return sideChatSnapshotIndexOf(origin(conversation).snapshot, ref)
}

/** Bounded read of one frozen message, used by readItem. */
export async function readSideChatSnapshotMessage(
  userData: string,
  conversation: SideChatSnapshotOwner,
  ref: ConversationItemRef
): Promise<HistoryMessage> {
  const index = indexOfRef(conversation, ref)
  if (index < 0) throw new Error('正文引用不属于当前侧聊快照')
  const message = await readSideChatSnapshotMessageAt(userData, conversation, index)
  if (conversationItemKey(message.ref) !== conversationItemKey(ref)) throw new Error('侧聊快照正文引用不匹配')
  return message
}

/**
 * Every frozen ref in order, read from the manifest in bounded pages.
 *
 * Callers that must hand the frozen prefix to a Provider need the ordered refs; reading
 * them one page at a time keeps the cost linear in the item count instead of requiring
 * the whole index in one record field.
 */
export async function sideChatSnapshotRefs(
  userData: string,
  conversation: SideChatSnapshotOwner
): Promise<ConversationItemRef[]> {
  const v4 = descriptor(conversation)
  if (!v4) return (artifactOf(conversation)?.items ?? []).map(item => ({ ...item.ref }))
  const root = conversationHistoryRoot(userData, conversation)
  const refs: ConversationItemRef[] = []
  for (let from = 0; from < v4.messageCount; from += 32) {
    const page = await readSideChatManifestItems(root, v4, from, Math.min(32, v4.messageCount - from))
    for (const item of page) refs.push({ ...item.ref })
  }
  return refs
}

/**
 * The newest frozen refs that could still travel inline.
 *
 * A v4 child can hold thousands of messages, and only a small newest window can ever fit
 * the handoff's inline byte budget. Planning therefore reads manifest metadata from the
 * newest end until that budget or a hard item cap is reached, so neither a plan nor the
 * IPC payload carries one reference per frozen message. Everything older stays owned by
 * the sealed manifest and is reachable through the Provider's history reader.
 */
export async function sideChatInlineCandidates(
  userData: string,
  conversation: SideChatSnapshotOwner,
  budgetBytes: number
): Promise<ConversationItemRef[]> {
  const v4 = descriptor(conversation)
  if (!v4) return (artifactOf(conversation)?.items ?? []).map(item => ({ ...item.ref }))
  const root = conversationHistoryRoot(userData, conversation)
  const newest: ConversationItemRef[] = []
  let bytes = 0
  for (let to = v4.messageCount; to > 0 && bytes < budgetBytes && newest.length < INLINE_CANDIDATE_ITEMS;) {
    const from = Math.max(0, to - 32)
    const page = await readSideChatManifestItems(root, v4, from, to - from)
    for (let index = page.length - 1; index >= 0; index -= 1) {
      const item = page[index]
      // A body past the whole inline budget can never be inline; the reader serves it.
      if (bytes + item.bytes > budgetBytes) continue
      bytes += item.bytes
      newest.push({ ...item.ref })
      if (bytes >= budgetBytes || newest.length >= INLINE_CANDIDATE_ITEMS) break
    }
    to = from
  }
  return newest.reverse()
}

/** Hard cap on inline candidates, independent of how small the bodies are. */
export const INLINE_CANDIDATE_ITEMS = 400

/**
 * The reference list a plan may carry for this child.
 *
 * A legacy snapshot is small enough to hand over whole; a v4 child contributes only the
 * newest inline window, because every other frozen message can only travel through the
 * history reader and would otherwise be enumerated into the plan and the IPC payload.
 */
export async function sideChatPlanRefs(
  userData: string,
  conversation: SideChatSnapshotOwner
): Promise<ConversationItemRef[]> {
  if (!descriptor(conversation)) return sideChatSnapshotRefs(userData, conversation)
  return sideChatInlineCandidates(userData, conversation, MAX_HANDOFF_BYTES)
}

/**
 * Covered and missing frozen positions for one binding.
 *
 * The manifest, not the conversation record, is the ordered authority for a v4 child, so
 * both planning and sealing ask this one function which positions this run still owes the
 * Provider. Covered positions stay excluded; every other position is either inline or
 * omitted, and the two sets are exactly complementary.
 */
export function sideChatContextPositions(
  conversation: Pick<Conversation, 'sideChat' | 'turns' | 'fork'>,
  bindingId: string | undefined
): { covered: number[]; missing: number[] } {
  const snapshot = conversation.sideChat?.snapshot
  if (snapshot?.format !== 4) return { covered: [], missing: [] }
  const covered: number[] = []
  if (bindingId !== undefined) {
    for (const ref of conversationCoverage(conversation, bindingId)) {
      const index = sideChatSnapshotIndexOf(snapshot, ref)
      if (index >= 0) covered.push(index)
    }
  }
  covered.sort((left, right) => left - right)
  const delivered = new Set(covered)
  const missing: number[] = []
  for (let index = 0; index < snapshot.messageCount; index += 1) if (!delivered.has(index)) missing.push(index)
  return { covered, missing }
}

/** One viewer page: at most 40 messages and 256 KiB of real UTF-8 body per read. */
export const SIDE_CHAT_BODY_PAGE_ITEMS = 40
export const SIDE_CHAT_BODY_PAGE_BYTES = 256 * 1024
const BODY_CURSOR_PATTERN = /^(\d{1,9}):(\d{1,12})$/

/** Cursor is `<message index>:<byte offset inside that message>`. */
export function parseSideChatBodyCursor(value: string): { index: number; offset: number } {
  const match = BODY_CURSOR_PATTERN.exec(value)
  if (!match) throw new Error('侧聊正文游标无效')
  const index = Number(match[1])
  const offset = Number(match[2])
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset)) throw new Error('侧聊正文游标无效')
  return { index, offset }
}

/** Largest prefix whose UTF-8 bytes fit, never splitting a surrogate pair. */
function cutAtByteBudget(text: string, budget: number): number {
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= budget) low = middle
    else high = middle - 1
  }
  const code = text.charCodeAt(low - 1)
  return code >= 0xd800 && code <= 0xdbff ? Math.max(0, low - 1) : low
}

/**
 * One page of real frozen bodies.
 *
 * Format 4 reads only the manifest leaves and body parts the page covers, so a page
 * costs O(height) node reads no matter how large the frozen history is. A message
 * larger than the page budget gets an explicit continuation cursor instead of a
 * silently truncated body.
 */
export async function readSideChatSnapshotBodyPage(
  userData: string,
  conversation: SideChatSnapshotOwner,
  cursorInput?: string
): Promise<SideChatSnapshotBodyPage> {
  const v4 = descriptor(conversation)
  if (v4) return readManifestBodyPage(userData, conversation, v4, cursorInput)
  const frozen = origin(conversation)
  const artifact = frozen.snapshot
  if (artifact.format === 4) throw new Error('侧聊快照正文引用无效')
  const cursor = cursorInput === undefined ? { index: 0, offset: 0 } : parseSideChatBodyCursor(cursorInput)
  const messages = await loadSideChatSnapshotMessages(userData, conversation)
  if (cursor.index > messages.length) throw new Error('侧聊正文游标已越界')
  if (cursor.index === messages.length) {
    if (cursor.offset !== 0) throw new Error('侧聊正文游标已越界')
    return { conversationId: conversation.id, items: [], byteLimit: SIDE_CHAT_BODY_PAGE_BYTES }
  }
  if (cursor.offset > messages[cursor.index].text.length) throw new Error('侧聊正文游标已越界')
  const items: SideChatSnapshotBodyItem[] = []
  let index = cursor.index
  let offset = cursor.offset
  let bytes = 0
  let nextCursor: string | undefined
  while (index < messages.length) {
    const message = messages[index]
    const item = artifact.items[index]
    if (!item) throw new Error('侧聊快照缺少消息元数据')
    const room = SIDE_CHAT_BODY_PAGE_BYTES - bytes
    if (room <= 0) { nextCursor = `${index}:${offset}`; break }
    const cut = offset + cutAtByteBudget(message.text.slice(offset), room)
    items.push({
      ref: message.ref, role: message.role, providerId: message.providerId as SideChatSnapshotBodyItem['providerId'],
      sourceOrdinal: item.sourceOrdinal, text: message.text.slice(offset, cut)
    })
    bytes += Buffer.byteLength(message.text.slice(offset, cut), 'utf8')
    if (cut < message.text.length) { nextCursor = `${index}:${cut}`; break }
    index += 1
    offset = 0
    if (items.length >= SIDE_CHAT_BODY_PAGE_ITEMS) { nextCursor = index < messages.length ? `${index}:0` : undefined; break }
  }
  return { conversationId: conversation.id, items, ...(nextCursor ? { nextCursor } : {}), byteLimit: SIDE_CHAT_BODY_PAGE_BYTES }
}

async function readManifestBodyPage(
  userData: string,
  conversation: SideChatSnapshotOwner,
  v4: SideChatSnapshotDescriptor,
  cursorInput: string | undefined
): Promise<SideChatSnapshotBodyPage> {
  const cursor = cursorInput === undefined ? { index: 0, offset: 0 } : parseSideChatBodyCursor(cursorInput)
  if (cursor.index > v4.messageCount) throw new Error('侧聊正文游标已越界')
  if (cursor.index === v4.messageCount) {
    if (cursor.offset !== 0) throw new Error('侧聊正文游标已越界')
    return { conversationId: conversation.id, items: [], byteLimit: SIDE_CHAT_BODY_PAGE_BYTES }
  }
  const root = conversationHistoryRoot(userData, conversation)
  const items: SideChatSnapshotBodyItem[] = []
  let index = cursor.index
  let offset = cursor.offset
  let bytes = 0
  let nextCursor: string | undefined
  let page: SideChatManifestItem[] = []
  let pageFrom = -1
  while (index < v4.messageCount) {
    if (pageFrom !== Math.floor(index / 32) * 32) {
      pageFrom = Math.floor(index / 32) * 32
      page = await readSideChatManifestItems(root, v4, pageFrom, Math.min(32, v4.messageCount - pageFrom))
    }
    const meta = page[index - pageFrom]
    if (!meta) throw new Error('侧聊快照缺少消息元数据')
    if (offset > meta.bytes) throw new Error('侧聊正文游标已越界')
    const room = SIDE_CHAT_BODY_PAGE_BYTES - bytes
    if (room <= 0) { nextCursor = `${index}:${offset}`; break }
    const body = await readSideChatItemBodyPage(root, v4, meta, offset, room)
    items.push({
      ref: meta.ref, role: meta.role, providerId: meta.providerId as SideChatSnapshotBodyItem['providerId'],
      sourceOrdinal: meta.sourceOrdinal, text: body.text,
      ...(body.hasMore ? { continuation: true } : {})
    })
    bytes += Buffer.byteLength(body.text, 'utf8')
    if (body.hasMore) { nextCursor = `${index}:${body.nextOffset}`; break }
    index += 1
    offset = 0
    if (items.length >= SIDE_CHAT_BODY_PAGE_ITEMS) { nextCursor = index < v4.messageCount ? `${index}:0` : undefined; break }
  }
  return { conversationId: conversation.id, items, ...(nextCursor ? { nextCursor } : {}), byteLimit: SIDE_CHAT_BODY_PAGE_BYTES }
}

async function messageOf(
  root: string,
  v4: SideChatSnapshotDescriptor,
  item: SideChatManifestItem,
  index: number
): Promise<HistoryMessage> {
  if (item.ref.runId !== sideChatSnapshotRunId(v4.id, index)) throw new Error('侧聊快照正文引用不匹配')
  const chunks: string[] = []
  let offset = 0
  for (;;) {
    const page = await readSideChatMessagePage(root, v4, index, offset, SIDE_CHAT_BODY_PAGE_BYTES)
    chunks.push(page.text)
    if (!page.hasMore) break
    if (page.nextOffset <= offset) throw new Error('侧聊快照正文分页没有前进')
    offset = page.nextOffset
  }
  const text = chunks.join('')
  if (hash(text) !== item.ref.contentHash) throw new Error('侧聊快照正文与冻结元数据不一致')
  // Field order matters: the handoff artifact hashes `JSON.stringify(messages)`, and the
  // reader rebuilds each frozen message in this same order.
  return {
    ref: { ...item.ref }, providerId: item.providerId,
    ...(item.nativeSessionId !== undefined ? { nativeSessionId: item.nativeSessionId } : {}),
    ...(item.providerTurnId !== undefined ? { providerTurnId: item.providerTurnId } : {}),
    ordinal: item.sourceOrdinal, role: item.role, status: item.status, delivery: item.delivery, text
  }
}
