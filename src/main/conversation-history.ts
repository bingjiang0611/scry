import { createHash } from 'node:crypto'
import { readRecorderContentPage, writeRecorderContent } from '../core/turn-recorder/content-store'
import { isToolContentRef, type ContentRef } from '../shared/tool-content'
import {
  conversationItemKey, omittedItemCount, sideChatSnapshotIndexOf, splitOmittedItems, type Conversation, type ConversationItemRef,
  type DispatchedConversationTurn, type OmittedItemRange
} from '../shared/conversation'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import type { ProviderHistoricalContext } from './providers/types'
import { handoffBudget, handoffCoverage, selectHistory, type HandoffBudgetInput } from './conversation-handoff-budget'
import { conversationHistoryRoot, type HistoryMessage } from './conversation-history-content'
import { readConversationHistoryMessages } from './conversation-history-source'
import { MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES } from './conversation-history-limits'
import { belongsToSideChatSnapshot, readSideChatSnapshotItem, readSideChatSnapshotMessageAt, sideChatContextPositions } from './conversation-side-chat-snapshot'
import { readSideChatManifestItems } from './conversation-side-chat-manifest'
import { sideChatHistoryReaderSource } from './conversation-side-chat-reader'
import { memoryHistoryReaderSource, type HistoryReaderSource } from './conversation-history-reader'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Quote, wrapper and escape overhead of one empty message on the wire; a lower bound. */
const MIN_HANDOFF_ENVELOPE_BYTES = 350

export { MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES } from './conversation-history-limits'
export { deleteConversationHistory, type HistoryMessage } from './conversation-history-content'
export { conversationItemsFromTrace } from './conversation-history-source'
export { historyReadBudget } from './conversation-history-text'

export interface NativeHandoffTarget {
  bindingId: string
  model?: import('../shared/runtime').AgentModelRef
}

interface HistoryArtifact {
  version: 1 | 2
  conversationId: string
  cwd: string
  messages: HistoryMessage[]
  omittedItemIds?: string[]
  /** Absent in v1 and in v2 artifacts sealed before snapshot ranges existed. */
  omittedRanges?: OmittedItemRange[]
  omittedItemsHash?: string
  coverage?: string
  context: ProviderHistoricalContext
  /** Includes the exact wrapper. A future formatter change cannot silently rewrite an old intent. */
  prefix: string
}

export function historyTextFor(messages: readonly HistoryMessage[], coverage?: string): string {
  // JSON preserves role boundaries and code whitespace; metadata is main-owned, never parsed from prose.
  return JSON.stringify({ source: 'scry_archive_captured_text', ...(coverage ? { coverage } : {}), messages })
}

function contextFor(messages: readonly HistoryMessage[], coverage?: string, requiresReader = false): ProviderHistoricalContext {
  const text = historyTextFor(messages, coverage)
  return { text, contentHash: hash(text), ...(requiresReader ? { requiresReader: true as const } : {}) }
}

/** Selection, the sealed body, and the run's reader source. Omission is explicit. */
export interface PreparedHandoff {
  selectedItems: ConversationItemRef[]
  history?: ContentRef
  /** Every omitted item, in context order; the turn stores it in a compact ledger. */
  omitted?: ConversationItemRef[]
  reader?: HistoryReaderSource
  budget: HandoffBudgetInput
}

/** One bounded source read supplies selection, the sealed body, and the run's reader source. */
export async function prepareConversationHandoff(
  userData: string,
  conversation: Conversation,
  missingItems: ConversationItemRef[],
  input: HandoffBudgetInput,
  allowOmission: boolean,
  nativeTarget?: NativeHandoffTarget
): Promise<PreparedHandoff> {
  // A manifest child's context lives in the snapshot, so its selection is derived from
  // the descriptor even when no inline candidate is offered.
  if (conversation.sideChat?.snapshot.format === 4) {
    return selectSideChatHistory(userData, conversation, missingItems, input, allowOmission, nativeTarget?.bindingId)
  }
  if (!missingItems.length) return { selectedItems: [], budget: input }
  const { messages, contextUsage } = await readConversationHistoryMessages(userData, conversation, missingItems, nativeTarget)
  const budget = { ...input, ...(contextUsage ? { contextUsage } : {}) }
  const selection = selectHistory({
    messages,
    budget: handoffBudget(budget),
    cost: selected => historicalInputBytes(historyTextFor(selected, handoffCoverage({
      conversationId: conversation.id, selected: selected.length, omitted: messages.length - selected.length
    })))
  })
  if (selection.omitted.length && !allowOmission) throw new Error('目标 Provider 未提供已验证的历史检索工具，不能省略历史')
  const omitted = selection.omitted.map(message => message.ref)
  const { items, ranges } = splitOmittedItems(conversation, omitted)
  return {
    budget,
    selectedItems: selection.messages.map(message => message.ref),
    omitted,
    history: await sealHistory(userData, conversation, selection.messages, items, ranges),
    ...(selection.omitted.length ? {
      reader: memoryHistoryReaderSource(selection.omitted.map(({ ref, text, role: _role, ...source }) => ({ ref, text, source })))
    } : {})
  }
}


