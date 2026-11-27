import type { AgentTurnRecord, TurnEvidence } from '../../shared/turn-record.js'
import type { TraceEvent } from '../../shared/trace.js'
import type { RecorderEnablement } from './config.js'
import { RECORDER_VERSION, stableHash } from './store.js'
import { resolveModelIdentity, terminalStatus, type TranscriptRead } from './recorder-contracts.js'
import { continuationRole } from './recorder-segment.js'
import type { resolveTurnEnd } from './recorder-turn-state.js'
import type { RecorderOpenTurnState } from './runtime-state.js'
import { captureRecordMetadata } from './record-capture-metadata.js'

export function turnRecordDraft(args: {
  open: RecorderOpenTurnState
  enablement: Extract<RecorderEnablement, { enabled: true }>
  storedEvents: TraceEvent[]
  evidence: TurnEvidence
  transcript: TranscriptRead
  transcriptEvidence: NonNullable<TurnEvidence['transcript']>
  end: ReturnType<typeof resolveTurnEnd>
  startedAt: string
  completedAt: string
  startedMs: number
  completedMs: number
  recordId: string
  payload: Record<string, unknown>
  fallbackStatus: AgentTurnRecord['status']
  effectiveProviderTurnId?: string
}): Omit<AgentTurnRecord, 'sequence'> {
  const { open, enablement, storedEvents, evidence, transcript, transcriptEvidence, end, startedAt, completedAt } = args
  const { startedMs, completedMs, recordId, payload, fallbackStatus, effectiveProviderTurnId } = args
  const taskEvents = storedEvents.filter((event) => event.stage === 'task_context' && event.kind === 'harness')
  const taskContexts = new Map(taskEvents.map((event) => [stableHash([
    event.runtimeMetadata?.invalid, event.runtimeMetadata?.taskId, event.runtimeMetadata?.taskGeneration
  ]), event.runtimeMetadata]))
  const taskContext = taskContexts.size === 1 ? [...taskContexts.values()][0] : undefined
  const boundTask = taskContext && taskContext.invalid !== true && typeof taskContext.taskId === 'string' &&
    typeof taskContext.taskGeneration === 'string' ? taskContext : undefined
  const modelEvents = storedEvents.filter((event) => event.stage === 'provider_model' && event.kind === 'harness')
  const models = new Set(modelEvents.flatMap((event) => {
    const ids = event.runtimeMetadata?.modelIds
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  }))
  const modelIdentity = resolveModelIdentity(modelEvents, models, evidence.usage.value?.model)
  const model = modelIdentity.model
  const turnRoleEvents = storedEvents.filter((event) => event.stage === 'turn_role' && event.kind === 'harness')
  const turnRoles = new Map(turnRoleEvents.map((event) => [stableHash([
    event.runtimeMetadata?.invalid, event.runtimeMetadata?.role, event.runtimeMetadata?.roleSource,
    event.runtimeMetadata?.roleParentId, event.runtimeMetadata?.reviewedSessionId
  ]), event.runtimeMetadata]))
  const turnRoleMetadata = turnRoles.size === 1 ? [...turnRoles.values()][0] : undefined
  const observedTurnRole = continuationRole(open) ?? (turnRoleMetadata && turnRoleMetadata.invalid !== true &&
    typeof turnRoleMetadata.role === 'string' && typeof turnRoleMetadata.roleSource === 'string'
    ? {
        role: String(turnRoleMetadata.role),
        source: String(turnRoleMetadata.roleSource),
        ...(typeof turnRoleMetadata.roleParentId === 'string' ? { parentId: String(turnRoleMetadata.roleParentId) } : {}),
        ...(typeof turnRoleMetadata.reviewedSessionId === 'string'
          ? { reviewedSessionId: String(turnRoleMetadata.reviewedSessionId) }
          : {})
      }
    : undefined)
  return {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    recordId,
    recorderVersion: RECORDER_VERSION,
    workspace: { id: enablement.config.workspaceId, root: enablement.workspaceRoot },
    provider: {
      id: open.provider,
      ...(model ? { model } : {}),
      ...(modelIdentity.modelTier ? { modelTier: modelIdentity.modelTier } : {}),
      modelStatus: modelIdentity.status,
      ...(modelIdentity.source ? { modelSource: modelIdentity.source } : {}),
      ...(modelIdentity.omissionReason ? { modelOmissionReason: modelIdentity.omissionReason } : {})
    },
    linkedTaskId: boundTask ? String(boundTask.taskId) : null,
    ...(boundTask ? { linkedTaskGeneration: String(boundTask.taskGeneration) } : {}),
    taskLinkStatus: boundTask ? 'bound' : taskEvents.length ? 'conflict' : 'unbound',
    ...captureRecordMetadata(open.capture),
    turnRoleStatus: observedTurnRole ? 'observed' : turnRoleEvents.length ? 'conflict' : 'unobserved',
    ...(observedTurnRole ? { turnRole: observedTurnRole } : {}),
    sessionId: open.sessionId,
    ...(effectiveProviderTurnId ? { providerTurnId: effectiveProviderTurnId } : {}),
    generation: open.generation,
    turnIndex: open.turnIndex,
    startedAt,
    completedAt,
    durationMs: (end.termination.value?.completedAtSource === 'provider_transcript' ? transcript.durationMs : undefined) ?? (
      Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : 0
    ),
    status: transcript.terminalStatus ?? terminalStatus(payload, fallbackStatus),
    termination: end.termination,
    transcript: transcriptEvidence,
    ...evidence
  }
}
