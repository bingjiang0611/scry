import type { AgentPermissionMode } from '../shared/runtime-types'
import type { Evidence } from '../shared/turn-record-contracts'
import type { DelegatedTaskView } from '../shared/delegation'
import type { OrchestrationToolsAttachment } from '../main/providers/types'
import type { ChildUsageSample } from '../host-runtime/orchestration/delegation-evidence'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { TaskProjectionRow } from '../host-runtime/orchestration/types'
import { computeExtendedRepoConfigFingerprint, type AgentRepoBaselineStore } from '../host-runtime/orchestration/agent-repo-baseline'
import type { DelegationCredentialStore } from '../host-runtime/orchestration/delegation-credentials'
import { evaluatePreDispatchRecheck, type PreDispatchRecheckResult } from '../host-runtime/orchestration/orchestrator-commands'

export interface ChildRunDispatchInput {
  task: TaskProjectionRow
  childRunId: string
  childSessionKey: string
  executionCwd: string
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
  prepareChildWorktree?: (input: { sourceCwd: string; taskId: string }) => Promise<{ cwd: string; cleanup?: () => Promise<void> }>
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

export function verifyDelegatedChildPreDispatch(deps: {
  sink: EventSink
  credentials: DelegationCredentialStore
  baselineStore: AgentRepoBaselineStore
  currentTrustFingerprint: (provider: string, cwd: string) => string
  task: TaskProjectionRow
  executionCwd: string
}): PreDispatchRecheckResult {
  const { sink, credentials, baselineStore, currentTrustFingerprint, task, executionCwd } = deps
  let baselineOk: { ok: boolean } = { ok: false }
  try {
    const baseFp = currentTrustFingerprint(task.provider, executionCwd)
    const extFp = computeExtendedRepoConfigFingerprint(task.provider, executionCwd, baseFp, task.cwd)
    baselineOk = baselineStore.verifyAgentRun(task.provider, task.cwd, extFp)
  } catch {
    baselineOk = { ok: false }
  }
  const parentRun = sink.getRun(task.parentRunId)
  const parentTerminal = !parentRun || ['settled', 'failed', 'cancelled', 'interrupted'].includes(parentRun.lifecycle)
  const parentStopRequested = parentRun?.stopState === 'requested'
  const fullAccessViolation =
    task.permissionMode === 'full_access' && !sink.isSessionFullAccessEnabled(task.parentSessionKey)
  return evaluatePreDispatchRecheck({
    actor: task.actor,
    principal: task.principal,
    cwdMatches: true,
    workspaceAuthorized: true,
    grantValid: true,
    operationGateAcquired: true,
    trustGatePassed: true,
    callerRunTerminal: parentTerminal,
    callerRunStopRequested: parentStopRequested,
    agentCredentialRevoked: !credentials.verifyRun(task.parentRunId),
    permissionCeilingViolated: fullAccessViolation,
    projectDelegationDisabled: !sink.isProjectDelegationEnabled(task.cwd),
    repoFingerprintMatchesUserRun: baselineOk.ok
  })
}
