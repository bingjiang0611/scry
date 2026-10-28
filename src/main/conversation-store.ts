import { randomUUID } from 'node:crypto'
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from '../shared/session-title'
import { prepareConversationHistory, prepareConversationHandoff, loadConversationHistory, type NativeHandoffTarget } from './conversation-history'
import type { HandoffBudgetInput } from './conversation-handoff-budget'
import type { ProviderHistoricalContext } from './providers/types'
import { ConversationTaskStore } from './conversation-task-store'
import { isCommandId } from '../shared/runtime'
import {
  conversationIntentHash,
  items,
  hashPattern,
  requireValue,
  subset,
  target,
  text,
  type BeginConversationTurn,
  type BeginConversationTurnResult
} from './conversation-record'
import {
  conversationItemKey,
  conversationCoverage,
  planConversationContinuation,
  sameConversationTarget,
  type Conversation,
  type ConversationDelivery,
  type ConversationItemRef,
  type ConversationTarget,
  type ConversationArchiveRef,
  type DispatchedConversationTurn
} from '../shared/conversation'

export { assertConversationItems, decodeConversation, conversationIntentHash } from './conversation-record'
export type {
  BeginConversationTurn,
  BeginConversationTurnResult,
  ConversationIntentInput,
  ConversationSeed,
  NativeSessionScope
} from './conversation-record'

export class ConversationStore extends ConversationTaskStore {
  constructor(userData: string) {
    super(userData)
  }

  async findFork(sourceId: string, commandId: string): Promise<Conversation | undefined> {
    return structuredClone([...(await this.loadOwnership()).values()].find(item =>
      item.fork?.sourceConversationId === sourceId && item.fork.commandId === commandId))
  }

  /** Publish the only fork intent before any native effect; never clone usage or trace rows. */
  async beginFork(sourceId: string, input: { commandId: string; intentHash: string; expectedRevision: number; sourceRunId: string }): Promise<{ conversation: Conversation; created: boolean }> {
    const request = structuredClone(input)
    return this.admission.run('ownership', async () => {
      const existing = await this.findFork(sourceId, request.commandId)
      if (existing) {
        requireValue(existing.fork?.intentHash === request.intentHash, '同一分支命令不能替换内容')
        return { conversation: existing, created: false }
      }
      const source = await this.required(sourceId)
      requireValue(source.revision === request.expectedRevision && !source.deletion && !source.archivedAt, '源对话已变化或不可执行，请重新读取')
      requireValue(!source.fork || source.fork.status === 'accepted', '源分支尚未确认')
      requireValue(!source.turns.some(turn => turn.origin === 'dispatch' && ['pending', 'unknown'].includes(turn.delivery.status)), '源对话投递尚未收敛')
      requireValue(![...(await this.loadOwnership()).values()].some(item => item.fork?.sourceConversationId === sourceId && ['pending', 'unknown'].includes(item.fork.status)), '此源对话已有未确认的原生分支，不能再次创建')
      const index = source.turns.findIndex(turn => turn.runId === request.sourceRunId)
      requireValue(index >= 0, '分支轮次不属于源对话')
      const selected = source.turns[index]
      const binding = source.bindings.find(item => item.id === selected.bindingId)!
      requireValue(binding.nativeSessionId && !binding.retiredReason && !binding.historyOnly && selected.origin === 'dispatch' && selected.delivery.status === 'accepted', '该轮没有可验证的原生分支归属')
      const prefix = source.turns.slice(0, index + 1)
      requireValue(prefix.every(turn => turn.archive), '分支历史缺少已提交归档')
      const bindingId = randomUUID()
      const referenced = new Set(prefix.map(turn => turn.bindingId))
      const titleSuffix = ' · 分支'
      const conversation: Conversation = {
        version: 1, id: randomUUID(), cwd: source.cwd, revision: 0,
        title: normalizeSessionTitle(`${(source.title ?? '对话').slice(0, SESSION_TITLE_MAX_LENGTH - titleSuffix.length)}${titleSuffix}`),
        bindings: [...source.bindings.filter(item => referenced.has(item.id)).map(item => ({
          id: item.id, providerId: item.providerId, agentProfileId: item.agentProfileId, continuationKey: item.continuationKey,
          historyOnly: true as const, retiredReason: '共享历史只读，不继承源原生会话的执行权'
        })), { id: bindingId, providerId: binding.providerId, agentProfileId: binding.agentProfileId, continuationKey: binding.continuationKey }],
        turns: prefix.map(turn => ({ origin: 'imported' as const, ordinal: turn.ordinal, runId: turn.runId,
          bindingId: turn.bindingId, items: turn.items, nativeItems: [], archive: turn.archive })),
        fork: { commandId: request.commandId, intentHash: request.intentHash, sourceConversationId: sourceId,
          sourceRevision: source.revision, sourceRunId: selected.runId, sourceBindingId: binding.id, bindingId,
          status: 'pending', inheritedItems: conversationCoverage({ ...source, turns: prefix }, binding.id) }
      }
      await this.persist(this.checked(conversation), true)
      return { conversation: structuredClone(conversation), created: true }
    })
  }

