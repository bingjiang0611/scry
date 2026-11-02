import { createHash, randomUUID } from 'node:crypto'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import { openConversationHistoryReader } from './conversation-history-reader'
import { providerAttachmentPrompt } from './attachment-store'
import { conversationItemKey, planConversationContinuation } from '../shared/conversation'
import type {
  Conversation, ConversationContinuation, ConversationDelivery, ConversationTarget
} from '../shared/conversation'
import type { ConversationSendRequest, ConversationSendResult } from '../shared/conversation-api'
import type { ProviderHistoricalContext } from './providers/types'
import type { ConversationServiceDeps, ConversationTerminal } from './conversation-service-deps'
import { handoffBudget } from './conversation-handoff-budget'
import { dispatchPayloadHash, targetRequest } from './conversation-summary'
import { parseSend } from './conversation-request'
import { sideChatPlanRefs } from './conversation-side-chat-snapshot'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => String((error as Error)?.message ?? error)

export interface ConversationSendContext {
  deps: ConversationServiceDeps
  /** Runs the host is actually managing; the UI's live status reads this set. */
  active: Set<string>
}

/** Everything one send needs once the pre-dispatch plan is frozen. */
interface PreparedDispatch {
  begun: Awaited<ReturnType<ConversationServiceDeps['store']['begin']>>
  prepared: Awaited<ReturnType<ConversationServiceDeps['store']['prepareHandoff']>>
  context: ProviderHistoricalContext | undefined
  target: ConversationTarget
  payload: string
}

type DispatchPlan =
  | { kind: 'duplicate'; runId: string; delivery?: ConversationDelivery }
  | ({ kind: 'ready' } & PreparedDispatch)

/**
 * A retry reports the durable outcome of the original attempt. A provably undelivered
 * attempt stays `not_sent`: reporting it as accepted would claim a dispatch that never
 * happened, and reporting it as unknown would withhold evidence the host already has.
 */
function duplicateResult(runId: string, delivery?: ConversationDelivery): ConversationSendResult {
  if (delivery?.status === 'not_sent') return { status: 'not_sent', reason: delivery.reason }
  return { status: 'accepted', runId, disposition: 'duplicate' }
}

/**
 * Freezes the dispatch plan. Every await here runs before the Provider transport is
 * dispatched, so whatever throws is a host-proven `not_sent` refusal rather than an
 * unknown outcome.
 */
async function prepareDispatch(
  deps: ConversationServiceDeps,
  conversation: Conversation,
  request: ConversationSendRequest
): Promise<DispatchPlan> {
  if (conversation.archivedAt) throw new Error('对话已存档，请先恢复')
  if (conversation.revision !== request.expectedRevision) throw new Error('对话已变化，请重新预览')
  if (!deps.supportsHistoricalInput(request.providerId)) throw new Error(`${request.providerId} 尚未提供可验证的历史输入交接`)
  const continuationKey = await deps.resolveContinuationKey({
    providerId: request.providerId,
    cwd: conversation.cwd,
    ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {})
  })
  const target = targetRequest(request, continuationKey)
  if (target.continuationKey !== request.expectedContinuationKey) throw new Error('Provider 接续身份已变化，请重新预览')
  const continuation: ConversationContinuation = planConversationContinuation(conversation, target,
    conversation.sideChat ? await sideChatPlanRefs(deps.store.userData, conversation) : undefined)
  if (continuation.kind === 'blocked') throw new Error(continuation.reason)
  if (continuation.kind === 'fresh' && !request.confirmFresh) throw new Error('创建新的原生上下文需要明确确认')
  if (JSON.stringify(request.selectedItems.map(conversationItemKey)) !== JSON.stringify(continuation.missingItems.map(conversationItemKey))) {
    throw new Error('待交接历史与确认的预览不一致，请重新预览')
  }
  const prepared = await deps.store.prepareHandoff(conversation, continuation.missingItems,
    { userText: request.prompt, attachments: request.attachments ?? [] },
    deps.supportsHistoryReader?.(request.providerId) === true,
    continuation.kind === 'resume' ? { bindingId: continuation.bindingId, model: request.model } : undefined)
  const selectedItems = prepared.selectedItems
  const runId = randomUUID()
  const payload = dispatchPayloadHash({
    prompt: request.prompt, attachments: request.attachments, target, cwd: conversation.cwd,
    resumeSessionId: continuation.kind === 'resume' ? continuation.nativeSessionId : null,
    model: request.model, effort: request.effort,
    permissionMode: request.permissionMode, selectedItems
  })
  const begun = await deps.store.begin(request.conversationId, {
    expectedRevision: request.expectedRevision,
    commandId: request.commandId,
    runId,
    target,
    payloadHash: payload,
    items: [],
    selectedItems,
    firstQuestion: request.prompt,
    preparedHistory: prepared.history
  })
  if (begun.disposition === 'duplicate') {
    return { kind: 'duplicate', runId: begun.turn.runId, delivery: begun.turn.delivery }
  }
  const context = await deps.store.history(request.conversationId, runId)
  return { kind: 'ready', begun, prepared, context, target, payload }
}