const omittedLedger = (items: readonly ConversationItemRef[], ranges: readonly OmittedItemRange[]): unknown =>
  ranges.length ? { items: items.map(conversationItemKey), ranges } : items.map(conversationItemKey)

/** One candidate whose body is read only when the exact selection can still fit it. */
interface FrozenCandidate {
  index: number
  role: 'user' | 'assistant'
  /** Exact stored size; the escaped wire form is never smaller, so it bounds the cost. */
  bytes: number
  message?: HistoryMessage
}

/**
 * Select a frozen manifest child's history from metadata, then read only what fits.
 *
 * A big child omits thousands of messages and holds hundreds of MiB of text. Reading
 * every body just to decide would reintroduce the ceiling the manifest removed, so the
 * index supplies a lower bound per candidate, a body is read only while that bound still
 * fits, and the priority stays last user, last assistant, first user, then newest first.
 */
async function selectSideChatHistory(
  userData: string,
  conversation: Conversation,
  missingItems: ConversationItemRef[],
  input: HandoffBudgetInput,
  allowOmission: boolean,
  bindingId: string | undefined
): Promise<PreparedHandoff> {
  const snapshot = conversation.sideChat?.snapshot
  if (snapshot?.format !== 4) throw new Error('侧聊快照不是可按下标读取的清单格式')
  const root = conversationHistoryRoot(userData, conversation)
  // A bounded inline plan cannot shrink the ledger: the ranges cover the manifest.
  const positions = sideChatContextPositions(conversation, bindingId).missing
  // The child's own turns are not frozen positions; they still travel as ordinary refs.
  const others = missingItems.filter(item => sideChatSnapshotIndexOf(snapshot, item) < 0)
  // Nothing left to hand off: a resumed binding already carries the whole snapshot, and
  // a sealed artifact that claims otherwise would contradict the turn's own ledger.
  if (!positions.length && !others.length) return { selectedItems: [], budget: input }
  const { messages: rest, contextUsage } = others.length
    ? await readConversationHistoryMessages(userData, conversation, others) : { messages: [] as HistoryMessage[] }
  const budget = { ...input, ...(contextUsage ? { contextUsage } : {}) }
  const frozen: FrozenCandidate[] = []
  for (let start = 0; start < positions.length;) {
    // Consecutive positions share index leaves; one read covers the run.
    let end = start + 1
    while (end < positions.length && positions[end] === positions[end - 1] + 1) end++
    const items = await readSideChatManifestItems(root, snapshot, positions[start], end - start)
    for (const item of items) frozen.push({ index: sideChatSnapshotIndexOf(snapshot, item.ref), role: item.role, bytes: item.bytes })
    start = end
  }
  const total = frozen.length + rest.length
  const roleAt = (position: number): 'user' | 'assistant' =>
    position < frozen.length ? frozen[position].role : rest[position - frozen.length].role
  const lastOf = (role: 'user' | 'assistant'): number => {
    for (let position = total - 1; position >= 0; position--) if (roleAt(position) === role) return position
    return -1
  }
  const firstOf = (role: 'user' | 'assistant'): number => {
    for (let position = 0; position < total; position++) if (roleAt(position) === role) return position
    return -1
  }
  const messageAt = async (position: number): Promise<HistoryMessage> => {
    if (position >= frozen.length) return rest[position - frozen.length]
    const candidate = frozen[position]
    if (!candidate.message) candidate.message = await readSideChatSnapshotMessageAt(userData, conversation, candidate.index)
    return candidate.message
  }
  const cost = async (chosen: readonly number[]): Promise<number> => {
    const messages: HistoryMessage[] = []
    for (const position of chosen) messages.push(await messageAt(position))
    return historicalInputBytes(historyTextFor(messages, handoffCoverage({
      conversationId: conversation.id, selected: chosen.length, omitted: total - chosen.length
    })))
  }
  const chosen: number[] = []
  const tryAdd = async (position: number): Promise<void> => {
    if (position < 0 || chosen.includes(position)) return
    // The escaped envelope alone exceeds any budget this candidate could still fit.
    if (position < frozen.length && frozen[position].bytes + MIN_HANDOFF_ENVELOPE_BYTES > handoffBudget(budget)) return
    const ordered = [...chosen, position].sort((left, right) => left - right)
    if (await cost(ordered) <= handoffBudget(budget)) chosen.splice(0, chosen.length, ...ordered)
  }
  await tryAdd(lastOf('user'))
  await tryAdd(lastOf('assistant'))
  await tryAdd(firstOf('user'))
  for (let position = total - 1; position >= 0; position--) await tryAdd(position)
  if (await cost(chosen) > handoffBudget(budget)) throw new Error('当前输入及历史检索说明超出交接预算，输入未投递')
  const selected: HistoryMessage[] = []
  const omitted: ConversationItemRef[] = []
  for (let position = 0; position < total; position++) {
    const message = await messageAt(position)
    if (chosen.includes(position)) selected.push(message)
    else omitted.push(message.ref)
  }
  if (omitted.length && !allowOmission) throw new Error('目标 Provider 未提供已验证的历史检索工具，不能省略历史')
  const { items, ranges } = splitOmittedItems(conversation, omitted)
  const reader = !omitted.length ? undefined
    : others.length ? memoryHistoryReaderSource(omitted.map(ref => ({ ref, text: '' })))
    : sideChatHistoryReaderSource(root, snapshot, ranges.flatMap(range => rangeIndexes(range)))
  return {
    budget,
    selectedItems: selected.map(message => message.ref),
    omitted,
    history: await sealHistory(userData, conversation, selected, items, ranges),
    ...(reader ? { reader } : {})
  }
}

