import { createHash, randomUUID } from 'node:crypto'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import { createConversationHistoryReader } from './conversation-history-reader'
import { providerAttachmentPrompt } from './attachment-store'
import type { ConversationTerminal, ConversationServiceDeps } from './conversation-service'
import type {
  Conversation,
  ConversationDelivery,
  ConversationItemRef,
  ConversationTarget
} from '../shared/conversation'
import { conversationItemKey, planConversationContinuation } from '../shared/conversation'
import type { ConversationSendRequest, ConversationTargetRequest } from '../shared/conversation-api'
import { handoffBudget } from './conversation-handoff-budget'
import { taskSubmissionCopy as copy } from '../shared/constants/copy'
import { assertPlainConversationInput, parseConversationSend } from './conversation-request'

type ConversationSendDependencies = Pick<ConversationServiceDeps, 'store' | 'supportsHistoricalInput' | 'supportsHistoryReader' | 'startAppRun'> & {
  resolveTarget: (cwd: string, request: ConversationTargetRequest) => Promise<ConversationTarget>
}

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

function payloadHash(input: {
  prompt: string
  attachments?: ConversationSendRequest['attachments']
  target: ConversationTarget
  cwd: string
  resumeSessionId: string | null
  model: ConversationSendRequest['model']
  effort: ConversationSendRequest['effort']
  permissionMode: ConversationSendRequest['permissionMode']
  selectedItems: ConversationItemRef[]
}): string {
  return hash(JSON.stringify({
    scope: 'plain-text-local-managed-v1',
    prompt: input.prompt,
    ...(input.attachments?.length ? { attachments: input.attachments.map(attachment => ({ ...attachment, dataBase64: hash(attachment.dataBase64) })) } : {}),
    target: input.target,
    cwd: input.cwd,
    resumeSessionId: input.resumeSessionId,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    selectedItems: input.selectedItems
  }))
}

export function assertConversationForSend(conversation: Conversation | null): asserts conversation is Conversation {
  if (!conversation) throw new Error(copy.conversationMissing)
  if (conversation.deletion) throw new Error(copy.conversationDeleting)
}

export function assertConversationSendRevision(conversation: Conversation, request: ConversationSendRequest,
  supportsHistoricalInput: ConversationSendDependencies['supportsHistoricalInput']): void {
  if (conversation.archivedAt) throw new Error(copy.conversationArchived)
  if (conversation.revision !== request.expectedRevision) throw new Error(copy.conversationChanged)
  if (!supportsHistoricalInput(request.providerId)) throw new Error(copy.historicalUnsupported(request.providerId))
}

export function confirmedConversationContinuation(conversation: Conversation, request: ConversationSendRequest, target: ConversationTarget) {
  if (target.continuationKey !== request.expectedContinuationKey) throw new Error(copy.continuationChanged)
  const continuation = planConversationContinuation(conversation, target)
  if (continuation.kind === 'blocked') throw new Error(continuation.reason)
  if (continuation.kind === 'fresh' && !request.confirmFresh) throw new Error(copy.freshConfirmation)
  if (JSON.stringify(request.selectedItems.map(conversationItemKey)) !== JSON.stringify(continuation.missingItems.map(conversationItemKey))) {
    throw new Error(copy.selectionChanged)
  }
  return continuation
}

export async function sendConversation(input: unknown, deps: ConversationSendDependencies, active: Set<string>, beforeProviderDispatch?: (runId: string) => Promise<void>): Promise<{ runId: string; disposition: 'created' | 'duplicate' }> {
  const request = parseConversationSend(input)
  const prompt = request.prompt
  assertPlainConversationInput(request)
  const conversation = await deps.store.read(request.conversationId)
  assertConversationForSend(conversation)
  // Resolve an existing command from its immutable binding before checking
  // current continuation state. A pending/unknown retry must return its
  // original attempt, not be blocked by the current plan.
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
    const duplicatePayloadHash = payloadHash({
      prompt, attachments: request.attachments, target: duplicateTarget, cwd: conversation.cwd,
      resumeSessionId: existing.resumeSessionId,
      model: request.model, effort: request.effort,
      permissionMode: request.permissionMode, selectedItems: existing.importedItems
    })
    const duplicateRunId = randomUUID()
    const duplicate = await deps.store.begin(request.conversationId, {
      expectedRevision: request.expectedRevision,
      commandId: request.commandId,
      runId: duplicateRunId,
      target: duplicateTarget,
      payloadHash: duplicatePayloadHash,
      items: [],
      // A retry reuses the exact immutable selection published by the first attempt.
      selectedItems: existing.importedItems
    })
    if (duplicate.disposition === 'duplicate') return { runId: duplicate.turn.runId, disposition: 'duplicate' }
    throw new Error('重复命令状态发生变化，请重新预览')
  }
  assertConversationSendRevision(conversation, request, deps.supportsHistoricalInput)
  const target = await deps.resolveTarget(conversation.cwd, request)
  const continuation = confirmedConversationContinuation(conversation, request, target)
  const prepared = await deps.store.prepareHandoff(conversation, continuation.missingItems,
    { userText: prompt, attachments: request.attachments ?? [] },
    deps.supportsHistoryReader?.(request.providerId) === true,
    continuation.kind === 'resume' ? { bindingId: continuation.bindingId, model: request.model } : undefined)
  const selectedItems = prepared.selectedItems
  const runId = randomUUID()
  const payload = payloadHash({
    prompt, attachments: request.attachments, target, cwd: conversation.cwd,
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
    preparedHistory: prepared.history
  })
  if (begun.disposition === 'duplicate') return { runId: begun.turn.runId, disposition: 'duplicate' }
  const context = await deps.store.history(request.conversationId, runId)
  const requestHash = hash(JSON.stringify({
    scope: 'plain-text-local-managed-v1', payloadHash: payload,
    historyHash: context?.contentHash ?? null
  }))
  active.add(runId)
  let dispatched = false
  let inputTextHash = hash(context ? historicalInputPrefix(context) + prompt : prompt)
  let reader: Awaited<ReturnType<typeof createConversationHistoryReader>> | undefined
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
    if (prepared.readerItems.length) reader = await createConversationHistoryReader(prepared.readerItems)
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
      beforeProviderDispatch,
      onProviderDispatchAttempt: () => {
        if (request.attachments?.length && !inputPrepared) throw new Error('当前附件尚未准备，输入未投递')
        dispatched = true
      },
      onTerminal: async (terminal) => {
        try {
          await settle(terminal)
        } catch (error) {
          // Receipt/archive mismatches are evidence gaps, not a reason to
          // leave the durable attempt pending or make it retryable.
          try {
            await deps.store.settle(request.conversationId, runId, {
              status: 'unknown', reason: `统一对话终态证据不完整：${String((error as Error).message ?? error)}`
            }, [], terminal.archive)
          } catch (settlementError) {
            console.error('[scry] failed to record unknown managed outcome:', settlementError)
          }
          throw error
        } finally { active.delete(runId); await reader?.close() }
      }
    }})
    if (started.runId !== runId) throw new Error('统一对话 runner 返回了不同的 runId')
    return { runId: started.runId, disposition: 'created' }
  } catch (error) {
    try {
      await settle({
        status: 'failed',
        finalItems: [],
        receipt: dispatched ? { contextHash: context?.contentHash ?? null, status: 'unknown', textHash: hash(prompt), reason: String((error as Error).message ?? error) } :
          { contextHash: context?.contentHash ?? null, status: 'not_sent', reason: String((error as Error).message ?? error) }
      })
    } finally {
      active.delete(runId)
      await reader?.close()
    }
    throw error
  }
}
