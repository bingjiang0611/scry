import { createHash } from 'node:crypto'
import { conversationCoverage, conversationItemKey, type Conversation, type ConversationItemRef } from '../shared/conversation'
import type { TraceEvent } from '../shared/trace'
import { contextUsageEvidence } from '../shared/trace'
import type { HandoffBudgetInput } from './conversation-handoff-budget'
import { stripAttachmentMetadata } from './session-history'
import { readTraceArchiveTurnForHistory, type TraceArchiveTurn } from './transcript-archive'
import type { HistoryMessage } from './conversation-history-content'
import {
  MAX_CONVERSATION_HISTORY_SOURCE_BYTES,
  MAX_CONVERSATION_HISTORY_TURNS
} from './conversation-history-limits'
import { belongsToSideChatSnapshot, readSideChatSnapshotMessage } from './conversation-side-chat-snapshot'
import type { NativeHandoffTarget } from './conversation-history'
import { chargeText, historyReadBudget, turnAssistantText } from './conversation-history-text'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export type { HistoryMessage } from './conversation-history-content'

/** Build immutable App-visible refs from the same complete-body extractor used for handoff. */
export async function conversationItemsFromTrace(input: {
  userData: string
  conversation: Pick<Conversation, 'cwd'>
  runId: string
  userText: string
  items: TraceEvent[]
}): Promise<ConversationItemRef[]> {
  const budget = historyReadBudget()
  const user = input.userText
  const refs: ConversationItemRef[] = [{ runId: input.runId, itemId: 'user', contentHash: hash(user) }]
  const assistant = await turnAssistantText(input.userData, input.conversation, { runId: input.runId, items: input.items }, budget)
  if (assistant.length > 0) refs.push({ runId: input.runId, itemId: 'assistant', contentHash: hash(assistant) })
  return refs
}

/**
 * One bounded read supplies handoff selection and provenance. A side chat resolves
 * its own frozen refs from its sealed snapshot; every other ref must resolve from a
 * source archive, so a missing body is an error and never empty history.
 */
export async function readConversationHistoryMessages(
  userData: string,
  conversation: Pick<Conversation, 'id' | 'cwd' | 'turns' | 'bindings' | 'fork' | 'sideChat'>,
  selectedItems: ConversationItemRef[],
  nativeTarget?: NativeHandoffTarget
): Promise<{ messages: HistoryMessage[]; contextUsage?: HandoffBudgetInput['contextUsage'] }> {
  let sourceBytes = 0
  type Source = { turn: TraceArchiveTurn; owner: Conversation['turns'][number]; binding: Conversation['bindings'][number] }
  const sources = new Map<string, Source>()
  const readSource = async (runId: string): Promise<Source> => {
    const cached = sources.get(runId)
    if (cached) return cached
    if (sources.size >= MAX_CONVERSATION_HISTORY_TURNS) throw new Error('交接源超过 2000 轮读取预算')
    const owner = conversation.turns.find(turn => turn.runId === runId)
    const binding = conversation.bindings.find(candidate => candidate.id === owner?.bindingId)
    if (!owner?.archive || !binding) throw new Error('交接源缺少明确的 App 归档位置，不能猜测原生 session')
    const result = await readTraceArchiveTurnForHistory({
      userDataDir: userData, cwd: conversation.cwd, sessionId: owner.archive.sessionId,
      providerTurnId: owner.archive.providerTurnId, providerId: binding.providerId, runId,
      maxBytes: MAX_CONVERSATION_HISTORY_SOURCE_BYTES - sourceBytes
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
  const groups = new Map<string, ConversationItemRef[]>()
  for (const ref of refs) {
    const group = groups.get(ref.runId)
    if (group) group.push(ref)
    else groups.set(ref.runId, [ref])
  }
  const budget = historyReadBudget()
  const snapshotMessage = async (ref: ConversationItemRef): Promise<HistoryMessage | undefined> => {
    if (!conversation.sideChat || !belongsToSideChatSnapshot(conversation, ref)) return undefined
    // Per-ref reads touch only the manifest leaves and body parts of this message, so
    // asking for one frozen item never loads the rest of a large child history.
    return readSideChatSnapshotMessage(userData, conversation, ref)
  }
  const messages: HistoryMessage[] = []
  for (const [runId, selected] of groups) {
    if (selected.some(item => item.itemId !== 'user' && item.itemId !== 'assistant')) throw new Error('交接仅支持用户和助手可见文字')
    const frozen = await snapshotMessage(selected[0])
    if (frozen) {
      if (selected.length !== 1 || !selected.every(item => conversationItemKey(item) === conversationItemKey(frozen.ref))) {
        throw new Error('侧聊快照消息被错误合并')
      }
      chargeText(budget, Buffer.byteLength(frozen.text, 'utf8'))
      messages.push({ ...frozen, ref: { ...frozen.ref } })
      continue
    }
    const { turn, owner, binding } = await readSource(runId)
    if (!turn.done) throw new Error('交接源轮次尚未收敛')
    if (turn.items.some((event) => event.steer)) {
      throw new Error('交接源包含追加用户输入（Steer），尚未支持其顺序投影，不能静默省略')
    }
    for (const ref of selected) {
      let text = ref.itemId === 'user' ? turn.userText : await turnAssistantText(userData, conversation, turn, budget)
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