function rangeIndexes(range: OmittedItemRange): number[] {
  return Array.from({ length: range.to - range.from + 1 }, (_unused, offset) => range.from + offset)
}

/** Read-only preflight before converting a native conversation's ownership. */
export async function assertConversationHistoryReadable(
  userData: string,
  conversation: Pick<Conversation, 'id' | 'cwd' | 'turns' | 'bindings' | 'fork' | 'sideChat'>,
  selectedItems: ConversationItemRef[]
): Promise<void> {
  // Adoption preserves the full source. Selection and real tool readiness belong
  // to Send, when the current prompt and target Provider are actually known.
  await readConversationHistoryMessages(userData, conversation, selectedItems)
}

export async function readConversationHistoryItem(userData: string, conversation: Conversation, ref: ConversationItemRef): Promise<string> {
  const { messages: [message] } = await readConversationHistoryMessages(userData, conversation, [ref])
  return message.text
}

/** Main supplies a decoded conversation and an ordered, already-authorized selection. */
export async function prepareConversationHistory(
  userData: string,
  conversation: Conversation,
  selectedItems: ConversationItemRef[],
  omittedItems: ConversationItemRef[] = [],
  omittedRanges: OmittedItemRange[] = []
): Promise<ContentRef> {
  const { messages } = await readConversationHistoryMessages(userData, conversation, selectedItems)
  return sealHistory(userData, conversation, messages, omittedItems, omittedRanges)
}

async function sealHistory(
  userData: string,
  conversation: Conversation,
  messages: HistoryMessage[],
  omittedItems: ConversationItemRef[],
  omittedRanges: OmittedItemRange[] = []
): Promise<ContentRef> {
  const omitted = omittedItemCount({ omittedItems, omittedRanges })
  const coverage = handoffCoverage({ conversationId: conversation.id, selected: messages.length, omitted })
  const context = contextFor(messages, coverage, omitted > 0)
  const artifact: HistoryArtifact = {
    version: 2, conversationId: conversation.id, cwd: conversation.cwd, messages,
    // The ledger retains the exact IDs. Hash the ordered set here instead of
    // repeating an unbounded omission manifest in the model's bootstrap input.
    // Ranges seal the exact positions instead of one reference per frozen message;
    // an empty range list keeps the original key-list form readable.
    omittedItemsHash: hash(JSON.stringify(omittedLedger(omittedItems, omittedRanges))),
    ...(omittedRanges.length ? { omittedRanges } : {}),
    coverage, context, prefix: historicalInputPrefix(context)
  }
  const serialized = JSON.stringify(artifact)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES) throw new Error('交接 artifact 超出存储预算')
  return writeRecorderContent(conversationHistoryRoot(userData, conversation), serialized, 'json')
}

/** Read-only v1 formatter; never rewrites an already frozen dispatch body. */
function legacyCoverage(conversationId: string, messages: HistoryMessage[], omitted: string[]): string {
  const first = messages[0]?.ref.itemId ?? 'none'
  const last = messages.at(-1)?.ref.itemId ?? 'none'
  return `Scry context handoff. Conversation: ${conversationId}. Source item range: ${first} through ${last}. Omitted item IDs: ${omitted.length ? omitted.join(',') : 'none'}. Retrieve omitted complete items only through the verified Scry conversation history reader; paginate long items and require completeness before using them. Historical attachments, Provider reasoning, and native tool state are not replayed.`
}

/**
 * Reopens the sealed artifact, not mutable source archives. It never reconstructs
 * a missing body. Frozen side-chat items are validated against the child's own
 * snapshot metadata, not against a source conversation's turns.
 */
