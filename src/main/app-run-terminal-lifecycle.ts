import type { AppRunTerminalState } from './app-run-lifecycle-types'
import type { ProviderRunResult } from './providers/types'
import type { PerformanceTrace } from './performance-timing'
import type { RemoteRunCompletion } from './remote/remote-run-binding'
import type { AppRunStartOptions } from './app-run-start'
import type { UserQuestionBroker } from './user-question'
import type { ActiveRun } from '../shared/trace'
import { projectSettledWorkflowTerminal } from './app-run-start'
import type { ProviderEventWriter } from './provider-event-log'
import type { RunRegistry } from './run-registry'
import type { RunControl } from './app-run-lifecycle-types'

export interface AppRunTerminalLifecycleDeps {
  terminalState: AppRunTerminalState
  runtimePromise: Promise<ProviderRunResult>
  firstTextPerf: Pick<PerformanceTrace, 'mark' | 'finish'>
  firstTracePerf: Pick<PerformanceTrace, 'mark' | 'finish'>
  startPerf: Pick<PerformanceTrace, 'mark' | 'finish'>
  runId: string
  isRemoteRun: boolean
  isWorkflowRun: boolean
  managedConversation: unknown
  options: AppRunStartOptions
  runState: ActiveRun
  interrupted: boolean
  userQuestionBroker: UserQuestionBroker
  runs: RunRegistry<ActiveRun, RunControl>
  releaseSessionBaseline: (() => void) | undefined
  resolveSettled: (() => void) | undefined
  eventLog: ProviderEventWriter | undefined
  currentObservedSessionId: () => string | undefined
  win: import('electron').BrowserWindow | null
  flushTraceSend: () => void
  remoteRunIds: Set<string>
  remoteRunLedgerIds: Map<string, string>
  scopedSessionKey: (sessionId: string) => string
  recordingRecoveryHint: string
  requestRemoteStop: () => void
  runStopLifecycle: { settle: (runId: string) => void }
  workflowInteractionBlocked: boolean
  getRemoteCompletion: () => RemoteRunCompletion | undefined
  resolveRemoteCompletion?: (completion: RemoteRunCompletion) => void
  settleSuccessfulAppRun: typeof import('./app-run-terminal-success').settleSuccessfulAppRun
  settleFailedAppRun: typeof import('./app-run-terminal-failure').settleFailedAppRun
}

export function scheduleAppRunTerminal(
  terminalDeps: Parameters<typeof import('./app-run-terminal-success').settleSuccessfulAppRun>[1],
  lifecycle: AppRunTerminalLifecycleDeps
): void {
  const { runtimePromise, firstTracePerf, firstTextPerf, runId, isRemoteRun, isWorkflowRun,
    options, runState, terminalState, interrupted, userQuestionBroker, runs, releaseSessionBaseline,
    resolveSettled, eventLog, currentObservedSessionId, win, flushTraceSend, remoteRunIds, remoteRunLedgerIds,
    scopedSessionKey, recordingRecoveryHint, requestRemoteStop, settleSuccessfulAppRun, settleFailedAppRun } = lifecycle
  const { finalizeTurnDiff, archiveTraceTurn, recordingBlockedSessions, markTerminalAttention, finishRemote,
    settleManagedConversation, resume } = terminalDeps
  const { runStopLifecycle, workflowInteractionBlocked, getRemoteCompletion } = lifecycle
runtimePromise
  .then((r) => settleSuccessfulAppRun(r, terminalDeps), (err) => settleFailedAppRun(err, terminalDeps))
  .catch(async (error) => {
    console.error('[scry] run completion handler failed:', error)
    await finalizeTurnDiff()
    if (terminalState.archiveArgs && !terminalState.archiveCommitted) {
      try {
        await archiveTraceTurn(terminalState.archiveArgs)
        terminalState.archiveCommitted = true
        if (terminalState.archiveArgs.sessionId) {
          recordingBlockedSessions.delete(scopedSessionKey(terminalState.archiveArgs.sessionId))
        }
      } catch (archiveError) {
        if (terminalState.archiveArgs.sessionId) recordingBlockedSessions.set(
          scopedSessionKey(terminalState.archiveArgs.sessionId),
          recordingRecoveryHint
        )
        console.error('[scry] fallback terminal archive failed:', archiveError)
      }
    }
    if (!runState.done) runState.done = true
    flushTraceSend()
    win?.webContents.send('agent:error', {
      runId,
      message: `Scry 处理 Provider 终态失败：${String((error as Error).message)}`,
      category: 'recording',
      hint: '保留 userData 与 workspace/.scry 后重启 Scry 检查归档'
    })
    if (isRemoteRun || isWorkflowRun) terminalState.remoteRecordingFailed = true
    markTerminalAttention(
      terminalState.archiveArgs?.sessionId ?? currentObservedSessionId() ?? resume ?? runId,
      !interrupted
    )
    finishRemote(interrupted ? 'interrupted' : 'failed', String((error as Error).message ?? error))
  })
  .catch((error) => {
    // Terminal enrichment must never strand a remote executor. The first
    // rejection handler normally records the Provider failure; this guard
    // covers failures inside that handler itself (including diff/archive).
    if (isRemoteRun && !getRemoteCompletion()) {
      terminalState.remoteRecordingFailed = true
      finishRemote(interrupted ? 'interrupted' : 'failed', String((error as Error).message ?? error))
    }
  })
  .finally(async () => {
    try {
      await settleManagedConversation(terminalState.status ?? (interrupted ? 'interrupted' : 'failed'))
      options.stopSignal?.removeEventListener('abort', requestRemoteStop)
      runState.providerSettled = true
      firstTracePerf.finish(undefined, interrupted ? 'cancelled' : 'unavailable')
      firstTextPerf.finish(undefined, interrupted ? 'cancelled' : 'unavailable')
      // settle 是唯一的终止证据来源；它同时取消所有未触发的升级定时器。
      runStopLifecycle.settle(runId)
      userQuestionBroker.cancelRun(runId)
      runs.remove(runId)
      releaseSessionBaseline?.()
      resolveSettled?.()
      void eventLog?.close()
      if (isWorkflowRun) {
        const settledStatus = terminalState.status ?? (interrupted ? 'interrupted' : 'failed')
        try {
          await options.onTerminal?.(projectSettledWorkflowTerminal({
            runId,
            status: settledStatus,
            items: runState.items,
            interactionBlocked: workflowInteractionBlocked,
            recordingFailed: terminalState.remoteRecordingFailed,
            ...(terminalState.structuredOutput ? { structuredOutput: terminalState.structuredOutput } : {}),
            ...(currentObservedSessionId() ? { externalSessionId: currentObservedSessionId() } : {}),
            ...(terminalState.archiveCommitted && terminalState.archiveArgs?.sessionId ? { archiveRef: `run:${runId}:session:${terminalState.archiveArgs.sessionId}` } : {})
          }))
        } catch (error) {
          console.error('[scry] workflow terminal callback failed:', runId, error)
        }
      }
    } finally {
      if (isRemoteRun) {
        if (!getRemoteCompletion()) {
          terminalState.remoteRecordingFailed = true
          finishRemote('failed', 'remote_run_terminal_outcome_unknown')
        }
        remoteRunIds.delete(runId)
        remoteRunLedgerIds.delete(runId)
        const completion = getRemoteCompletion()
        if (completion) lifecycle.resolveRemoteCompletion?.(completion)
      }
    }
  })

}