  async finishFork(id: string, result: { status: 'accepted'; nativeSessionId: string } | { status: 'not_sent' | 'unknown'; reason: string }): Promise<Conversation> {
    const receipt = structuredClone(result)
    return this.admission.run('ownership', async () => {
      const conversation = await this.required(id)
      requireValue(conversation.fork?.status === 'pending' && !conversation.deletion, '分支意图已变化')
      const binding = conversation.bindings.find(item => item.id === conversation.fork!.bindingId)!
      if (receipt.status === 'accepted') binding.nativeSessionId = receipt.nativeSessionId
      conversation.fork.status = receipt.status
      if (receipt.status !== 'accepted') conversation.fork.reason = receipt.reason
      conversation.revision += 1
      await this.persist(this.checked(conversation))
      return structuredClone(conversation)
    })
  }

  async findDispatch(id: string, commandId: string): Promise<DispatchedConversationTurn | undefined> {
    const conversation = await this.required(id)
    const turn = conversation.turns.find((candidate) => candidate.origin === 'dispatch' && candidate.commandId === commandId)
    return turn?.origin === 'dispatch' ? structuredClone(turn) : undefined
  }

  async assertManagedWriteAllowed(input: {
    conversationId: string
    cwd: string
    target: ConversationTarget
    nativeSessionId?: string
    runId?: string
  }): Promise<void> {
    await this.admission.run('ownership', async () => {
      if (this.recoveryFailure) throw this.recoveryFailure
      const conversation = await this.required(input.conversationId)
      requireValue(!conversation.deletion, '统一对话正在删除或已删除，不能执行')
      requireValue(conversation.cwd === input.cwd, '统一对话工作区不一致')
      requireValue(!conversation.fork || conversation.fork.status === 'accepted', '原生分支尚未确认，不能执行')
      const binding = conversation.bindings.find((candidate) =>
        sameConversationTarget(candidate, input.target) &&
        (input.nativeSessionId === undefined || candidate.nativeSessionId === input.nativeSessionId))
      requireValue(binding !== undefined, '统一对话原生绑定不匹配')
      const blocked = conversation.turns.find((turn) => turn.origin === 'dispatch' && turn.runId !== input.runId &&
        (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown'))
      requireValue(blocked === undefined, '统一对话存在未收敛投递')
    })
  }

  async history(id: string, runId: string): Promise<ProviderHistoricalContext | undefined> {
    const conversation = await this.required(id)
    const turn = conversation.turns.find((candidate) => candidate.runId === runId)
    requireValue(turn?.origin === 'dispatch', '找不到该投递尝试')
    return loadConversationHistory(this.userData, conversation, turn)
  }

  prepareHandoff(conversation: Conversation, missing: ConversationItemRef[], budget: HandoffBudgetInput, allowOmission: boolean, nativeTarget?: NativeHandoffTarget) {
    return prepareConversationHandoff(this.userData, conversation, missing, budget, allowOmission, nativeTarget)
  }

  async begin(id: string, input: BeginConversationTurn): Promise<BeginConversationTurnResult> {
    // Freeze caller-owned objects before waiting in the queue.
    const request = structuredClone(input)
    return this.admission.run('ownership', async () => {
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
      const conversation = await this.required(id)
      requireValue(!conversation.deletion, '统一对话正在删除或已删除，不能执行')
      const existing = conversation.turns.find((turn) => turn.origin === 'dispatch' && turn.commandId === request.commandId)
      if (existing?.origin === 'dispatch') {
        requireValue(existing.intentHash === intentHash, '同一命令 ID 不能替换请求内容或目标')
        await loadConversationHistory(this.userData, conversation, existing)
        return { disposition: 'duplicate', conversation, turn: existing }
      }
      requireValue(!conversation.archivedAt, '对话已存档，请先恢复')
      requireValue(conversation.revision === request.expectedRevision, '对话已变化，请重新预览')
      const plan = planConversationContinuation(conversation, request.target)
      if (plan.kind === 'blocked') throw new Error(plan.reason)
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
      const omittedItems = plan.missingItems.filter((item) => !selected.has(conversationItemKey(item)))
      const history = request.preparedHistory ?? (importedItems.length || omittedItems.length
        ? await prepareConversationHistory(this.userData, conversation, importedItems, omittedItems)
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
        omittedItems,
        delivery: { status: 'pending' }
      }
      conversation.turns.push(turn)
      conversation.revision++
      const checked = this.checked(conversation)
      await loadConversationHistory(this.userData, checked, turn)
      await this.persist(checked)
      return { disposition: 'created', conversation: checked, turn: structuredClone(turn) }
    })
  }

  async settle(
    id: string,
    runId: string,
    result: Exclude<ConversationDelivery, { status: 'pending' }>,
    finalItems: ConversationItemRef[],
    archive?: ConversationArchiveRef
  ): Promise<Conversation> {
    const delivery = structuredClone(result)
    const final = structuredClone(finalItems)
    const archiveRef = archive ? structuredClone(archive) : undefined
    return this.admission.run('ownership', async () => {
      const conversation = await this.required(id)
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
        await loadConversationHistory(this.userData, conversation, turn)
        const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)!
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
      const checked = this.checked(conversation)
      await this.persist(checked)
      return checked
    })
  }

  /** Main must first verify native ownership and obtain the user's explicit replacement choice. */
  async retireBinding(id: string, expectedRevision: number, bindingId: string, reason: string): Promise<Conversation> {
    return this.admission.run('ownership', async () => {
      requireValue(text(reason), '弃用原生绑定必须说明原因')
      const conversation = await this.required(id)
      requireValue(conversation.revision === expectedRevision, '对话已变化，请重新预览')
      const binding = conversation.bindings.find((candidate) => candidate.id === bindingId)
      requireValue(binding?.nativeSessionId !== undefined, '找不到可弃用的原生绑定')
      const plan = planConversationContinuation(conversation, binding)
      if (plan.kind === 'blocked') throw new Error(plan.reason)
      requireValue(binding.retiredReason === undefined, '该原生绑定已经弃用')
      binding.retiredReason = reason
      conversation.revision++
      const checked = this.checked(conversation)
      await this.persist(checked)
      return checked
    })
  }

  /** Startup barrier only: new begin/Provider registration must wait until recovery completes. */
  async recover(id: string, liveRunIds: ReadonlySet<string>): Promise<Conversation> {
    const live = new Set(liveRunIds)
    return this.admission.run('ownership', async () => {
      const conversation = await this.required(id)
      let changed = false
      if (conversation.fork?.status === 'pending') {
        conversation.fork.status = 'unknown'
        conversation.fork.reason = '宿主重启后缺少原生分支回执；不会自动重建分支'
        changed = true
      }
      for (const turn of conversation.turns) {
        if (turn.origin !== 'dispatch' || turn.delivery.status !== 'pending' || live.has(turn.runId)) continue
        turn.delivery = { status: 'unknown', reason: '未找到活动 owner，且缺少原生投递确认；不会自动重发' }
        changed = true
      }
      if (!changed) return conversation
      conversation.revision++
      const checked = this.checked(conversation)
      await this.persist(checked)
      return checked
    })
  }
}
