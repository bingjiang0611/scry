import { randomUUID } from 'node:crypto'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import { conversationCoverage, conversationItemKey, planConversationContinuation, sameConversationTarget,
  splitOmittedItems,
  sideChatSnapshotIndexOf, sideChatSnapshotMessageCount,
  SIDE_CHAT_DEFAULT_TITLE,
  type Conversation, type ConversationDelivery, type ConversationItemRef, type ConversationArchiveRef,
  type ConversationTarget, type ConversationTurn, type DispatchedConversationTurn } from '../shared/conversation'
import { captureTitle } from './conversation-side-chat-source'
import { isCommandId } from '../shared/runtime'
import type { ProviderHistoricalContext } from './providers/types'
import { prepareConversationHandoff, prepareConversationHistory, loadConversationHistory } from './conversation-history'
import type { NativeHandoffTarget } from './conversation-history'
import type { HandoffBudgetInput } from './conversation-handoff-budget'
import { conversationIntentHash, hashPattern, items, requireValue, subset, target, type ConversationLedger } from './conversation-store'

export interface BeginConversationTurn {
  expectedRevision: number
  commandId: string
  runId: string
  target: ConversationTarget
  /** Hash of the frozen actual input, attachments and selected run settings. */
  payloadHash: string
  items: ConversationItemRef[]
  selectedItems: ConversationItemRef[]
  /**
   * First user text of this dispatch. A side chat whose title is still unset takes
   * a truncated copy of it in this same transaction; an explicit rename or any
   * earlier first question already owns the title and is never overwritten.
   */
  firstQuestion?: string
  /** Already sealed against the same revision; validated before publishing the intent. */
  preparedHistory?: DispatchedConversationTurn['history']
}

export type BeginConversationTurnResult = {
  disposition: 'created' | 'duplicate'
  conversation: Conversation
  turn: DispatchedConversationTurn
}

/**
 * A side chat must never dispatch its first turn without the frozen snapshot as
 * context: an item can only be absent when the target binding already covers it.
 */
function assertSideChatContextIntact(
  conversation: Conversation,
  bindingId: string | undefined,
  missing: ConversationItemRef[]
): void {
  if (!conversation.sideChat) return
  const snapshot = conversation.sideChat.snapshot
  const coveredRefs = bindingId === undefined ? [] : conversationCoverage(conversation, bindingId)
  if (snapshot.format === 4) {
    // Format 4 has no enumerable item list in the record, so the same invariant is
    // checked by position: every frozen index must be covered or explicitly missing.
    const seen = new Set<number>()
    for (const ref of [...coveredRefs, ...missing]) {
      const index = sideChatSnapshotIndexOf(snapshot, ref)
      if (index >= 0) seen.add(index)
    }
    requireValue(seen.size === sideChatSnapshotMessageCount(snapshot), '侧聊冻结快照上下文缺失，输入未投递')
    return
  }
  const covered = new Set(coveredRefs.map(conversationItemKey))
  const missingKeys = new Set(missing.map(conversationItemKey))
  const lost = snapshot.items
    .filter(item => !covered.has(conversationItemKey(item.ref)) && !missingKeys.has(conversationItemKey(item.ref)))
  requireValue(lost.length === 0, '侧聊冻结快照上下文缺失，输入未投递')
}

