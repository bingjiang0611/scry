import { createHash } from 'node:crypto'
import { writeRecorderContent, readRecorderContentPage } from '../core/turn-recorder/content-store'
import { isToolContentRef, type ContentRef } from '../shared/tool-content'
import { conversationItemKey, type Conversation, type ConversationItemRef, type SideChatSnapshot, type SideChatSnapshotItem } from '../shared/conversation'
import type { SideChatSnapshotBodyItem, SideChatSnapshotBodyPage } from '../shared/conversation-api'
import { MAX_SIDE_CHAT_SNAPSHOT_BYTES } from './conversation-schema'
import { conversationHistoryRoot, type HistoryMessage } from './conversation-history-content'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The recorder content pager caps one read at 256 KiB; bodies are read in bounded pages. */
const SNAPSHOT_READ_PAGE_BYTES = 256 * 1024

/**
 * Side chats keep their frozen source prefix under their own content root. This is
 * child-owned evidence: deleting the source conversation must not remove it, and it
 * is never a trace archive or an execution turn of this child.
 */
interface SideChatSnapshotArtifact {
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
export type SideChatSnapshotIdentity = Pick<SideChatSnapshot, 'id' | 'throughOrdinal' | 'throughRunId' | 'prefixFingerprint'>

function origin(conversation: SideChatSnapshotOwner) {
  if (!conversation.sideChat) throw new Error('该对话没有冻结的侧聊快照')
  return conversation.sideChat
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

/**
 * The single byte authority for a sealed snapshot. Preview measures the exact
 * artifact an id of identical length will produce, so the preview budget and the
 * seal can never disagree about the same frozen messages.
 */
export function sideChatSnapshotBytes(
  conversation: Pick<Conversation, 'id' | 'cwd'>,
  snapshot: SideChatSnapshotIdentity,
  messages: readonly HistoryMessage[]
): number {
  return Buffer.byteLength(serialized(conversation, snapshot, messages), 'utf8')
}

function serialized(conversation: Pick<Conversation, 'id' | 'cwd'>, snapshot: SideChatSnapshotIdentity, messages: readonly HistoryMessage[]): string {
  const artifact: SideChatSnapshotArtifact = {
    version: 3,
    kind: 'side-chat-snapshot',
    conversationId: conversation.id,
    cwd: conversation.cwd,
    snapshotId: snapshot.id,
    throughOrdinal: snapshot.throughOrdinal,
    throughRunId: snapshot.throughRunId,
    prefixFingerprint: snapshot.prefixFingerprint,
    messages: messages.map(message => ({ ...message }))
  }
  return JSON.stringify(artifact)
}

/** Seals the complete frozen text before the child record is published. */
export function sealSideChatSnapshot(
  userData: string,
  conversation: Pick<Conversation, 'id' | 'cwd'>,
  snapshot: SideChatSnapshotIdentity,
  items: readonly SideChatSnapshotItem[],
  messages: readonly HistoryMessage[]
): Promise<ContentRef> {
  if (messages.length !== items.length) throw new Error('侧聊快照消息数量与清单不一致')
  for (const [index, item] of items.entries()) assertMessage(item, messages[index])
  const bytes = sideChatSnapshotBytes(conversation, snapshot, messages)
  if (bytes > MAX_SIDE_CHAT_SNAPSHOT_BYTES) throw new Error('侧聊快照正文超出 4 MiB 完整正文预算；请缩小来源范围后重新预览')
  return writeRecorderContent(conversationHistoryRoot(userData, conversation), serialized(conversation, snapshot, messages), 'json')
}

/** Reopens the child-owned body; it never falls back to a source archive. */
export async function loadSideChatSnapshotMessages(
  userData: string,
  conversation: SideChatSnapshotOwner
): Promise<HistoryMessage[]> {
  const frozen = origin(conversation)
  if (!isToolContentRef(frozen.snapshot.content) || frozen.snapshot.content.encoding !== 'json' ||
    frozen.snapshot.content.bytes > MAX_SIDE_CHAT_SNAPSHOT_BYTES) throw new Error('侧聊快照正文引用无效')
  const chunks: Buffer[] = []
  let offset = 0
  do {
    const page = await readRecorderContentPage(conversationHistoryRoot(userData, conversation), frozen.snapshot.content,
      { offset, limit: SNAPSHOT_READ_PAGE_BYTES })
    chunks.push(Buffer.from(page.dataBase64, 'base64'))
    offset = page.nextOffset
    if (!page.hasMore) break
  } while (offset < frozen.snapshot.content.bytes)
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SideChatSnapshotArtifact
  if (value.version !== 3 || value.kind !== 'side-chat-snapshot' || value.conversationId !== conversation.id ||
    value.cwd !== conversation.cwd || value.snapshotId !== frozen.snapshot.id ||
    value.throughOrdinal !== frozen.snapshot.throughOrdinal || value.throughRunId !== frozen.snapshot.throughRunId ||
    value.prefixFingerprint !== frozen.snapshot.prefixFingerprint || !Array.isArray(value.messages) ||
    value.messages.length !== frozen.snapshot.items.length) throw new Error('侧聊快照正文身份不匹配')
  const messages: HistoryMessage[] = []
  for (const [index, item] of frozen.snapshot.items.entries()) {
    const message = value.messages[index]
    assertMessage(item, message)
    messages.push({ ...message, ref: { ...message.ref } })
  }
  return messages
}

/** Bounded read of one frozen message, used by readItem. */
export async function readSideChatSnapshotMessage(
  userData: string,
  conversation: SideChatSnapshotOwner,
  ref: ConversationItemRef
): Promise<HistoryMessage> {
  const index = conversation.sideChat?.snapshot.items.findIndex(item => conversationItemKey(item.ref) === conversationItemKey(ref)) ?? -1
  if (index < 0) throw new Error('正文引用不属于当前侧聊快照')
  const messages = await loadSideChatSnapshotMessages(userData, conversation)
  const message = messages[index]
  if (conversationItemKey(message.ref) !== conversationItemKey(ref)) throw new Error('侧聊快照正文引用不匹配')
  return message
}

/** One viewer page: at most 40 messages and 256 KiB of real UTF-8 body per read. */
export const SIDE_CHAT_BODY_PAGE_ITEMS = 40
export const SIDE_CHAT_BODY_PAGE_BYTES = 256 * 1024
const BODY_CURSOR_PATTERN = /^(\d{1,6}):(\d{1,9})$/

/** Cursor is `<message index>:<character offset inside that message>`. */
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
 * The sealed artifact is the only authority and stays at most 4 MiB / 4000 messages,
 * so a page costs exactly one load + verify + parse no matter how many rows it returns.
 * A message larger than the page budget gets an explicit continuation cursor instead
 * of a silently truncated body. If the snapshot ever grows past those bounds or page
 * reads become a measured latency cost, a bounded index beside the artifact is the
 * upgrade path; no index, sidecar or cache is reserved here.
 */
export async function readSideChatSnapshotBodyPage(
  userData: string,
  conversation: SideChatSnapshotOwner,
  cursorInput?: string
): Promise<SideChatSnapshotBodyPage> {
  const frozen = origin(conversation)
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
    const meta = frozen.snapshot.items[index]
    const remaining = messages[index].text.slice(offset)
    let text = remaining
    let continued = false
    if (Buffer.byteLength(remaining, 'utf8') > SIDE_CHAT_BODY_PAGE_BYTES - bytes) {
      const cut = cutAtByteBudget(remaining, SIDE_CHAT_BODY_PAGE_BYTES - bytes)
      if (cut <= 0 && items.length > 0) break
      text = remaining.slice(0, Math.max(cut, 1))
      continued = true
    }
    items.push({ ref: { ...meta.ref }, role: meta.role, providerId: meta.providerId, sourceOrdinal: meta.sourceOrdinal,
      text, ...(continued ? { continuation: true as const } : {}) })
    bytes += Buffer.byteLength(text, 'utf8')
    if (continued) { nextCursor = `${index}:${offset + text.length}`; break }
    index += 1
    offset = 0
    if (items.length >= SIDE_CHAT_BODY_PAGE_ITEMS) {
      if (index < messages.length) nextCursor = `${index}:0`
      break
    }
  }
  return { conversationId: conversation.id, items, byteLimit: SIDE_CHAT_BODY_PAGE_BYTES,
    ...(nextCursor ? { nextCursor } : {}) }
}
