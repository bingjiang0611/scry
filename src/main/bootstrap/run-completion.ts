import type { BrowserWindow } from 'electron'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { RuntimeProvider } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { ProviderRunResult } from '../providers/types'
import type { ArchiveTraceTurnArgs } from './archive'
import type { AppRunStartOptions } from './run-frontdoor'
import type { AgentInputAttachment, NormalizedAgentStartRequest } from '../../shared/runtime'
import type { createAppSessionStore } from '../app-store'
import type { LiveTraceIngestion } from '../live-trace-ingestion'
import { app } from 'electron'
import { PerformanceTrace } from '../performance-timing'
import { archiveSessionId } from '../session-id'
import { providerRecordingPolicy } from '../provider-recording-policy'
import { terminalOutcomeLabel } from '../run-outcome'
import { updateRunAttachmentOwner } from '../attachment-store'
import { archiveTraceTurn, persistTerminalProgress, observedTurnTiming } from './archive'

type CompletionState = {
  terminalArchiveArgs?: ArchiveTraceTurnArgs
  terminalArchiveCommitted: boolean
  terminalStatus?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  remoteRecordingFailed: boolean
}
type CompletionRuns = { isFocused: (runId: string) => boolean }
type CompletionWindow = BrowserWindow | null
export type RunCompletionContext = {
  state: CompletionState
  providerId: ProviderId
  agentProfileId?: string
  runtimeProvider: RuntimeProvider
  cwd: string | undefined
  catalogCwd: string
  runId: string
  request: NormalizedAgentStartRequest
  options: AppRunStartOptions
  displayPrompt: string
  attachments: AgentInputAttachment[]
  runState: ActiveRun
  managedCommitHookEnv: NodeJS.ProcessEnv | undefined
  managedRecorderEnabled: boolean
  canonicalLifecycle: boolean
  isRemoteRun: boolean
  recordingRecoveryHint: string
  recordingBlockedSessions: Map<string, string>
  scopedSessionKey: (sessionId: string) => string
  getWindow: () => CompletionWindow
  emit: (event: TraceEvent) => void
  finishTurnWallTiming: () => TraceEvent
  finalizeTurnDiff: () => Promise<void>
  finalizeSessionDiff: () => Promise<void>
  persistLlmPerformance: (failed: boolean, sessionId: string) => Promise<void>
  observedProviderStartedAt: string | undefined
  getObservedSessionId: () => string | undefined
  getResume: () => string | undefined
  publishSessionId: (sessionId: string | undefined) => void
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  ingestion: Pick<LiveTraceIngestion, 'idle' | 'liveIdle'>
  flushTraceSend: () => void
  persistRunData: (sessionId?: string) => void
  settleManagedConversation: (status: 'completed' | 'failed' | 'cancelled' | 'interrupted') => Promise<void>
  finishRemote: (status: 'completed' | 'failed' | 'cancelled' | 'interrupted', error?: string) => void
  markTerminalAttention: (sessionId: string, needsAttention: boolean) => void
  firstTextPerf: PerformanceTrace
  runs: CompletionRuns
}

