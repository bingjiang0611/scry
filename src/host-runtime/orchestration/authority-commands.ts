import { randomUUID } from 'node:crypto'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../../main/run-registry'
import { updateRunStartOutbox } from './authority-dispatch'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import { OrchestrationStoreError } from './types'

export function resolveIntentWithSink(options: {
  sink: EventSink
  actor: string
  clock: () => number
  checkLegacySystemReceipt: (commandId: string, actor: string) => { runId: string; seq: number } | undefined
  input: { grantScope: 'local' | 'remote'; commandId: string }
}): { runId: string; state: 'recorded' | 'dispatched' | 'settled' | 'failed' | 'cancelled' } {
  const { sink, actor, clock, checkLegacySystemReceipt, input } = options
  if (sink.isWriteIndeterminate()) {
    throw new OrchestrationStoreError('orchestration_write_indeterminate')
  }
  const mapLifecycle = (lifecycle: string | undefined) =>
    lifecycle === 'interrupted'
      ? ('cancelled' as const)
      : lifecycle === 'admitted'
        ? ('dispatched' as const)
        : ((lifecycle as 'recorded' | 'dispatched' | 'settled' | 'failed' | 'cancelled') ?? 'cancelled')

  const legacy = checkLegacySystemReceipt(input.commandId, actor)
  if (legacy) {
    return { runId: legacy.runId, state: mapLifecycle(sink.getRun(legacy.runId)?.lifecycle) }
  }
  const tombstoneRunId = randomUUID()
  const payload = { targetCommandId: input.commandId, tombstoneRunId }
  const res = sink.execute({
    type: 'run.resolve_intent',
    commandId: `resolve:${input.commandId}`,
    actor,
    scope: input.grantScope,
    at: clock(),
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
  if (res.kind === 'duplicate') {
    const runId = typeof res.receipt.result?.runId === 'string' ? res.receipt.result.runId : tombstoneRunId
    if (res.receipt.status === 'rejected' && res.receipt.reason === 'resolved_absent') {
      return { runId, state: 'cancelled' }
    }
    return { runId, state: mapLifecycle(sink.getRun(runId)?.lifecycle) }
  }
  return { runId: tombstoneRunId, state: 'cancelled' }
}

export function stopRunWithSink<State extends RunRegistryState, Control extends RunRegistryControl>(options: {
  sink: EventSink
  actor: string
  clock: () => number
  input: {
    grantScope: 'local' | 'remote'
    runId: string
    registry?: RunRegistry<State, Control>
    stopControl?: (control: Control) => void
    abortLive?: () => boolean
    reason?: string
  }
}): { status: 'requested' | 'already_requested' | 'not_running' } {
  const { sink, actor, clock, input } = options
  if (sink.isWriteIndeterminate()) {
    const stoppedIds =
      input.registry && input.stopControl
        ? sink.stopRunBypassingFence(input.runId, input.registry, input.stopControl)
        : []
    const liveAborted = input.abortLive?.() ?? false
    return { status: stoppedIds.length > 0 || liveAborted ? 'requested' : 'not_running' }
  }
  const existing = sink.getRun(input.runId)
  if (existing?.stopState === 'requested') return { status: 'already_requested' }
  const payload = { runId: input.runId, ...(input.reason ? { reason: input.reason } : {}) }
  const res = sink.execute({
    type: 'run.stop',
    commandId: `stop:${input.runId}`,
    actor,
    scope: input.grantScope,
    at: clock(),
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
  const stoppedIds =
    input.registry && input.stopControl
      ? sink.stopRunBypassingFence(input.runId, input.registry, input.stopControl)
      : []
  const liveAborted = input.abortLive?.() ?? false
  return { status: res.kind === 'accepted' || stoppedIds.length > 0 || liveAborted ? 'requested' : 'not_running' }
}

export function answerQuestionWithSink(options: {
  sink: EventSink
  actor: string
  clock: () => number
  input: {
    grantScope: 'local' | 'remote'
    runId: string
    questionId: string
    answerId: string
    answerSha256: string
    answerPayload?: Record<string, unknown>
  }
}) {
  const { sink, actor, clock, input } = options
  const payload = {
    runId: input.runId,
    questionId: input.questionId,
    answerId: input.answerId,
    answerSha256: input.answerSha256,
    answeredBy: actor.startsWith('peer:') ? actor : 'unavailable',
    ...(input.answerPayload ? { answerPayload: input.answerPayload } : {})
  }
  return sink.execute({
    type: 'question.answer',
    commandId: `answer:${input.runId}:${input.questionId}:${input.answerId}`,
    actor,
    scope: input.grantScope,
    at: clock(),
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
}

export function recordProgressWithSink(
  sink: EventSink,
  clock: () => number,
  input: {
    runId: string
    step: 'session_bound' | 'question_opened' | 'question_closed' | 'content_gap' | 'provider_settled' | 'finalized'
    commandSuffix: string
    nativeSessionId?: string
    attachNative?: true
    catalogRunId?: string
    questionId?: string
    questionKind?: string
    reason?: string
    outputSeq?: number
    contentRef?: string
    isError?: boolean
    evidence?: string[]
  }
): void {
  if (sink.isWriteIndeterminate()) return
  const payload = {
    runId: input.runId,
    step: input.step,
    ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    ...(input.attachNative ? { attachNative: true as const } : {}),
    ...(input.catalogRunId ? { catalogRunId: input.catalogRunId } : {}),
    ...(input.questionId ? { questionId: input.questionId } : {}),
    ...(input.questionKind ? { questionKind: input.questionKind } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.outputSeq !== undefined ? { outputSeq: input.outputSeq } : {}),
    ...(input.contentRef ? { contentRef: input.contentRef } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {})
  }
  sink.execute({
    type: 'run.effect_result',
    commandId: `effect:p4-${input.runId}:${input.step}:${input.commandSuffix}`,
    actor: `effect:p4-${input.runId}`,
    scope: 'system',
    at: clock(),
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
}

export function recordTerminalWithSink(
  sink: EventSink,
  clock: () => number,
  input: {
    runId: string
    step: 'settled' | 'failed' | 'cancelled' | 'interrupted'
    reason?: string
    detail?: string
    delivery?: 'accepted' | 'not_sent' | 'unknown'
    evidence?: string[]
  }
): void {
  if (sink.isWriteIndeterminate()) return
  const at = clock()
  const outcome =
    input.step === 'interrupted'
      ? {
          status: 'unavailable' as const,
          quality: 'unavailable' as const,
          source: input.evidence ?? ['host.recovery'],
          omissionReason: input.reason ?? 'host_restarted'
        }
      : {
          status: 'available' as const,
          quality: 'exact' as const,
          source: input.evidence ?? ['provider'],
          value: input.step
        }
  const payload = {
    runId: input.runId,
    step: input.step,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    settledAt: input.step === 'interrupted' ? null : at,
    recoveredAt: input.step === 'interrupted' ? at : null,
    outcome,
    ...(input.evidence ? { evidence: input.evidence } : {})
  }
  sink.execute({
    type: 'run.effect_result',
    commandId: `effect:p4-${input.runId}:${input.step}`,
    actor: `effect:p4-${input.runId}`,
    scope: 'system',
    at,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
  updateRunStartOutbox(sink, at, input.runId, input.step === 'failed' ? 'failed' : 'done')
}
