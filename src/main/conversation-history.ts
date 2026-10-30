import { createHash } from 'node:crypto'
import { readRecorderContentPage, writeRecorderContent } from '../core/turn-recorder/content-store'
import { isToolContentRef, type ContentRef } from '../shared/tool-content'
import {
  conversationItemKey, sideChatSnapshotIndexOf, type Conversation, type ConversationItemRef, type DispatchedConversationTurn
} from '../shared/conversation'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import type { ProviderHistoricalContext } from './providers/types'
import { handoffBudget, handoffCoverage, selectHistory, type HandoffBudgetInput } from './conversation-handoff-budget'
import { conversationHistoryRoot, type HistoryMessage } from './conversation-history-content'
import { readConversationHistoryMessages } from './conversation-history-source'
import { MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES } from './conversation-history-limits'
import { belongsToSideChatSnapshot, readSideChatSnapshotItem } from './conversation-side-chat-snapshot'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

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

/** One bounded source read supplies selection, the sealed body, and the run's reader snapshot. */
export async function prepareConversationHandoff(
  userData: string,
  conversation: Conversation,
  missingItems: ConversationItemRef[],
  input: HandoffBudgetInput,
  allowOmission: boolean,
  nativeTarget?: NativeHandoffTarget
): Promise<{ selectedItems: ConversationItemRef[]; history?: ContentRef; readerItems: import('./conversation-history-reader').HistoryReaderItem[]; budget: HandoffBudgetInput }> {
  if (!missingItems.length) return { selectedItems: [], readerItems: [], budget: input }
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
  return {
    budget,
    selectedItems: selection.messages.map(message => message.ref),
    history: await sealHistory(userData, conversation, selection.messages, omitted),
    readerItems: selection.omitted.map(({ ref, text, role: _role, ...source }) => ({ ref, text, source }))
  }
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
  omittedItems: ConversationItemRef[] = []
): Promise<ContentRef> {
  const { messages } = await readConversationHistoryMessages(userData, conversation, selectedItems)
  return sealHistory(userData, conversation, messages, omittedItems)
}

async function sealHistory(userData: string, conversation: Conversation, messages: HistoryMessage[], omittedItems: ConversationItemRef[]): Promise<ContentRef> {
  const coverage = handoffCoverage({ conversationId: conversation.id, selected: messages.length, omitted: omittedItems.length })
  const context = contextFor(messages, coverage, omittedItems.length > 0)
  const artifact: HistoryArtifact = {
    version: 2, conversationId: conversation.id, cwd: conversation.cwd, messages,
    // The ledger retains the exact IDs. Hash the ordered set here instead of
    // repeating an unbounded omission manifest in the model's bootstrap input.
    omittedItemsHash: hash(JSON.stringify(omittedItems.map(conversationItemKey))),
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
  if (!turn.importedItems.length && !(turn.historyPolicy === 'retrievable-v1' && turn.omittedItems.length)) {
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
  const expectedCoverage = value.version === 1
    ? value.coverage === undefined ? undefined : legacyCoverage(conversation.id, messages, omittedItemIds)
    : handoffCoverage({ conversationId: conversation.id, selected: messages.length, omitted: omittedItemIds.length })
  const omissionsMatch = value.version === 1
    ? JSON.stringify(value.omittedItemIds ?? []) === JSON.stringify(omittedItemIds)
    : value.omittedItemsHash === hash(JSON.stringify(omittedItemIds))
  if (!omissionsMatch || value.coverage !== expectedCoverage) throw new Error('交接 artifact 遗漏项引用不匹配')
  const context = contextFor(messages, value.coverage, omittedItemIds.length > 0)
  if (value.context?.text !== context.text || value.context.contentHash !== context.contentHash ||
    (value.version === 2 && value.context.requiresReader !== context.requiresReader) ||
    value.prefix !== historicalInputPrefix(context)) {
    throw new Error('交接 artifact 正文或格式不匹配')
  }
  return context
}
