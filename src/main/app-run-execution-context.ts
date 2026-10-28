import { app } from 'electron'
import { prepareAppRunExecution } from './app-run-execution-setup'
import { createAppRunSessionPublication } from './app-run-session-publication'
import { createAppRunDiffLifecycle } from './app-run-diff'
import { runAppProvider } from './app-run-provider'
import { scheduleAppRunTerminal } from './app-run-terminal-lifecycle'
import { prepareRunAttachments, providerAttachmentPrompt, deleteRunAttachments, type PreparedAttachment } from './attachment-store'
import { beginGitTurnDiff, cancelGitTurnDiff } from './git'
import { openProviderEventWriter } from './provider-event-log'
import { RunSteering } from './run-steering'
import { isManagedRecorderProvider } from '../core/turn-recorder/managed'
import { resolveRecorderEnablement } from '../core/turn-recorder/config'
import { PerformanceTrace } from './performance-timing'
import { type AppRunExecutionDeps, type AppRunExecutionState, type RunControl } from './app-run-lifecycle-types'
import type { ProviderRunHandle, ProviderRunResult, ProviderStructuredOutput } from './providers/types'
import type { ArchiveTraceTurnArgs } from './app-turn-archive'
import type { RemoteRunCompletion } from './remote/remote-run-binding'