export async function handleRunCompletion(r: ProviderRunResult, ctx: RunCompletionContext): Promise<void> {
  const {
    providerId,
    agentProfileId,
    runtimeProvider,
    cwd,
    catalogCwd,
    runId,
    displayPrompt,
    attachments,
    runState,
    managedCommitHookEnv,
    managedRecorderEnabled,
    canonicalLifecycle,
    isRemoteRun,
    recordingRecoveryHint,
    recordingBlockedSessions,
    scopedSessionKey,
    getWindow,
    emit,
    finishTurnWallTiming,
    finalizeTurnDiff,
    finalizeSessionDiff,
    persistLlmPerformance,
    observedProviderStartedAt,
    publishSessionId,
    appSessionStore,
    mirrorSessionTranscript,
    ingestion,
    flushTraceSend,
    persistRunData,
    settleManagedConversation,
    finishRemote,
    markTerminalAttention
  } = ctx
  const terminalPerf = new PerformanceTrace('agent.terminal_finalize', { provider: providerId })
  terminalPerf.mark('provider_terminal')
  emit(finishTurnWallTiming())
  const turnDiffDone = finalizeTurnDiff()
  const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
  const nativeSessionId = r.externalSessionId ?? ctx.getObservedSessionId() ?? ctx.getResume()
  const storageSessionId = nativeSessionId ?? runId
  const completionStatus = r.status ?? (r.stopped ? 'interrupted' : 'completed')
  ctx.state.terminalStatus = completionStatus
  await persistLlmPerformance(completionStatus !== 'completed', storageSessionId)
  const completionNeedsAttention = completionStatus === 'completed' || completionStatus === 'failed'
  const completionArchiveArgs: ArchiveTraceTurnArgs = {
    agentProfileId: agentProfileId ?? null,
    providerId,
    runtimeProvider,
    cwd,
    sessionId: archiveSessionId(managedRecorderEnabled, nativeSessionId, storageSessionId),
    providerTurnId: r.providerTurnId,
    forkTurnId: r.forkTurnId ?? r.providerTurnId,
    runId,
    userText: displayPrompt,
    attachments,
    items: runState.items,
    done: true,
    status: completionStatus,
    observedTiming,
    commitHookEnv: managedCommitHookEnv,
    managedRecorderEnabled,
    beforePersist: () => ingestion.idle()
  }
  if (cwd) {
    try { updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId: storageSessionId }) } catch (error) {
      console.warn('[scry] terminal attachment ownership update failed:', runId, error)
    }
  }
  publishSessionId(r.externalSessionId)
  try {
    appSessionStore().record({
      lastRunOutcome: completionStatus,
      providerId,
      agentProfileId,
      runtimeProvider,
      runId,
      externalSessionId: storageSessionId,
      cwd: catalogCwd,
      prompt: displayPrompt
    })
  } catch (error) {
    getWindow()?.webContents.send('agent:error', {
      runId,
      message: `${terminalOutcomeLabel(completionStatus)}，但会话 catalog 更新失败：${String((error as Error).message)}`,
      category: 'catalog',
      hint: '保留 userData/app-sessions.json 与 .bak 后重试；本轮 trace 仍会继续归档'
    })
  }
  void mirrorSessionTranscript(providerId, cwd, nativeSessionId)
  const alreadyDone = runState.done
  runState.done = true
  await ingestion.liveIdle()
  flushTraceSend() // 先把模型/工具事件发完，再发 turnDone；turn_diff 可稍后增量到达
  const recordingPolicy = providerRecordingPolicy('completed', r.recordingFailure)
  if (!recordingPolicy.allowCanonicalCommit) {
    if (isRemoteRun) ctx.state.remoteRecordingFailed = true
    const { message, category } = recordingPolicy.rendererError
    runState.error = message
    runState.errorHint = recordingRecoveryHint
    if (recordingPolicy.blockSession) {
      recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
    }
    getWindow()?.webContents.send('agent:error', {
      runId,
      message,
      category,
      hint: runState.errorHint
    })
    markTerminalAttention(storageSessionId, completionNeedsAttention)
    await turnDiffDone
    terminalPerf.mark('diff_complete')
    persistRunData(storageSessionId)
    terminalPerf.finish({ events: runState.items.length, committed: 0 }, 'error')
    finishRemote(completionStatus, message)
    return
  }
  ctx.state.terminalArchiveArgs = completionArchiveArgs
  try {
    await persistTerminalProgress(completionArchiveArgs)
  } catch (error) {
    if (isRemoteRun) ctx.state.remoteRecordingFailed = true
    const message = `${terminalOutcomeLabel(completionStatus)}，但 Scry 精确记录快照失败：${String((error as Error).message)}`
    runState.error = message
    runState.errorHint = recordingRecoveryHint
    recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
    getWindow()?.webContents.send('agent:error', {
      runId,
      message,
      category: 'recording',
      hint: runState.errorHint
    })
  }
  if (!canonicalLifecycle && !alreadyDone) {
    getWindow()?.webContents.send('agent:turnDone', {
      runId,
      sessionId: storageSessionId,
      externalSessionId: storageSessionId,
      providerId,
      agentProfileId,
      providerTurnId: r.providerTurnId,
      forkTurnId: r.forkTurnId ?? r.providerTurnId,
      stopped: r.stopped
    })
    markTerminalAttention(storageSessionId, completionNeedsAttention)
    terminalPerf.mark('renderer_terminal')
  }
  await turnDiffDone
  await finalizeSessionDiff()
  terminalPerf.mark('diff_complete')
  try {
    await archiveTraceTurn(completionArchiveArgs)
    ctx.state.terminalArchiveCommitted = true
    recordingBlockedSessions.delete(scopedSessionKey(storageSessionId))
    terminalPerf.mark('archive_committed')
    await settleManagedConversation(completionStatus)
  } catch (error) {
    if (isRemoteRun) ctx.state.remoteRecordingFailed = true
    const message = `${terminalOutcomeLabel(completionStatus)}，但 Scry 精确记录提交失败：${String((error as Error).message)}`
    runState.error = message
    runState.errorHint = recordingRecoveryHint
    recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
    getWindow()?.webContents.send('agent:error', {
      runId,
      message,
      category: 'recording',
      hint: runState.errorHint
    })
    markTerminalAttention(storageSessionId, completionNeedsAttention)
    terminalPerf.finish({ events: runState.items.length, committed: 0 }, 'error')
    finishRemote(completionStatus, message)
    return
  }
  persistRunData(storageSessionId)
  terminalPerf.mark('database_projected')
  if (canonicalLifecycle && !alreadyDone) {
    getWindow()?.webContents.send('agent:turnDone', {
      runId,
      sessionId: storageSessionId,
      externalSessionId: storageSessionId,
      providerId,
      agentProfileId,
      providerTurnId: r.providerTurnId,
      forkTurnId: r.forkTurnId ?? r.providerTurnId,
      stopped: r.stopped
    })
    markTerminalAttention(storageSessionId, completionNeedsAttention)
    terminalPerf.mark('renderer_terminal')
  }
  terminalPerf.finish({ events: runState.items.length, committed: 1 })
  finishRemote(completionStatus)
}
