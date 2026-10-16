import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { lstat, realpath, rm } from 'node:fs/promises'
import { writeRecorderContent, readRecorderContentPage } from '../core/turn-recorder/content-store'
import { modelEventBodies } from '../core/turn-recorder/tool-content'
import { isToolContent, isToolContentRef, type ContentRef } from '../shared/tool-content'
import { conversationItemKey, type Conversation, type ConversationItemRef, type DispatchedConversationTurn } from '../shared/conversation'
import type { TraceEvent } from '../shared/trace'
import { appendCoalescedTrace } from './live-trace'
import { historicalInputPrefix } from './providers/historical-input'
import type { ProviderHistoricalContext } from './providers/types'
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

interface HistoryMessage {
  ref: ConversationItemRef
  providerId: string
  ordinal: number
  role: 'user' | 'assistant'
  status: string
  delivery: string
  text: string
}

interface HistoryArtifact {
  version: 1
  conversationId: string
  cwd: string
  messages: HistoryMessage[]
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
  const user = stripAttachmentMetadata(input.userText)
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

function contextFor(messages: HistoryMessage[]): ProviderHistoricalContext {
  // JSON preserves role boundaries and code whitespace; metadata is main-owned, never parsed from prose.
  const text = JSON.stringify({ source: 'scry_archive_captured_text', messages })
  return { text, contentHash: hash(text) }
}

/** Read-only projection shared by preview and sealing; never substitutes excerpts. */
async function readConversationHistoryMessages(
  userData: string,
  conversation: Conversation,
  selectedItems: ConversationItemRef[]
): Promise<HistoryMessage[]> {
  if (!selectedItems.length) throw new Error('空历史不需要交接正文 artifact')
  const runIds = [...new Set(selectedItems.map((item) => item.runId))]
  if (runIds.length > MAX_TURNS) throw new Error('交接源超过 2000 轮读取预算')
  let sourceBytes = 0
  const budget: ReadBudget = { textBytes: 0 }
  const messages: HistoryMessage[] = []
  for (const runId of runIds) {
    const owner = conversation.turns.find((turn) => turn.runId === runId)
    const binding = conversation.bindings.find((candidate) => candidate.id === owner?.bindingId)
    if (!owner?.archive || !binding) throw new Error('交接源缺少明确的 App 归档位置，不能猜测原生 session')
    const selected = selectedItems.filter((item) => item.runId === runId)
    if (selected.some((item) => item.itemId !== 'user' && item.itemId !== 'assistant')) {
      throw new Error('交接仅支持用户和助手可见文字')
    }
    const { turn, bytesRead } = await readTraceArchiveTurnForHistory({
      userDataDir: userData, cwd: conversation.cwd, sessionId: owner.archive.sessionId,
      providerTurnId: owner.archive.providerTurnId, providerId: binding.providerId, runId,
      maxBytes: MAX_SOURCE_BYTES - sourceBytes
    })
    sourceBytes += bytesRead
    if (!turn.done) throw new Error('交接源轮次尚未收敛')
    if (turn.items.some((event) => event.steer)) {
      throw new Error('交接源包含追加用户输入（Steer），尚未支持其顺序投影，不能静默省略')
    }
    for (const ref of selected) {
      let text: string
      if (ref.itemId === 'user') {
        text = stripAttachmentMetadata(turn.userText)
        chargeText(budget, Buffer.byteLength(text, 'utf8'))
      } else text = await assistantText(userData, conversation, turn, budget)
      if (hash(text) !== ref.contentHash) throw new Error('交接源正文与预览 hash 不一致，请重新预览')
      messages.push({ ref: { ...ref }, providerId: binding.providerId, ordinal: owner.ordinal,
        role: ref.itemId === 'user' ? 'user' : 'assistant', status: turn.status ?? 'unavailable',
        delivery: owner.origin === 'imported' ? 'imported' : owner.delivery.status, text })
    }
  }
  if (JSON.stringify(messages.map((message) => conversationItemKey(message.ref))) !== JSON.stringify(selectedItems.map(conversationItemKey))) {
    throw new Error('交接正文顺序与选择不一致')
  }
  return messages
}

export async function readConversationHistoryItem(userData: string, conversation: Conversation, ref: ConversationItemRef): Promise<string> {
  const [message] = await readConversationHistoryMessages(userData, conversation, [ref])
  return message.text
}

/** Main supplies a decoded conversation and an ordered, already-authorized selection. */
export async function prepareConversationHistory(userData: string, conversation: Conversation, selectedItems: ConversationItemRef[]): Promise<ContentRef> {
  const messages = await readConversationHistoryMessages(userData, conversation, selectedItems)
  const context = contextFor(messages)
  const artifact: HistoryArtifact = {
    version: 1, conversationId: conversation.id, cwd: conversation.cwd, messages, context,
    prefix: historicalInputPrefix(context)
  }
  const serialized = JSON.stringify(artifact)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES) throw new Error('交接 artifact 超出存储预算')
  return writeRecorderContent(root(userData, conversation), serialized, 'json')
}

/** Reopens the sealed artifact, not mutable source archives. It never reconstructs a missing body. */
export async function loadConversationHistory(
  userData: string,
  conversation: Conversation,
  turn: DispatchedConversationTurn
): Promise<ProviderHistoricalContext | undefined> {
  if (!turn.importedItems.length) {
    if (turn.history) throw new Error('空交接不应关联正文 artifact')
    return undefined
  }
  if (!isToolContentRef(turn.history) || turn.history.encoding !== 'json' || turn.history.bytes > MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES) {
    throw new Error('交接 intent 缺少有效正文 artifact')
  }
  const page = await readRecorderContentPage(root(userData, conversation), turn.history, { limit: MAX_CONVERSATION_HISTORY_ARTIFACT_BYTES })
  if (page.hasMore) throw new Error('交接 artifact 未完整读取')
  const value = JSON.parse(Buffer.from(page.dataBase64, 'base64').toString('utf8')) as HistoryArtifact
  if (value.version !== 1 || value.conversationId !== conversation.id || value.cwd !== conversation.cwd ||
    !Array.isArray(value.messages) || value.messages.length !== turn.importedItems.length) {
    throw new Error('交接 artifact 身份不匹配')
  }
  const messages: HistoryMessage[] = []
  for (const [index, message] of value.messages.entries()) {
    const ref = turn.importedItems[index]
    const source = conversation.turns.find((candidate) => candidate.runId === ref.runId)
    const binding = conversation.bindings.find((candidate) => candidate.id === source?.bindingId)
    if (!source || source.ordinal >= turn.ordinal || message.ordinal !== source.ordinal || message.providerId !== binding?.providerId ||
      message.role !== ref.itemId || typeof message.text !== 'string' || hash(message.text) !== ref.contentHash ||
      !['completed', 'failed', 'cancelled', 'interrupted', 'unavailable'].includes(message.status) ||
      message.delivery !== (source.origin === 'imported' ? 'imported' : source.delivery.status) ||
      conversationItemKey(message.ref) !== conversationItemKey(ref)) throw new Error('交接 artifact 内容引用不匹配')
    messages.push({ ref: { ...ref }, providerId: binding!.providerId, ordinal: source.ordinal,
      role: message.role, status: message.status, delivery: message.delivery, text: message.text })
  }
  const context = contextFor(messages)
  if (value.context?.text !== context.text || value.context.contentHash !== context.contentHash || value.prefix !== historicalInputPrefix(context)) {
    throw new Error('交接 artifact 正文或格式不匹配')
  }
  return context
}