export async function loadConversationHistory(
  userData: string,
  conversation: Conversation,
  turn: DispatchedConversationTurn
): Promise<ProviderHistoricalContext | undefined> {
  if (!turn.importedItems.length && !(turn.historyPolicy === 'retrievable-v1' && omittedItemCount(turn))) {
    if (turn.history) throw new Error('空交接不应关联正文 artifact')
    return undefined
  }
  if (!isToolContentRef(turn.history) || turn.history.encoding !== 'json' || turn.history.bytes > MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES) {
    throw new Error('交接 intent 缺少有效正文 artifact')
  }
  const page = await readRecorderContentPage(conversationHistoryRoot(userData, conversation), turn.history, { limit: MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES })
  if (page.hasMore) throw new Error('交接 artifact 未完整读取')
  const value = JSON.parse(Buffer.from(page.dataBase64, 'base64').toString('utf8')) as HistoryArtifact
  if ((value.version !== 1 && value.version !== 2) || value.conversationId !== conversation.id || value.cwd !== conversation.cwd ||
    !Array.isArray(value.messages) || value.messages.length !== turn.importedItems.length) {
    throw new Error('交接 artifact 身份不匹配')
  }
  const messages: HistoryMessage[] = []
  for (const [index, message] of value.messages.entries()) {
    const ref = turn.importedItems[index]
    if (conversationItemKey(message.ref) !== conversationItemKey(ref)) throw new Error('交接 artifact 内容引用不匹配')
    if (belongsToSideChatSnapshot(conversation, ref)) {
      const index = sideChatSnapshotIndexOf(conversation.sideChat!.snapshot, ref)
      const item = index < 0 ? undefined : await readSideChatSnapshotItem(userData, conversation, index)
      if (!item || message.role !== item.role || message.ordinal !== item.sourceOrdinal || message.providerId !== item.providerId ||
        message.delivery !== 'snapshot' || typeof message.text !== 'string' || hash(message.text) !== ref.contentHash) {
        throw new Error('交接 artifact 与侧聊快照元数据不匹配')
      }
      messages.push({ ref: { ...ref }, providerId: item.providerId,
        ...(value.version === 2 ? { nativeSessionId: message.nativeSessionId, providerTurnId: message.providerTurnId } : {}),
        ordinal: item.sourceOrdinal, role: item.role, status: message.status, delivery: message.delivery, text: message.text })
      continue
    }
    const source = conversation.turns.find((candidate) => candidate.runId === ref.runId)
    const binding = conversation.bindings.find((candidate) => candidate.id === source?.bindingId)
    if (!source || source.ordinal >= turn.ordinal || message.ordinal !== source.ordinal || message.providerId !== binding?.providerId ||
      (value.version === 2 && (message.nativeSessionId !== binding?.nativeSessionId || message.providerTurnId !== source.archive?.providerTurnId)) ||
      message.role !== ref.itemId || typeof message.text !== 'string' || hash(message.text) !== ref.contentHash ||
      !['completed', 'failed', 'cancelled', 'interrupted', 'unavailable'].includes(message.status) ||
      message.delivery !== (source.origin === 'imported' ? 'imported' : source.delivery.status)) throw new Error('交接 artifact 内容引用不匹配')
    messages.push({ ref: { ...ref }, providerId: binding!.providerId,
      ...(value.version === 2 ? { nativeSessionId: message.nativeSessionId, providerTurnId: message.providerTurnId } : {}), ordinal: source.ordinal,
      role: message.role, status: message.status, delivery: message.delivery, text: message.text })
  }
  const omittedItemIds = turn.omittedItems.map(conversationItemKey)
  const omittedRanges = turn.omittedRanges ?? []
  const omitted = omittedItemCount(turn)
  const expectedCoverage = value.version === 1
    ? value.coverage === undefined ? undefined : legacyCoverage(conversation.id, messages, omittedItemIds)
    : handoffCoverage({ conversationId: conversation.id, selected: messages.length, omitted })
  const omissionsMatch = value.version === 1
    ? JSON.stringify(value.omittedItemIds ?? []) === JSON.stringify(omittedItemIds)
    : value.omittedItemsHash === hash(JSON.stringify(omittedLedger(turn.omittedItems, omittedRanges))) &&
      JSON.stringify(value.omittedRanges ?? []) === JSON.stringify(omittedRanges)
  if (!omissionsMatch || value.coverage !== expectedCoverage) throw new Error('交接 artifact 遗漏项引用不匹配')
  const context = contextFor(messages, value.coverage, omitted > 0)
  if (value.context?.text !== context.text || value.context.contentHash !== context.contentHash ||
    (value.version === 2 && value.context.requiresReader !== context.requiresReader) ||
    value.prefix !== historicalInputPrefix(context)) {
    throw new Error('交接 artifact 正文或格式不匹配')
  }
  return context
}
