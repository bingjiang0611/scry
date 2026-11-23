import type { AgentPermissionMode } from '../shared/runtime-types'
import type { Evidence } from '../shared/turn-record-contracts'
import type { DelegatedTaskView } from '../shared/delegation'
import type { OrchestrationToolsAttachment } from '../main/providers/types'
import type { ChildUsageSample } from '../host-runtime/orchestration/delegation-evidence'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { TaskProjectionRow } from '../host-runtime/orchestration/types'

export interface ChildRunDispatchInput {
  task: TaskProjectionRow
  childRunId: string
  childSessionKey: string
  prompt: string
}

export interface ChildRunDispatchOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable'
  finalMessage?: Evidence<string> | null
  reason?: string
}

export interface PrepareRunOrchestrationInput {
  runId: string
  canonicalRunId: string
  providerId: string
  profile?: string
  cwd?: string
  sessionKey?: string
  permissionMode: AgentPermissionMode
  isAgentRun?: boolean
  actor?: string
  principal?: string
  via?: 'local' | 'remote' | 'agent'
}

export interface PreparedRunOrchestration {
  orchestrationTools?: OrchestrationToolsAttachment
  cleanup: () => void
}

export interface DaemonDelegationRuntimeOptions {
  sink: EventSink
  currentTrustFingerprint: (provider: string, cwd: string) => string
  hasLocalSubscriber: () => boolean
  requestRunStop: (runId: string) => boolean
  dispatchChildRun: (input: ChildRunDispatchInput) => Promise<ChildRunDispatchOutcome>
  readArchiveFinalMessage?: (childRunId: string) => Evidence<string> | undefined
  readChildUsage?: (childRunId: string) => ChildUsageSample | undefined
  onTaskChanged?: () => void
  clock?: () => number
  log?: (line: string) => void
}

export function toDelegatedTaskView(row: TaskProjectionRow): DelegatedTaskView {
  return {
    taskId: row.taskId,
    parentSessionKey: row.parentSessionKey,
    parentRunId: row.parentRunId,
    childSessionKey: row.childSessionKey,
    childRunId: row.childRunId,
    provider: row.provider,
    profile: row.profile,
    permissionMode: row.permissionMode,
    permissionModeSource: row.permissionModeSource,
    status: row.status,
    stateVersion: row.stateVersion,
    title: row.title,
    confirmationQuestionId: row.confirmationQuestionId,
    cancelConfirmationQuestionId: row.cancelConfirmationQuestionId,
    summary: row.summary
      ? {
          status: row.summary.status,
          quality: row.summary.quality,
          ...(row.summary.value !== undefined ? { value: row.summary.value } : {}),
          ...(row.summary.omissionReason ? { omissionReason: row.summary.omissionReason } : {})
        }
      : null,
    reason: row.reason
  }
}
