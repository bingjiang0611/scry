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
  omittedRanges?: OmittedItemRange[]
  omittedItemsHash?: string
  coverage?: string
  context: ProviderHistoricalContext
  prefix: string
}

export function historyTextFor(messages: readonly HistoryMessage[], coverage?: string): string {
  return JSON.stringify({ source: 'scry_archive_captured_text', ...(coverage ? { coverage } : {}), messages })
}

function contextFor(messages: readonly HistoryMessage[], coverage?: string, requiresReader = false): ProviderHistoricalContext {
  const text = historyTextFor(messages, coverage)
  return { text, contentHash: hash(text), ...(requiresReader ? { requiresReader: true as const } : {}) }
}

export interface PreparedHandoff {
  selectedItems: ConversationItemRef[]
  history?: ContentRef
  omitted?: ConversationItemRef[]
  reader?: HistoryReaderSource
  budget: HandoffBudgetInput
}

export async function prepareConversationHandoff(
  userData: string,
  conversation: Conversation,
  missingItems: ConversationItemRef[],
  input: HandoffBudgetInput,
  allowOmission: boolean,
  nativeTarget?: NativeHandoffTarget
): Promise<PreparedHandoff> {
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

interface FrozenCandidate {
  index: number
  role: 'user' | 'assistant'
  bytes: number
  message?: HistoryMessage
}

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
  const positions = sideChatContextPositions(conversation, bindingId).missing
  const others = missingItems.filter(item => sideChatSnapshotIndexOf(snapshot, item) < 0)
  if (!positions.length && !others.length) return { selectedItems: [], budget: input }
  const { messages: rest, contextUsage } = others.length
    ? await readConversationHistoryMessages(userData, conversation, others) : { messages: [] as HistoryMessage[] }
  const budget = { ...input, ...(contextUsage ? { contextUsage } : {}) }
  const frozen: FrozenCandidate[] = []
  for (let start = 0; start < positions.length;) {
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

export async function assertConversationHistoryReadable(
  userData: string,
  conversation: Pick<Conversation, 'id' | 'cwd' | 'turns' | 'bindings' | 'fork' | 'sideChat'>,
  selectedItems: ConversationItemRef[]
): Promise<void> {
  await readConversationHistoryMessages(userData, conversation, selectedItems)
}

export async function readConversationHistoryItem(userData: string, conversation: Conversation, ref: ConversationItemRef): Promise<string> {
  const { messages: [message] } = await readConversationHistoryMessages(userData, conversation, [ref])
  return message.text
}

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
    omittedItemsHash: hash(JSON.stringify(omittedLedger(omittedItems, omittedRanges))),
    ...(omittedRanges.length ? { omittedRanges } : {}),
    coverage, context, prefix: historicalInputPrefix(context)
  }
  const serialized = JSON.stringify(artifact)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES) throw new Error('交接 artifact 超出存储预算')
  return writeRecorderContent(conversationHistoryRoot(userData, conversation), serialized, 'json')
}

function legacyCoverage(conversationId: string, messages: HistoryMessage[], omitted: string[]): string {
  const first = messages[0]?.ref.itemId ?? 'none'
  const last = messages.at(-1)?.ref.itemId ?? 'none'
  return `Scry context handoff. Conversation: ${conversationId}. Source item range: ${first} through ${last}. Omitted item IDs: ${omitted.length ? omitted.join(',') : 'none'}. Retrieve omitted complete items only through the verified Scry conversation history reader; paginate long items and require completeness before using them. Historical attachments, Provider reasoning, and native tool state are not replayed.`
}

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