/**
 * One managed send: resolve an existing command, freeze the plan, then dispatch.
 *
 * A command id that already has a dispatch returns that attempt instead of a second
 * Provider call. Once the plan is frozen the run is dispatched through the managed
 * runner, and the receipt decides the durable delivery: accepted, not sent, or unknown.
 */
export async function sendConversationMessage(
  { deps, active }: ConversationSendContext,
  input: unknown
): Promise<ConversationSendResult> {
  const request = parseSend(input)
  const prompt = request.prompt
  if (!prompt.trim() && !request.attachments?.length) throw new Error('对话请求不能为空')
  if (/^\s*\//.test(prompt)) throw new Error('统一对话仅支持普通文本，不支持 slash 命令')
  const conversation = await deps.store.read(request.conversationId)
  if (!conversation) throw new Error('找不到对话，不会自动创建空历史')
  if (conversation.deletion) throw new Error('统一对话正在删除或已删除，不能发送')
  // Resolve an existing command from its immutable binding before checking current
  // continuation state. A pending/unknown retry must return its original attempt, not be
  // blocked by the current plan.
  const existing = await deps.store.findDispatch(request.conversationId, request.commandId)
  if (existing) {
    const binding = conversation.bindings.find((candidate) => candidate.id === existing.bindingId)
    if (!binding) throw new Error('重复命令引用了未知原生绑定')
    if (request.providerId !== binding.providerId || request.agentProfileId !== (binding.agentProfileId ?? undefined) ||
      request.expectedContinuationKey !== binding.continuationKey) {
      throw new Error('同一命令 ID 不能替换请求内容或目标')
    }
    const duplicateTarget: ConversationTarget = {
      providerId: binding.providerId,
      ...(binding.agentProfileId ? { agentProfileId: binding.agentProfileId } : {}),
      continuationKey: binding.continuationKey
    }
    const duplicatePayloadHash = dispatchPayloadHash({
      prompt, attachments: request.attachments, target: duplicateTarget, cwd: conversation.cwd,
      resumeSessionId: existing.resumeSessionId,
      model: request.model, effort: request.effort,
      permissionMode: request.permissionMode, selectedItems: existing.importedItems
    })
    const duplicate = await deps.store.begin(request.conversationId, {
      expectedRevision: request.expectedRevision,
      commandId: request.commandId,
      runId: randomUUID(),
      target: duplicateTarget,
      payloadHash: duplicatePayloadHash,
      items: [],
      // A retry reuses the exact immutable selection published by the first attempt.
      selectedItems: existing.importedItems,
      firstQuestion: prompt
    })
    if (duplicate.disposition === 'duplicate') return duplicateResult(duplicate.turn.runId, duplicate.turn.delivery)
    // The durable record contradicts the command lookup: this is command-level
    // uncertainty, not a refusal this request can prove, so it stays unresolved.
    throw new Error('重复命令状态发生变化，请重新预览')
  }
  let plan: DispatchPlan
  try {
    plan = await prepareDispatch(deps, conversation, request)
  } catch (error) {
    // Nothing was dispatched: the host can prove the input was never delivered.
    return { status: 'not_sent', reason: reasonOf(error) }
  }
  if (plan.kind === 'duplicate') return duplicateResult(plan.runId, plan.delivery)
  const { begun, prepared, context, target, payload } = plan
  const runId = begun.turn.runId
  const requestHash = hash(JSON.stringify({
    scope: 'plain-text-local-managed-v1', payloadHash: payload,
    historyHash: context?.contentHash ?? null
  }))
  active.add(runId)
  let dispatched = false
  /** The runner answered, so this request is no longer provably undelivered. */
  let providerStartReturned = false
  let inputTextHash = hash(context ? historicalInputPrefix(context) + prompt : prompt)
  let reader: Awaited<ReturnType<typeof openConversationHistoryReader>> | undefined
  let inputPrepared = false
  const settle = async (terminal: ConversationTerminal): Promise<void> => {
    if (terminal.receipt?.status === 'accepted' && terminal.archive) {
      if (terminal.receipt.contextHash !== (context?.contentHash ?? null)) throw new Error('Provider 回执的历史 hash 不匹配')
      if (terminal.receipt.textHash !== inputTextHash) throw new Error('Provider 回执的输入正文 hash 不匹配')
      if (begun.turn.resumeSessionId && terminal.receipt.nativeSessionId !== begun.turn.resumeSessionId) {
        throw new Error('Provider 回执的原生 session 与冻结目标不一致')
      }
      const delivery: ConversationDelivery = {
        status: 'accepted',
        nativeSessionId: terminal.receipt.nativeSessionId,
        outcome: terminal.status,
        nativeItems: terminal.finalItems
      }
      await deps.store.settle(request.conversationId, runId, delivery, terminal.finalItems, terminal.archive)
      return
    }
    const notSent = terminal.receipt?.status === 'not_sent' || (!terminal.receipt && !dispatched)
    const delivery: ConversationDelivery = notSent
      ? { status: 'not_sent', reason: terminal.receipt?.status === 'not_sent' ? terminal.receipt.reason : '在调用 Provider 前已停止，输入未投递' }
      : { status: 'unknown', reason: terminal.receipt?.status === 'unknown'
        ? terminal.receipt.reason
        : 'Provider 终态缺少可归属的接收回执或权威归档；不会自动重发' }
    await deps.store.settle(request.conversationId, runId, delivery, [], terminal.archive)
  }
  try {
    if (prepared.reader) reader = await openConversationHistoryReader(prepared.reader)
    const started = await deps.startAppRun({
      prompt,
      attachments: request.attachments,
      cwd: conversation.cwd,
      providerId: request.providerId,
      agentProfileId: request.agentProfileId,
      expectedExternalSessionId: begun.turn.resumeSessionId,
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode
    }, { managedConversation: {
      conversationId: request.conversationId,
      runId,
      target,
      resumeSessionId: begun.turn.resumeSessionId,
      ...(context ? { historicalContext: context } : {}),
      historyReader: reader?.connection,
      historyBudget: { contextUsage: prepared.budget.contextUsage, modelContextWindow: prepared.budget.modelContextWindow },
      prepareInput: attachments => {
        const preparedPrompt = providerAttachmentPrompt(request.providerId, prompt, attachments)
        if (context && historicalInputBytes(context.text) > handoffBudget({ ...prepared.budget, userText: preparedPrompt })) {
          throw new Error('最终输入（含附件提示与历史包装）超出交接预算，输入未投递')
        }
        inputTextHash = hash(context ? historicalInputPrefix(context) + preparedPrompt : preparedPrompt)
        inputPrepared = true
        return { prompt: preparedPrompt, inputTextHash }
      },
      requestHash,
      inputTextHash,
      payloadHash: payload,
      onProviderDispatchAttempt: () => {
        if (request.attachments?.length && !inputPrepared) throw new Error('当前附件尚未准备，输入未投递')
        dispatched = true
      },
      onTerminal: async (terminal) => {
        try {
          await settle(terminal)
        } catch (error) {
          // Receipt/archive mismatches are evidence gaps, not a reason to leave the
          // durable attempt pending or make it retryable.
          try {
            await deps.store.settle(request.conversationId, runId, {
              status: 'unknown', reason: `统一对话终态证据不完整：${reasonOf(error)}`
            }, [], terminal.archive)
          } catch (settlementError) {
            console.error('[scry] failed to record unknown managed outcome:', settlementError)
          }
          throw error
        } finally { active.delete(runId); await reader?.close() }
      }
    }})
    providerStartReturned = true
    if (started.runId !== runId) throw new Error('统一对话 runner 返回了不同的 runId')
    return { status: 'accepted', runId: started.runId, disposition: 'created' }
  } catch (error) {
    const reason = reasonOf(error)
    let provenNotSent = false
    try {
      await settle({
        status: 'failed',
        finalItems: [],
        receipt: dispatched ? { contextHash: context?.contentHash ?? null, status: 'unknown', textHash: hash(prompt), reason } :
          { contextHash: context?.contentHash ?? null, status: 'not_sent', reason }
      })
      provenNotSent = !dispatched && !providerStartReturned
    } catch (settlementError) {
      // The durable attempt could not be settled: the outcome stays unknown.
      console.error('[scry] failed to record conversation send outcome:', settlementError)
    } finally {
      active.delete(runId)
      await reader?.close()
    }
    // Only a refusal proven before dispatch becomes a known-not-sent answer. A lost reply, a
    // runner that answered, a settlement failure or an error after the dispatch attempt
    // stays unknown.
    if (provenNotSent) return { status: 'not_sent', reason }
    throw error
  }
}