export async function beginConversationTurn(
  ledger: ConversationLedger,
  id: string,
  input: BeginConversationTurn
): Promise<BeginConversationTurnResult> {
  // Freeze caller-owned objects before waiting in the queue.
  const request = structuredClone(input)
  return ledger.admission.run('ownership', async () => {
    target(request.target)
    requireValue(typeof request.payloadHash === 'string' && hashPattern.test(request.payloadHash), '输入指纹无效')
    requireValue(isCommandId(request.commandId), '对话命令 ID 无效')
    items(request.items)
    requireValue(request.items.every((item) => item.runId === request.runId), '轮次包含其他 run 的内容')
    items(request.selectedItems)
    const intentHash = conversationIntentHash({
      commandId: request.commandId,
      target: request.target,
      payloadHash: request.payloadHash,
      items: request.items,
      selectedItems: request.selectedItems
    })
    const conversation = await ledger.required(id)
    requireValue(!conversation.deletion, '统一对话正在删除或已删除，不能执行')
    const existing = conversation.turns.find((turn) => turn.origin === 'dispatch' && turn.commandId === request.commandId)
    if (existing?.origin === 'dispatch') {
      requireValue(existing.intentHash === intentHash, '同一命令 ID 不能替换请求内容或目标')
      await loadConversationHistory(ledger.userData, conversation, existing)
      return { disposition: 'duplicate', conversation, turn: existing }
    }
    requireValue(!conversation.archivedAt, '对话已存档，请先恢复')
    requireValue(conversation.revision === request.expectedRevision, '对话已变化，请重新预览')
    const plan = planConversationContinuation(conversation, request.target,
      conversation.sideChat ? await sideChatSnapshotRefs(ledger.userData, conversation) : undefined)
    if (plan.kind === 'blocked') throw new Error(plan.reason)
    assertSideChatContextIntact(conversation, plan.kind === 'resume' ? plan.bindingId : undefined, plan.missingItems)
    const order = new Map(plan.missingItems.map((item, index) => [conversationItemKey(item), index]))
    let previous = -1
    for (const item of request.selectedItems) {
      const position = order.get(conversationItemKey(item))
      requireValue(position !== undefined && position > previous, '交接选择不属于当前缺失历史，或顺序已变化')
      previous = position
    }
    // Publish the exact body first. Failure leaves no dispatch intent and cannot start a Provider.
    const importedItems = request.selectedItems
    const selected = new Set(importedItems.map(conversationItemKey))
    // A frozen snapshot contributes compact ranges instead of one record reference per
    // omitted message, so a large child's conversation record stays small.
    const omitted = splitOmittedItems(conversation,
      plan.missingItems.filter((item) => !selected.has(conversationItemKey(item))))
    const history = request.preparedHistory ?? (importedItems.length || plan.missingItems.length
      ? await prepareConversationHistory(ledger.userData, conversation, importedItems, omitted.items, omitted.ranges)
      : undefined)
    const bindingId = plan.kind === 'resume' ? plan.bindingId : randomUUID()
    if (plan.kind === 'fresh') conversation.bindings.push({ ...request.target, id: bindingId })
    const turn: DispatchedConversationTurn = {
      origin: 'dispatch', ordinal: conversation.turns.length + 1, runId: request.runId, bindingId,
      items: request.items, commandId: request.commandId, intentHash,
      resumeSessionId: plan.kind === 'resume' ? plan.nativeSessionId : null,
      importedItems,
      historyPolicy: 'retrievable-v1',
      ...(history ? { history } : {}),
      omittedItems: omitted.items,
      ...(omitted.ranges.length ? { omittedRanges: omitted.ranges } : {}),
      delivery: { status: 'pending' }
    }
    conversation.turns.push(turn)
    if (conversation.sideChat && conversation.title === undefined && request.firstQuestion?.trim()) {
      conversation.title = captureTitle(request.firstQuestion, SIDE_CHAT_DEFAULT_TITLE)
    }
    conversation.revision++
    const checked = ledger.checked(conversation)
    await loadConversationHistory(ledger.userData, checked, turn)
    await ledger.persist(checked)
    return { disposition: 'created', conversation: checked, turn: structuredClone(turn) }
  })
}

