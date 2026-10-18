import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { lstat, realpath, rm } from 'node:fs/promises'
import { writeRecorderContent, readRecorderContentPage } from '../core/turn-recorder/content-store'
import { modelEventBodies } from '../core/turn-recorder/tool-content'
import { isToolContent, isToolContentRef, type ContentRef } from '../shared/tool-content'
import { conversationCoverage, conversationItemKey, type Conversation, type ConversationItemRef, type DispatchedConversationTurn } from '../shared/conversation'
import type { TraceEvent } from '../shared/trace'
import { appendCoalescedTrace } from './live-trace'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import type { ProviderHistoricalContext } from './providers/types'
import { contextUsageEvidence } from '../shared/trace'
import { handoffBudget, handoffCoverage, selectHistory, type HandoffBudgetInput } from './conversation-handoff-budget'
import { stripAttachmentMetadata } from './session-history'
import { readTraceArchiveTurnForHistory, type TraceArchiveTurn } from './transcript-archive'
import { APP_TRACE_CONTENT_SOURCE, readAppTraceContentPage } from './trace-tool-content'

export const MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES = 256 * 1024
const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const MAX_TURNS = 2000
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function root(userData: string, conversation: Pick<Conversation, 'id' | 'cwd'>): string {
  return join(userData, 'conversation-history-v1', hash(JSON.stringify([conversation.id, conversation.cwd])))
}

/** Only this conversation's frozen handoff bodies; never workspace .scry content. */
export async function deleteConversationHistory(userData: string, conversation: Pick<Conversation, 'id' | 'cwd'>): Promise<void> {
  const directory = root(userData, conversation)
  let parent = await realpath(userData)
  for (const path of [dirname(directory), directory]) {
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(path)) !== parent) throw new Error('交接正文目录不是受控普通目录，拒绝删除')
      parent = await realpath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  await rm(directory, { recursive: true, force: true })
}

