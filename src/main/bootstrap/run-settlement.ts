import type { BrowserWindow } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import type { ManagedConversationStart } from '../conversation-service'
import type { ProviderRunHandle } from '../providers/types'
import type { PiRunDiagnostics } from '../providers/pi-run-diagnostics'
import type { PerformanceTrace } from '../performance-timing'
import { conversationItemsFromTrace } from '../conversation-history'
import { archiveTraceTurn, type ArchiveTraceTurnArgs } from './archive'
import { createRemoteRunState } from './run-remote-state'

type SettlementState = { terminalArchiveArgs?: ArchiveTraceTurnArgs; terminalArchiveCommitted: boolean; managedSettlementAttempted: boolean }
export function createManagedConversationSettlement(deps: {
  state: SettlementState
  managedConversation?: ManagedConversationStart
  handle: { current: ProviderRunHandle | null }
  cwd: string | undefined
  runId: string
  displayPrompt: string
  runState: ActiveRun
  userDataDir: string
  getWindow: () => BrowserWindow | null
}) {
  const settleManagedConversation = async (status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): Promise<void> => {
    if (!deps.managedConversation || deps.state.managedSettlementAttempted) return
    deps.state.managedSettlementAttempted = true
    const receipt = deps.handle.current?.getInputReceipt?.()
    try {
      if (deps.state.terminalArchiveCommitted && deps.state.terminalArchiveArgs?.sessionId && deps.cwd) {
        const finalItems = await conversationItemsFromTrace({
          userData: deps.userDataDir,
          conversation: { cwd: deps.cwd },
          runId: deps.runId,
          userText: deps.displayPrompt,
          items: deps.runState.items
        })
        await deps.managedConversation.onTerminal({
          status,
          finalItems,
          archive: {
            sessionId: deps.state.terminalArchiveArgs.sessionId,
            ...(deps.state.terminalArchiveArgs.providerTurnId ? { providerTurnId: deps.state.terminalArchiveArgs.providerTurnId } : {})
          },
          receipt
        })
      } else {
        // A Provider terminal without an authoritative archive is still an
        // attempted delivery. Settle it as unknown; never leave active state
        // or a pending ledger that could be mistaken for a live owner.
        await deps.managedConversation.onTerminal({ status, finalItems: [], receipt })
      }
    } catch (error) {
      // Even archive extraction/receipt validation failures need a durable
      // terminal outcome. Omit archive evidence so the service records unknown.
      try {
        await deps.managedConversation.onTerminal({ status, finalItems: [], receipt })
      } catch (fallbackError) {
        console.error('[scry] managed conversation settlement failed:', deps.runId, error, fallbackError)
        return
      }
    }
    // Fast runs can settle before a view learns their run id. Notify by durable
    // conversation identity, after onTerminal has committed and released active ownership.
    deps.getWindow()?.webContents.send('agent:dataUpdated', {
      kind: 'conversation_changed', conversationId: deps.managedConversation.conversationId
    })
  }
  return settleManagedConversation
}

type SettlementRemote = ReturnType<typeof createRemoteRunState>

/**
 * Everything the local finalization of one settled run still needs. All of it is stable
 * for the run's lifetime, so a single object can be built before the Provider settles.
 */
export type RunSettlementDeps = {
  /** Provider transport settled; recorded before any local finalization work starts. */
  onProviderSettled: () => void
  finalizeTurnDiff: () => Promise<void>
  runState: ActiveRun
  runId: string
  providerId: ProviderId
  isRemoteRun: boolean
  remote: SettlementRemote
  settleManagedConversation: (status: 'completed' | 'failed' | 'cancelled' | 'interrupted') => Promise<void>
  interrupted: () => boolean
  flushTraceSend: () => void
  getWindow: () => BrowserWindow | null
  recordingBlockedSessions: Map<string, string>
  scopedSessionKey: (sessionId: string) => string
  recordingRecoveryHint: string
  getObservedSessionId: () => string | undefined
  resume: string | undefined
  piRunDiagnostics: PiRunDiagnostics
  lifecycle: {
    runStopLifecycle: { settle: (runId: string) => void }
    userQuestionBroker: { cancelRun: (runId: string) => void }
    runTraces: { settle: (runId: string) => void }
    runs: { remove: (runId: string) => void }
    forgetBoundedRun: (runId: string) => void
    releaseSessionBaseline: (() => void) | undefined
    resolveSettled: (() => void) | undefined
    clearDiffPreviewDemand: () => void
    closeEventLog: () => void
  }
  firstTracePerf: PerformanceTrace
  firstTextPerf: PerformanceTrace
  stopSignal: AbortSignal | undefined
  requestRemoteStop: () => void
  remoteRunIds: Set<string>
  remoteRunLedgerIds: Map<string, string>
}

/**
 * The Provider settle is recorded first, before this handler's own local finalization.
 *
 * The completion handler still owns the run: it reads the turn diff, commits the archive
 * and settles managed delivery, so the registry entry must stay and admission must keep
 * blocking this context. What cannot wait for that is stop control — once the transport
 * is settled there is nothing left to interrupt, so the escalation windows are cancelled
 * here instead of firing against an already-ended Provider.
 */