export async function executeAppRun(state: AppRunExecutionState, deps: AppRunExecutionDeps): Promise<{ runId: string }> {
  const { contextKey, scopedSessionKey, resume, editSourceSessionId, catalogCwd, cwd,
    managedRecorderEnabled, managedRecorderEnablement, managedCommitHookEnv, codexHookTrust, openCodePluginTrust,
    mcpExecutionSnapshot, canonicalLifecycle, runId, managedConversation, request, options, isRemoteRun, isWorkflowRun,
    isAuthoringRun, providerId, agentProfileId, runtimeProvider, adapter, toolContentPolicy, replica, startPerf,
    firstTracePerf, firstTextPerf, remoteState, assertSessionNotArchived } = state
  const { sessionBaselineKey, llmNetworkConfiguration, homeDir, recordTurn, appSessionStore, rendererCanReceive,
    runs, queueTrace, persistTraceToolEvents, mainEventId,
    liveToolContentPolicy: LIVE_TOOL_CONTENT_POLICY, appendTrace: appendCoalescedTrace,
    sessionDiffBaselines, dockBadge, providerRegistry, conversationStore, assertLegacyConversationWriteAllowed,
    workflowRunControls, authorizedMcpExecution, assertWorkflowAuthoringIdentity, userQuestionBroker,
    publishQuestionOpened, publishQuestionClosed, remoteRunIds, remoteRunLedgerIds, requestRunStop, flushTraceSend,
    recordingRecoveryHint, recordingBlockedSessions, updateRunAttachmentOwner, appendUsage, ensureFailedTerminalResult,
    runTerminationHint, classifyError, terminalOutcomeLabel, persistTerminalProgress, archiveTraceTurn,
    settleSuccessfulAppRun, settleFailedAppRun, mirrorSessionTranscript, observedTurnTiming, providerRecordingPolicy,
    archiveSessionId, win, runStopLifecycle, sessionRevisionByContext, sessionByContext, sessionAliasesByContext,
    bumpSessionRevision, sourceControl, boundedLiveRun, conversationItemsFromTrace } = deps
let contextRevision = state.contextRevision
const preparedRun = await prepareAppRunExecution(state, {
  sessionBaselineKey, llmNetworkConfiguration, homeDir, recordTurn, appSessionStore, win, rendererCanReceive, runs, queueTrace, persistTraceToolEvents, appUserData: () => app.getPath('userData'), mainEventId, liveToolContentPolicy: LIVE_TOOL_CONTENT_POLICY, appendTrace: appendCoalescedTrace
})
const { initialDiffContextKey, finishTurnWallTiming, turnChangeJournal, runState, persistRunData, cleanupProvisional, ingestion, emit, persistLlmPerformance, displayPrompt, unavailableCapture } = preparedRun
let attachments: PreparedAttachment[] = preparedRun.attachments
let currentObservedSessionId: () => string | undefined = () => resume
  const runSession = createAppRunSessionPublication({
runId,
initialSessionId: resume,
initialDiffContextKey,
editSourceSessionId,
providerId,
agentProfileId,
runState,
initialRendererEnabled: !isWorkflowRun,
recordInitialSession: () => {
  if (resume) {
    // Resuming the same native session must also update the catalogue runId.
    appSessionStore().record({ providerId, agentProfileId, runtimeProvider, runId, externalSessionId: resume,
      workspaceScope: replica ? 'workflow_replica' : undefined, cwd: catalogCwd, prompt: displayPrompt })
  } else {
    // Durable ownership precedes attachment bytes so crash cleanup has a run owner.
    appSessionStore().recordPending({ workspaceScope: replica ? 'workflow_replica' : undefined,
      providerId, agentProfileId, runtimeProvider, runId, cwd: catalogCwd, prompt: displayPrompt })
  }
},
prepareAttachments: () => prepareRunAttachments(app.getPath('userData'), runId, request.attachments,
  cwd ? { providerId, cwd, ...(resume ? { sessionId: resume } : {}) } : undefined),
preparePrompt: preparedAttachments => managedConversation
  ? managedConversation.prepareInput(preparedAttachments)
  : { prompt: providerAttachmentPrompt(providerId, options.providerPrompt ?? displayPrompt, preparedAttachments) },
cleanupProvisional,
deleteAttachments: () => { deleteRunAttachments(app.getPath('userData'), runId) },
promoteDiffContext: (currentKey, sessionId) =>
  sessionDiffBaselines.promote(currentKey, sessionBaselineKey(contextKey, sessionId), sessionId),
commitSelectedSession: sessionId => {
  if (!managedConversation && !isRemoteRun && !isWorkflowRun &&
    (sessionRevisionByContext.get(contextKey) ?? 0) === contextRevision) {
    sessionByContext.set(contextKey, sessionId)
    sessionAliasesByContext.set(contextKey, new Map([[runId, sessionId]]))
  }
},
badgeKey: scopedSessionKey,
rekeyBadge: (previousKey, nextKey) => dockBadge.rekey(previousKey, nextKey),
viewBadge: (key, focused) => dockBadge.view(key, focused),
isRunViewed: () => runs.isViewed(runId),
isWindowFocused: () => Boolean(win?.isFocused()),
...(cwd ? { updateAttachmentOwner: (sessionId: string) =>
  updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId }) } : {}),
recordNativeSession: sessionId => appSessionStore().record({ providerId, agentProfileId, runtimeProvider, runId,
  externalSessionId: sessionId, workspaceScope: replica ? 'workflow_replica' : undefined,
  cwd: catalogCwd, prompt: displayPrompt }),
...((isRemoteRun || isWorkflowRun) && options.onSession ? { onExternalSession: options.onSession } : {}),
sendRendererSession: event => { win?.webContents.send('agent:session', event) },
warn: (message, error) => { console.warn(`[scry] ${message}:`, runId, error) }
  })
  attachments = runSession.attachments
  preparedRun.setCurrentObservedSessionId(runSession.observedSessionId)
  const runtimePrompt = runSession.runtimePrompt
  const managedInputTextHash = runSession.managedInputTextHash
  // Git 快照与非 managed Provider 的 recorder 配置读取彼此独立；并行启动，避免把
  // 两段本地预检串到 Provider 启动前。managed 路径直接复用上面已验证的配置快照。
  const initialDiffCapture = cwd ? beginGitTurnDiff(cwd) : Promise.resolve(unavailableCapture())
  let patchExcludeBasenames: string[] = []
  if (cwd) {
const recorderEnablement = managedRecorderEnablement ?? (
  isManagedRecorderProvider(providerId) ? undefined : await resolveRecorderEnablement(cwd)
)
if (recorderEnablement?.enabled) {
  patchExcludeBasenames = recorderEnablement.config.capture.patchExcludeBasenames ?? []
}
  }
  const runDiff = createAppRunDiffLifecycle({
runId,
cwd,
contextKey,
resume,
providerId,
runtimeProvider,
initialCapture: initialDiffCapture,
patchExcludeBasenames,
sessionDiffBaselines,
getDiffContextKey: runSession.diffContextKey,
getObservedSessionId: runSession.observedSessionId,
getContextRevision: () => contextRevision,
hints: () => turnChangeJournal?.snapshot() ?? {},
items: runState.items,
isFocused: () => runs.isFocused(runId),
isViewed: () => runs.isViewed(runId),
queueTrace,
eventId: prefix => mainEventId(prefix, runId)
  })
  const turnDiffCapture = runDiff.turnCapture
  const sessionBaselineReady = runDiff.sessionBaselineReady
  const releaseSessionBaseline = runDiff.releaseSessionBaseline
  const finalizeTurnDiff = runDiff.finalizeTurn
  const cancelTurnDiff = runDiff.cancelTurn
  const finalizeSessionDiff = runDiff.finalizeSession
  const publishSessionId = runSession.publishSessionId

  let h: ProviderRunHandle | null = null
  const steering = new RunSteering(
runState,
() => h?.steer,
(input) => prepareRunAttachments(app.getPath('userData'), runId, input.attachments,
  cwd ? { providerId, cwd, sessionId: runState.externalSessionId } : undefined, input.messageId),
emit
  )
  let workflowInteractionBlocked = false
  let interrupted = options.stopSignal?.aborted === true
  // 双流事件日志：每个 run 一个 writer，native 与 canonical 共享同一文件和序号。
  // 未通过环境变量启用时为 undefined，所有调用点直接跳过。
  const eventLog = openProviderEventWriter(`${providerId}-${runId}`)
  const stopLatch = new AbortController()
  const requestStop = (): void => {
interrupted = true
if (!stopLatch.signal.aborted) stopLatch.abort()
h?.interrupt()
  }
  const requestRemoteStop = (): void => {
if (runs.get(runId)) requestRunStop(runId)
else requestStop()
  }
  if (options.stopSignal && !options.stopSignal.aborted) options.stopSignal.addEventListener('abort', requestRemoteStop)
  let observedProviderStartedAt: string | undefined
  const runProvider = async (): Promise<ProviderRunResult> => runAppProvider({
interrupted: () => interrupted,
setProviderStartedAt: value => { observedProviderStartedAt = value },
firstTracePerf,
firstTextPerf,
managedConversation,
conversationStore,
catalogCwd,
resume,
providerRegistry,
providerId,
agentProfileId,
assertLegacyConversationWriteAllowed,
isWorkflowRun,
workflowRunControls,
workflowReplica: options.workflowReplica,
request,
options,
authorizedMcpExecution,
mcpExecutionSnapshot,
runId,
isAuthoringRun,
assertWorkflowAuthoringIdentity,
runtimePrompt,
managedInputTextHash,
adapter,
cwd,
attachments,
codexHookTrust,
openCodePluginTrust,
managedRecorderEnabled,
displayPrompt,
eventLog,
runState,
emit,
publishSessionId,
userQuestionBroker,
publishQuestionOpened,
publishQuestionClosed,
stopLatch,
requestStop,
requestRemoteStop,
steering,
ingestion,
mainEventId,
runtimeProvider,
createProviderHandle: value => { h = value },
getProviderHandle: () => h,
setWorkflowInteractionBlocked: () => { workflowInteractionBlocked = true }
  })
  let resolveSettled: (() => void) | undefined
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
  const control: RunControl = {
runId,
providerId,
interrupt: requestStop,
forceKill: () => {
  requestStop()
  h?.forceKill()
},
forceKillScope: () => h?.forceKillScope,
stopBackgroundTask: (taskId) => h?.stopBackgroundTask?.(taskId) ?? Promise.resolve({ status: 'unavailable', message: '当前 Provider 不支持单任务停止。' }),
steer: (input) => isWorkflowRun
  ? Promise.resolve({ status: 'unavailable', message: '工作流运行中不接受业务输入；请发起独立任务。' })
  : managedConversation
  ? Promise.resolve({ status: 'unavailable', message: '统一对话暂不支持 Steer；追加输入尚无完整的顺序投影，未发送。' })
  : steering.submit(input),
cwd,
resume,
getExternalSessionId: () => h?.getExternalSessionId(),
getProviderTurnId: () => h?.getProviderTurnId?.(),
canonicalLifecycle,
runtimeProvider,
runState,
adoptSession: () => {
  if (managedConversation) throw new Error('统一对话不能由旧会话入口接管，请打开其稳定对话条目')
  if (!contextKey) return
  bumpSessionRevision(contextKey)
  // Adoption changes only Mac selection. This run keeps its own baseline.
  if (currentObservedSessionId()) sessionByContext.set(contextKey, currentObservedSessionId()!)
  else sessionByContext.delete(contextKey)
},
cleanupProvisional,
finalizeTurnDiff,
cancelTurnDiff,
settled
  }
  try {
if (isRemoteRun) {
  remoteRunIds.add(runId)
  if (options.ledgerRunId) remoteRunLedgerIds.set(runId, options.ledgerRunId)
}
// Archive may land during async startup checks. Fence again immediately before
// registration so it either rejects this start or can stop the registered run.
await sourceControl.admitRun(cwd, () => {
  assertSessionNotArchived([request.expectedExternalSessionId, resume, runId])
  runs.register(runState, control, isRemoteRun || isWorkflowRun || managedConversation ? { focus: false } : undefined)
})
  } catch (error) {
if (isRemoteRun) {
  remoteRunIds.delete(runId)
  remoteRunLedgerIds.delete(runId)
}
releaseSessionBaseline?.()
try { cleanupProvisional() } catch { /* preserve the original registration error */ }
deleteRunAttachments(app.getPath('userData'), runId)
try { await cancelGitTurnDiff(await turnDiffCapture) } catch { /* preserve the original registration error */ }
throw error
  }
  startPerf.mark('run_registered')
  firstTextPerf.mark('run_registered')
  if (!isRemoteRun && !isWorkflowRun && !managedConversation) dockBadge.view(scopedSessionKey(resume ?? runId), Boolean(win?.isFocused()))
  // `agent:start` can also be invoked through the preload bridge (for example by
  // the regression runner), so publish the authoritative focused snapshot after
  // registration and before the Provider can emit trace or questions.
  if (!isRemoteRun && !isWorkflowRun && !managedConversation) {
try {
  win?.webContents.send('agent:focusedRun', boundedLiveRun(runState))
} catch (error) {
  console.warn('[scry] focused run renderer notification failed:', runId, error)
}
  }

  const terminalState: {
archiveArgs?: ArchiveTraceTurnArgs
archiveCommitted: boolean
managedSettlementAttempted: boolean
status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
structuredOutput?: ProviderStructuredOutput
remoteRecordingFailed: boolean
  } = { archiveCommitted: false, managedSettlementAttempted: false, remoteRecordingFailed: false }
  const settleManagedConversation = async (status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): Promise<void> => {
if (!managedConversation || terminalState.managedSettlementAttempted) return
terminalState.managedSettlementAttempted = true
const receipt = h?.getInputReceipt?.()
try {
  if (terminalState.archiveCommitted && terminalState.archiveArgs?.sessionId && cwd) {
    const finalItems = await conversationItemsFromTrace({
      userData: app.getPath('userData'),
      conversation: { cwd },
      runId,
      userText: displayPrompt,
      items: runState.items
    })
    await managedConversation.onTerminal({
      status,
      finalItems,
      archive: {
        sessionId: terminalState.archiveArgs.sessionId,
        ...(terminalState.archiveArgs.providerTurnId ? { providerTurnId: terminalState.archiveArgs.providerTurnId } : {})
      },
      receipt
    })
  } else {
    // A Provider terminal without an authoritative archive is still an
    // attempted delivery. Settle it as unknown; never leave active state
    // or a pending ledger that could be mistaken for a live owner.
    await managedConversation.onTerminal({ status, finalItems: [], receipt })
  }
} catch (error) {
  // Even archive extraction/receipt validation failures need a durable
  // terminal outcome. Omit archive evidence so the service records unknown.
  try {
    await managedConversation.onTerminal({ status, finalItems: [], receipt })
  } catch (fallbackError) {
    console.error('[scry] managed conversation settlement failed:', runId, error, fallbackError)
  }
}
  }
  let remoteCompletion: RemoteRunCompletion | undefined
  let resolveRemoteCompletion: ((completion: RemoteRunCompletion) => void) | undefined
  remoteState.value = isRemoteRun