export interface HistoryMessage {
  ref: ConversationItemRef
  providerId: string
  nativeSessionId?: string
  providerTurnId?: string
  ordinal: number
  role: 'user' | 'assistant'
  status: string
  delivery: string
  text: string
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

interface ReadBudget { textBytes: number }
function chargeText(budget: ReadBudget, bytes: number): void {
  budget.textBytes += bytes
  if (budget.textBytes > MAX_TEXT_BYTES) throw new Error('交接源正文超过 4 MiB 读取预算')
}

const visibleText = (event: TraceEvent): boolean => event.kind === 'model' &&
  (event.stage === 'text' || event.stage === 'text_delta') && event.agentId == null && event.parentToolUseId == null

async function fullText(userData: string, cwd: string, event: TraceEvent, budget: ReadBudget): Promise<string> {
  const body = event.modelContent
  if (!body) {
    if (typeof event.text !== 'string') throw new Error('交接源缺少可读取的助手文字')
    chargeText(budget, Buffer.byteLength(event.text, 'utf8'))
    return event.text
  }
  if (!isToolContent(body) || body.encoding !== 'utf8' || body.sourceCompleteness !== 'complete' || body.redaction === 'failed') {
    throw new Error('交接源正文不完整，不能用预览代替全文')
  }
  if (body.contentRef) {
    if (body.source !== APP_TRACE_CONTENT_SOURCE || body.contentRef.encoding !== 'utf8') {
      throw new Error('交接源正文引用不属于已支持的 App 归档存储')
    }
    chargeText(budget, body.contentRef.bytes)
    const chunks: Buffer[] = []
    let offset = 0
    do {
      const page = await readAppTraceContentPage(userData, cwd, { source: 'app-trace', ref: body.contentRef, offset })
      chunks.push(Buffer.from(page.dataBase64, 'base64'))
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (offset < body.contentRef.bytes)
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }
  if (body.storage !== 'complete' || body.content === undefined) throw new Error('交接源只有预览，缺少完整正文引用')
  chargeText(budget, Buffer.byteLength(body.content, 'utf8'))
  return body.content
}

async function assistantText(userData: string, conversation: Pick<Conversation, 'cwd'>, turn: TraceArchiveTurn, budget: ReadBudget): Promise<string> {
  const projected: TraceEvent[] = []
  for (const event of turn.items) {
    if (visibleText(event)) {
      if (event.runId !== turn.runId) throw new Error('交接源助手事件属于其他 run')
      const text = await fullText(userData, conversation.cwd, event, budget)
      const hydrated = { ...event, text, modelContent: undefined }
      if (event.stage === 'text' && event.messageId && event.runtimeMetadata?.replacesStreamedText === true) {
        appendCoalescedTrace(projected, hydrated)
      } else projected.push(hydrated)
    } else projected.push(event)
  }
  const bodies: string[] = []
  // Same delta/final rules as recorder persistence, without writing intermediate body copies.
  for (const group of modelEventBodies(projected)) {
    if (group.body?.kind === 'text' && visibleText(group.events[0])) bodies.push(group.body.text)
  }
  return bodies.join('\n\n')
}

/** Build immutable App-visible refs from the same complete-body extractor used for handoff. */
export async function conversationItemsFromTrace(input: {
  userData: string
  conversation: Pick<Conversation, 'cwd'>
  runId: string
  userText: string
  items: TraceEvent[]
}): Promise<ConversationItemRef[]> {
  const budget: ReadBudget = { textBytes: 0 }
  const user = input.userText
  const refs: ConversationItemRef[] = [{ runId: input.runId, itemId: 'user', contentHash: hash(user) }]
  const assistant = await assistantText(input.userData, input.conversation, {
    ts: Date.now(),
    runId: input.runId,
    userText: input.userText,
    items: input.items,
    done: true,
    status: 'completed'
  }, budget)
  if (assistant.length > 0) refs.push({ runId: input.runId, itemId: 'assistant', contentHash: hash(assistant) })
  return refs
}

function historyTextFor(messages: readonly HistoryMessage[], coverage?: string): string {
  // JSON preserves role boundaries and code whitespace; metadata is main-owned, never parsed from prose.
  return JSON.stringify({ source: 'scry_archive_captured_text', ...(coverage ? { coverage } : {}), messages })
}

function contextFor(messages: readonly HistoryMessage[], coverage?: string, requiresReader = false): ProviderHistoricalContext {
  const text = historyTextFor(messages, coverage)
  return { text, contentHash: hash(text), ...(requiresReader ? { requiresReader: true as const } : {}) }
}

export interface NativeHandoffTarget {
  bindingId: string
  model?: import('../shared/runtime').AgentModelRef
}

/** One bounded cache for source projection and target-native context evidence. */
async function readConversationHistoryMessages(
  userData: string,
  conversation: Pick<Conversation, 'cwd' | 'turns' | 'bindings' | 'fork'>,
  selectedItems: ConversationItemRef[],
  nativeTarget?: NativeHandoffTarget
): Promise<{ messages: HistoryMessage[]; contextUsage?: HandoffBudgetInput['contextUsage'] }> {
  let sourceBytes = 0
  type Source = { turn: TraceArchiveTurn; owner: Conversation['turns'][number]; binding: Conversation['bindings'][number] }
  const sources = new Map<string, Source>()
  const readSource = async (runId: string): Promise<Source> => {
    const cached = sources.get(runId)
    if (cached) return cached
    if (sources.size >= MAX_TURNS) throw new Error('交接源超过 2000 轮读取预算')
    const owner = conversation.turns.find(turn => turn.runId === runId)
    const binding = conversation.bindings.find(candidate => candidate.id === owner?.bindingId)
    if (!owner?.archive || !binding) throw new Error('交接源缺少明确的 App 归档位置，不能猜测原生 session')
    const result = await readTraceArchiveTurnForHistory({
      userDataDir: userData, cwd: conversation.cwd, sessionId: owner.archive.sessionId,
      providerTurnId: owner.archive.providerTurnId, providerId: binding.providerId, runId,
      maxBytes: MAX_SOURCE_BYTES - sourceBytes
    })
    sourceBytes += result.bytesRead
    const source = { turn: result.turn, owner, binding }
    sources.set(runId, source)
    return source
  }
  let contextUsage: HandoffBudgetInput['contextUsage']
  if (nativeTarget) {
    const latest = conversation.turns.findLast(turn => turn.bindingId === nativeTarget.bindingId && turn.archive &&
      (turn.origin === 'imported' || turn.delivery.status === 'accepted'))
    if (latest) {
      const events = (await readSource(latest.runId)).turn.items
      for (let index = events.length - 1; index >= 0; index--) {
        const evidence = contextUsageEvidence(events[index])
        if (!evidence) continue
        // Model changes invalidate both the old token count and old window.
        if (!nativeTarget.model || (nativeTarget.model.id === evidence.model &&
          (!nativeTarget.model.providerId || nativeTarget.model.providerId === evidence.provider))) {
          contextUsage = { usedTokens: evidence.used, maxTokens: evidence.window }
        }
        break
      }
    }
  }
  const nativeKeys = new Set(nativeTarget && !contextUsage
    ? conversationCoverage(conversation, nativeTarget.bindingId).map(conversationItemKey) : [])
  const requestedKeys = new Set(selectedItems.map(conversationItemKey))
  const refs = nativeKeys.size ? conversation.turns.flatMap(turn => turn.items)
    .filter(ref => nativeKeys.has(conversationItemKey(ref)) || requestedKeys.has(conversationItemKey(ref))) : selectedItems
  const runIds = [...new Set(refs.map(item => item.runId))]
  const budget: ReadBudget = { textBytes: 0 }
  const messages: HistoryMessage[] = []
  for (const runId of runIds) {
    const selected = refs.filter(item => item.runId === runId)
    if (selected.some(item => item.itemId !== 'user' && item.itemId !== 'assistant')) throw new Error('交接仅支持用户和助手可见文字')
    const { turn, owner, binding } = await readSource(runId)
    if (!turn.done) throw new Error('交接源轮次尚未收敛')
    if (turn.items.some((event) => event.steer)) {
      throw new Error('交接源包含追加用户输入（Steer），尚未支持其顺序投影，不能静默省略')
    }
    for (const ref of selected) {
      let text = ref.itemId === 'user' ? turn.userText : await assistantText(userData, conversation, turn, budget)
      let contentHash = hash(text)
      if (ref.itemId === 'user' && contentHash !== ref.contentHash) {
        // Old refs explicitly hashed the stripped projection. Honor that hash
        // without treating a literal marker in new App-captured requests as metadata.
        const legacy = stripAttachmentMetadata(text)
        if (legacy !== text) {
          text = legacy
          contentHash = hash(text)
        }
      }
      if (contentHash !== ref.contentHash) throw new Error('交接源正文与预览 hash 不一致，请重新预览')
      if (ref.itemId === 'user') chargeText(budget, Buffer.byteLength(text, 'utf8'))
      messages.push({ ref: { ...ref }, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId,
        providerTurnId: owner.archive?.providerTurnId, ordinal: owner.ordinal,
        role: ref.itemId === 'user' ? 'user' : 'assistant', status: turn.status ?? 'unavailable',
        delivery: owner.origin === 'imported' ? 'imported' : owner.delivery.status, text })
    }
  }
  if (nativeTarget && !contextUsage) {
    // Visible captured text is only an estimate of hidden/native context. The
    // separate instructions/tools reserve remains; this is not tokenizer evidence.
    contextUsage = { usedTokens: Buffer.byteLength(JSON.stringify(messages.filter(message => nativeKeys.has(conversationItemKey(message.ref))))) }
  }
  const requested = messages.filter(message => requestedKeys.has(conversationItemKey(message.ref)))
  if (JSON.stringify(requested.map(message => conversationItemKey(message.ref))) !== JSON.stringify(selectedItems.map(conversationItemKey))) {
    throw new Error('交接正文顺序与选择不一致')
  }
  return { messages: requested, contextUsage }
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
export async function assertConversationHistoryReadable(userData: string, conversation: Pick<Conversation, 'cwd' | 'turns' | 'bindings'>, selectedItems: ConversationItemRef[]): Promise<void> {
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
  return writeRecorderContent(root(userData, conversation), serialized, 'json')
}

/** Read-only v1 formatter; never rewrites an already frozen dispatch body. */
function legacyCoverage(conversationId: string, messages: HistoryMessage[], omitted: string[]): string {
  const first = messages[0]?.ref.itemId ?? 'none'
  const last = messages.at(-1)?.ref.itemId ?? 'none'
  return `Scry context handoff. Conversation: ${conversationId}. Source item range: ${first} through ${last}. Omitted item IDs: ${omitted.length ? omitted.join(',') : 'none'}. Retrieve omitted complete items only through the verified Scry conversation history reader; paginate long items and require completeness before using them. Historical attachments, Provider reasoning, and native tool state are not replayed.`
}

/** Reopens the sealed artifact, not mutable source archives. It never reconstructs a missing body. */
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
  const page = await readRecorderContentPage(root(userData, conversation), turn.history, { limit: MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES })
  if (page.hasMore) throw new Error('交接 artifact 未完整读取')
  const value = JSON.parse(Buffer.from(page.dataBase64, 'base64').toString('utf8')) as HistoryArtifact
  if ((value.version !== 1 && value.version !== 2) || value.conversationId !== conversation.id || value.cwd !== conversation.cwd ||
    !Array.isArray(value.messages) || value.messages.length !== turn.importedItems.length) {
    throw new Error('交接 artifact 身份不匹配')
  }
  const messages: HistoryMessage[] = []
  for (const [index, message] of value.messages.entries()) {
    const ref = turn.importedItems[index]
    const source = conversation.turns.find((candidate) => candidate.runId === ref.runId)
    const binding = conversation.bindings.find((candidate) => candidate.id === source?.bindingId)
    if (!source || source.ordinal >= turn.ordinal || message.ordinal !== source.ordinal || message.providerId !== binding?.providerId ||
      (value.version === 2 && (message.nativeSessionId !== binding?.nativeSessionId || message.providerTurnId !== source.archive?.providerTurnId)) ||
      message.role !== ref.itemId || typeof message.text !== 'string' || hash(message.text) !== ref.contentHash ||
      !['completed', 'failed', 'cancelled', 'interrupted', 'unavailable'].includes(message.status) ||
      message.delivery !== (source.origin === 'imported' ? 'imported' : source.delivery.status) ||
      conversationItemKey(message.ref) !== conversationItemKey(ref)) throw new Error('交接 artifact 内容引用不匹配')
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
