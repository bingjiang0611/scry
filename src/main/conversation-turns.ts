import { randomUUID } from 'node:crypto'
import { sideChatContextPositions, sideChatPlanRefs } from './conversation-side-chat-snapshot'
import { conversationCoverage, conversationItemKey, planConversationContinuation, sameConversationTarget,
  splitOmittedItems, sideChatOmittedRanges,
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
  missing: ConversationItemRef[],
  positions?: { covered: readonly number[]; omitted: readonly number[] }
): void {
  if (!conversation.sideChat) return
  const snapshot = conversation.sideChat.snapshot
  const coveredRefs = bindingId === undefined ? [] : conversationCoverage(conversation, bindingId)
  if (snapshot.format === 4) {
    // Format 4 has no enumerable item list in the record, so the same invariant is
    // checked by position: covered, inline and omitted positions must partition the
    // snapshot exactly once, without a gap or an overlap.
    requireValue(positions !== undefined, '侧聊冻结快照缺少位置校验，输入未投递')
    const seen = new Set<number>()
    // The child's own run items are not frozen positions: only refs this snapshot owns
    // take part in the partition, and every one of them must sit inside the manifest.
    const selected = missing.map(ref => sideChatSnapshotIndexOf(snapshot, ref)).filter(index => index >= 0)
    for (const index of [...positions.covered, ...positions.omitted, ...selected]) {
      requireValue(index < sideChatSnapshotMessageCount(snapshot), '侧聊冻结快照上下文缺失，输入未投递')
      requireValue(!seen.has(index), '侧聊冻结快照上下文重复，输入未投递')
      seen.add(index)
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
      conversation.sideChat ? await sideChatPlanRefs(ledger.userData, conversation) : undefined)
    if (plan.kind === 'blocked') throw new Error(plan.reason)
    const bindingId = plan.kind === 'resume' ? plan.bindingId : undefined
    const snapshot = conversation.sideChat?.snapshot
    // A v4 child's positions come from its manifest, not from an enumerated ref list: the
    // plan only carries the inline window, so covered and omitted positions are derived.
    const positions = snapshot?.format === 4 ? sideChatContextPositions(conversation, bindingId) : undefined
    const selectedPositions = snapshot === undefined ? [] : request.selectedItems
      .map(ref => sideChatSnapshotIndexOf(snapshot, ref)).filter(index => index >= 0)
    const omittedPositions = positions?.missing.filter(index => !selectedPositions.includes(index))
    // For a v4 child the partition is checked by position; the inline selection is the
    // only ref list that may overlap the omitted ranges, and it is the request's own.
    assertSideChatContextIntact(conversation, bindingId,
      snapshot?.format === 4 ? request.selectedItems : plan.missingItems,
      positions === undefined || omittedPositions === undefined ? undefined : { covered: positions.covered, omitted: omittedPositions })
    // A v4 child's selection is ordered by manifest position: the inline set may reach
    // past the plan's candidate window, and the encoded index is its own authority.
    const order = snapshot?.format === 4 ? undefined
      : new Map(plan.missingItems.map((item, index) => [conversationItemKey(item), index]))
    let previous = -1
    for (const item of request.selectedItems) {
      const frozen = order === undefined && snapshot !== undefined ? sideChatSnapshotIndexOf(snapshot, item) : undefined
      // The child's own run items travel beside the snapshot and hold no frozen position.
      if (frozen !== undefined && frozen < 0) continue
      const position = order === undefined ? frozen : order.get(conversationItemKey(item))
      requireValue(position !== undefined && position >= 0 && position > previous,
        '交接选择不属于当前缺失历史，或顺序已变化')
      previous = position
    }
    // Publish the exact body first. Failure leaves no dispatch intent and cannot start a Provider.
    const importedItems = request.selectedItems
    const selected = new Set(importedItems.map(conversationItemKey))
    // A frozen snapshot contributes compact ranges instead of one record reference per
    // omitted message, so a large child's conversation record stays small. A v4 child's
    // ranges cover the whole manifest outside the covered and inline positions.
    const omitted = snapshot?.format === 4 && omittedPositions !== undefined
      ? { items: [] as ConversationItemRef[], ranges: sideChatOmittedRanges(snapshot, omittedPositions) }
      : splitOmittedItems(conversation,
        plan.missingItems.filter((item) => !selected.has(conversationItemKey(item))))
    // A sealed artifact exists exactly when something is handed off: inline items or an
    // omission ledger. A body too large to inline is an omission, so it still seals one.
    const handoff = importedItems.length > 0 || omitted.items.length > 0 || omitted.ranges.length > 0
    const history = request.preparedHistory ?? (handoff
      ? await prepareConversationHistory(ledger.userData, conversation, importedItems, omitted.items, omitted.ranges)
      : undefined)
    const boundId = bindingId ?? randomUUID()
    if (plan.kind === 'fresh') conversation.bindings.push({ ...request.target, id: boundId })
    const turn: DispatchedConversationTurn = {
      origin: 'dispatch', ordinal: conversation.turns.length + 1, runId: request.runId, bindingId: boundId,
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
