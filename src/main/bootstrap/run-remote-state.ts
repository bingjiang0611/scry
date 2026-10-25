import type { BrowserWindow } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import type { RuntimeProvider } from '../../shared/runtime'
import type { RemoteRunCompletion } from '../remote/remote-run-binding'
import type { ArchiveTraceTurnArgs } from './archive'

export type RunTerminalState = {
  terminalArchiveArgs?: ArchiveTraceTurnArgs
  terminalArchiveCommitted: boolean
  managedSettlementAttempted: boolean
  terminalStatus?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  remoteRecordingFailed: boolean
  remoteCompletion?: RemoteRunCompletion
  resolveRemoteCompletion?: (completion: RemoteRunCompletion) => void
}

export function createRemoteRunState(deps: {
  isRemoteRun: boolean
  runId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  runState: ActiveRun
  getObservedSessionId: () => string | undefined
  getWindow: () => Pick<BrowserWindow, 'isFocused'> | null
  dockBadge: { markAttention: (key: string, value: { windowFocused: boolean; sessionViewed: boolean; needsAttention: boolean }) => void }
  scopedSessionKey: (sessionId: string) => string
  runs: { isViewed: (runId: string) => boolean }
}) {
  const state: RunTerminalState = {
    terminalArchiveArgs: undefined,
    terminalArchiveCommitted: false,
    managedSettlementAttempted: false,
    terminalStatus: undefined,
    remoteRecordingFailed: false,
    remoteCompletion: undefined,
    resolveRemoteCompletion: undefined
  }
  const remoteResult = deps.isRemoteRun
    ? new Promise<RemoteRunCompletion>((resolve) => { state.resolveRemoteCompletion = resolve })
    : undefined
  const finishRemote = (status: RemoteRunCompletion['status'], error?: string): void => {
    if (!deps.isRemoteRun || state.remoteCompletion) return
    state.remoteCompletion = {
      status,
      recording: state.remoteRecordingFailed ? 'failed' : 'committed',
      ...(deps.getObservedSessionId() ? { externalSessionId: deps.getObservedSessionId() } : {}),
      ...(state.terminalArchiveArgs?.providerTurnId ? { providerTurnId: state.terminalArchiveArgs.providerTurnId } : {}),
      ...(state.terminalArchiveArgs?.forkTurnId ? { forkTurnId: state.terminalArchiveArgs.forkTurnId } : {}),
      ...(error ? { error } : {})
    }
    deps.runState.done = true
    if (error) deps.runState.error = error
  }
  const markTerminalAttention = (sessionId: string, needsAttention: boolean): void => {
    deps.dockBadge.markAttention(deps.scopedSessionKey(sessionId), {
      windowFocused: Boolean(deps.getWindow()?.isFocused()),
      sessionViewed: deps.runs.isViewed(deps.runId),
      needsAttention
    })
  }
  return { state, remoteResult, finishRemote, markTerminalAttention }
}