? new Promise<RemoteRunCompletion>((resolve) => { resolveRemoteCompletion = resolve })
: undefined
  const finishRemote = (status: RemoteRunCompletion['status'], error?: string): void => {
if (!isRemoteRun || remoteCompletion) return
remoteCompletion = {
  status,
  recording: terminalState.remoteRecordingFailed ? 'failed' : 'committed',
  ...(currentObservedSessionId() ? { externalSessionId: currentObservedSessionId() } : {}),
  ...(terminalState.archiveArgs?.providerTurnId ? { providerTurnId: terminalState.archiveArgs.providerTurnId } : {}),
  ...(terminalState.archiveArgs?.forkTurnId ? { forkTurnId: terminalState.archiveArgs.forkTurnId } : {}),
  ...(error ? { error } : {})
}
if (isRemoteRun) {
  runState.done = true
  if (error) runState.error = error
}
  }
  const markTerminalAttention = (sessionId: string, needsAttention: boolean): void => {
dockBadge.markAttention(scopedSessionKey(sessionId), {
  windowFocused: Boolean(win?.isFocused()),
  sessionViewed: runs.isViewed(runId),
  needsAttention
})
  }
  const terminalDeps = {
terminalState, providerId, runtimeProvider, runId, app, agentProfileId, cwd, catalogCwd, replica, displayPrompt, attachments, runState,
observedProviderStartedAt, managedCommitHookEnv, managedRecorderEnabled, toolContentPolicy, ingestion, emit, resume,
interrupted, getProviderHandle: () => h, runs, queueTrace, mainEventId, appendUsage, ensureFailedTerminalResult, runTerminationHint, classifyError,
finalizeTurnDiff, finalizeSessionDiff, persistLlmPerformance, finishTurnWallTiming, observedTurnTiming, currentObservedSessionId,
publishSessionId, appSessionStore, mirrorSessionTranscript, isRemoteRun, isWorkflowRun, canonicalLifecycle,
recordingRecoveryHint, recordingBlockedSessions, scopedSessionKey, markTerminalAttention, persistRunData, finishRemote,
terminalOutcomeLabel, PerformanceTrace, persistTerminalProgress, archiveTraceTurn, settleManagedConversation,
updateRunAttachmentOwner, flushTraceSend, win, archiveSessionId, providerRecordingPolicy
  }
  scheduleAppRunTerminal(terminalDeps, {
    runtimePromise: Promise.all([turnDiffCapture, sessionBaselineReady]).then(() => {
      firstTextPerf.mark('git_baseline_ready')
      return runProvider()
    }),
    firstTextPerf, startPerf, runId, isRemoteRun, isWorkflowRun, managedConversation, options, runState,
    terminalState, interrupted, firstTracePerf, userQuestionBroker, runs, releaseSessionBaseline,
    resolveSettled, eventLog, currentObservedSessionId, win, flushTraceSend,
    remoteRunIds, remoteRunLedgerIds, scopedSessionKey, recordingRecoveryHint, requestRemoteStop,
    runStopLifecycle, workflowInteractionBlocked, getRemoteCompletion: () => remoteCompletion,
    resolveRemoteCompletion,
    settleSuccessfulAppRun, settleFailedAppRun
  })
  startPerf.finish({ attachments: attachments.length })
  return { runId }
}