export async function settleConversationTurn(
  ledger: ConversationLedger,
  id: string,
  runId: string,
  result: Exclude<ConversationDelivery, { status: 'pending' }>,
  finalItems: ConversationItemRef[],
  archive?: ConversationArchiveRef
): Promise<Conversation> {
  const delivery = structuredClone(result)
  const final = structuredClone(finalItems)
  const archiveRef = archive ? structuredClone(archive) : undefined
  return ledger.admission.run('ownership', async () => {
    const conversation = await ledger.required(id)
    const turn = conversation.turns.find((candidate) => candidate.runId === runId)
    requireValue(turn?.origin === 'dispatch', '找不到该投递尝试')
    if (JSON.stringify(turn.delivery) === JSON.stringify(delivery) && JSON.stringify(turn.items) === JSON.stringify(final) &&
      (archiveRef === undefined || JSON.stringify(turn.archive) === JSON.stringify(archiveRef))) {
      return conversation
    }
    requireValue(turn.delivery.status === 'pending' || turn.delivery.status === 'unknown', '不能改写已经确认的投递结果')
    items(final)
    requireValue(subset(turn.items, final), '不能改写已冻结的本轮输入引用')
    if (delivery.status === 'accepted') {
      await loadConversationHistory(ledger.userData, conversation, turn)
      const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)!
      const frozenSource = conversation.sideChat?.source
      // A side chat starts its own session; the frozen source is never resumed or forked.
      requireValue(frozenSource?.kind !== 'native-session' || frozenSource.nativeSessionId !== delivery.nativeSessionId,
        'Provider 复用了冻结来源的原生会话身份，不能标记为新建上下文')
      requireValue(binding.nativeSessionId === undefined || binding.nativeSessionId === delivery.nativeSessionId, 'Provider 返回了不同的原生会话；拒绝沿用旧覆盖')
      if (turn.resumeSessionId === null) {
        const reused = conversation.bindings.some((candidate) => candidate.id !== binding.id &&
          sameConversationTarget(candidate, binding) && candidate.nativeSessionId === delivery.nativeSessionId)
        requireValue(!reused, 'Provider 复用了旧原生身份，不能标记为新建上下文')
      }
      binding.nativeSessionId = delivery.nativeSessionId
    }
    turn.items = final
    turn.delivery = delivery
    if (archiveRef) turn.archive = archiveRef
    conversation.revision++
    const checked = ledger.checked(conversation)
    await ledger.persist(checked)
    return checked
  })
}

export async function findConversationDispatch(
  ledger: ConversationLedger,
  id: string,
  commandId: string
): Promise<DispatchedConversationTurn | undefined> {
  const conversation = await ledger.required(id)
  const turn = conversation.turns.find((candidate) => candidate.origin === 'dispatch' && candidate.commandId === commandId)
  return turn?.origin === 'dispatch' ? structuredClone(turn) : undefined
}

export interface PreparedConversationHandoff {
  selectedItems: ConversationItemRef[]
  history?: import('../shared/tool-content').ContentRef
  reader?: import('./conversation-history-reader').HistoryReaderSource
  budget: HandoffBudgetInput
}

/** One bounded source read supplies selection, the sealed body, and the run's reader snapshot. */
export function prepareConversationHandoffTurn(
  ledger: ConversationLedger,
  conversation: Conversation,
  missing: ConversationItemRef[],
  budget: HandoffBudgetInput,
  allowOmission: boolean,
  nativeTarget?: NativeHandoffTarget
): Promise<PreparedConversationHandoff> {
  return prepareConversationHandoff(ledger.userData, conversation, missing, budget, allowOmission, nativeTarget)
}

export function conversationTurnHistory(
  ledger: ConversationLedger,
  id: string,
  runId: string
): Promise<ProviderHistoricalContext | undefined> {
  return ledger.required(id).then((conversation) => {
    const turn = conversation.turns.find((candidate) => candidate.runId === runId)
    requireValue(turn?.origin === 'dispatch', '找不到该投递尝试')
    return loadConversationHistory(ledger.userData, conversation, turn as DispatchedConversationTurn)
  })
}

/** Startup barrier: persisted intents without a live owner are unknown, never silently retried. */
export function recoverConversationTurns(conversation: Conversation, liveRunIds: ReadonlySet<string>): boolean {
  let changed = false
  for (const turn of conversation.turns) {
    if (turn.origin !== 'dispatch' || turn.delivery.status !== 'pending' || liveRunIds.has(turn.runId)) continue
    turn.delivery = { status: 'unknown', reason: '未找到活动 owner，且缺少原生投递确认；不会自动重发' }
    changed = true
  }
  return changed
}

export type { ConversationTurn }