export function attachRunSettlement<T>(
  runtimePromise: Promise<T>,
  onCompleted: (result: T) => Promise<void>,
  onFailed: (error: unknown) => Promise<void>,
  deps: RunSettlementDeps
): void {
  // Recording the settle is the first step of the same handled chain: a throwing
  // `onProviderSettled` becomes a rejected handler instead of an unhandled rejection that
  // would leave this run's finalization unreported.
  runtimePromise
    .then(
      (result) => { deps.onProviderSettled(); return onCompleted(result) },
      (error: unknown) => { deps.onProviderSettled(); return onFailed(error) }
    )
    .catch((error: unknown) => finalizeSettlementFailure(error, deps))
    .catch((error: unknown) => {
      if (deps.isRemoteRun && !deps.remote.state.remoteCompletion) {
        deps.remote.state.remoteRecordingFailed = true
        deps.remote.finishRemote(deps.interrupted() ? 'interrupted' : 'failed', String((error as Error).message ?? error))
      }
    })
    .finally(() => finalizeSettledRun(deps))
}

/**
 * The completion or failure handler itself threw. The turn may still have authoritative
 * archive arguments, so they get one commit attempt; everything else is reported as a
 * recording failure rather than silently leaving the run looking complete.
 */
async function finalizeSettlementFailure(error: unknown, deps: RunSettlementDeps): Promise<void> {
  console.error('[scry] run completion handler failed:', error)
  await deps.finalizeTurnDiff()
  const state = deps.remote.state
  if (state.terminalArchiveArgs && !state.terminalArchiveCommitted) {
    const sessionId = state.terminalArchiveArgs.sessionId
    try {
      await archiveTraceTurn(state.terminalArchiveArgs)
      state.terminalArchiveCommitted = true
      if (sessionId) deps.recordingBlockedSessions.delete(deps.scopedSessionKey(sessionId))
    } catch (archiveError) {
      if (sessionId) deps.recordingBlockedSessions.set(deps.scopedSessionKey(sessionId), deps.recordingRecoveryHint)
      console.error('[scry] fallback terminal archive failed:', archiveError)
    }
  }
  if (!deps.runState.done) deps.runState.done = true
  deps.flushTraceSend()
  deps.getWindow()?.webContents.send('agent:error', {
    runId: deps.runId,
    message: `Scry 处理 Provider 终态失败：${String((error as Error).message)}`,
    category: 'recording',
    hint: '保留 userData 与 workspace/.scry 后重启 Scry 检查归档'
  })
  if (deps.isRemoteRun) state.remoteRecordingFailed = true
  deps.remote.markTerminalAttention(
    state.terminalArchiveArgs?.sessionId ?? deps.getObservedSessionId() ?? deps.resume ?? deps.runId,
    !deps.interrupted()
  )
  deps.remote.finishRemote(deps.interrupted() ? 'interrupted' : 'failed', String((error as Error).message ?? error))
}

/**
 * Local finalization: managed delivery settles, the terminal flush publishes before the
 * registry entry leaves, and only then does the run stop owning its conversation. The
 * registry entry is what makes the terminal diff and resync still readable.
 */
async function finalizeSettledRun(deps: RunSettlementDeps): Promise<void> {
  const { lifecycle, runState } = deps
  const interrupted = deps.interrupted()
  try {
    if (deps.providerId === 'pi') deps.piRunDiagnostics.record(deps.runId, 'main_settlement', { mainDone: runState.done })
    await deps.settleManagedConversation(deps.remote.state.terminalStatus ?? (interrupted ? 'interrupted' : 'failed'))
    deps.stopSignal?.removeEventListener('abort', deps.requestRemoteStop)
    if (!runState.providerSettled) deps.onProviderSettled()
    deps.firstTracePerf.finish(undefined, interrupted ? 'cancelled' : 'unavailable')
    deps.firstTextPerf.finish(undefined, interrupted ? 'cancelled' : 'unavailable')
    lifecycle.runStopLifecycle.settle(deps.runId)
    lifecycle.userQuestionBroker.cancelRun(deps.runId)
    // 收口：先终态 flush + terminal，再离开登记，这样终态 diff 与 resync 仍可读。
    lifecycle.clearDiffPreviewDemand()
    lifecycle.runTraces.settle(deps.runId)
    lifecycle.runs.remove(deps.runId)
    // Finalization is closed: the run owns nothing from here on.
    runState.localFinalizing = false
    lifecycle.forgetBoundedRun(deps.runId)
    lifecycle.releaseSessionBaseline?.()
    lifecycle.resolveSettled?.()
    if (deps.providerId === 'pi') deps.piRunDiagnostics.record(deps.runId, 'main_settled', { mainDone: runState.done, mainSettled: true })
    lifecycle.closeEventLog()
  } catch (error) {
    // A core step threw before the registry entry left, so ownership and
    // `localFinalizing` stay blocking on purpose. Report it here: the failure must not be
    // swallowed by the finally block, and rethrowing would only become an unhandled
    // rejection because this handler runs as a chain terminator.
    console.error('[scry] run local finalization failed:', deps.runId, error)
    if (deps.isRemoteRun) {
      const state = deps.remote.state
      state.remoteRecordingFailed = true
      // A Provider outcome already reported stays authoritative, but its evidence verdict
      // does not: the caller must not receive `committed` for a turn whose local
      // finalization failed, and the failure must not be reported as a Provider failure.
      if (state.remoteCompletion) {
        state.remoteCompletion = {
          ...state.remoteCompletion,
          recording: 'failed',
          error: state.remoteCompletion.error ?? `local_finalization_failed: ${String((error as Error).message ?? error)}`
        }
      }
    }
  } finally {
    if (deps.isRemoteRun) {
      const state = deps.remote.state
      if (!state.remoteCompletion) {
        state.remoteRecordingFailed = true
        deps.remote.finishRemote('failed', 'remote_run_terminal_unknown')
      }
      deps.remoteRunIds.delete(deps.runId)
      deps.remoteRunLedgerIds.delete(deps.runId)
      if (state.remoteCompletion) state.resolveRemoteCompletion?.(state.remoteCompletion)
    }
  }
}
