import { app, type BrowserWindow } from 'electron'
import type { AgentStartRequest, AgentQuestionRequest, AgentIntervention } from '../../shared/runtime'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import type { ProviderRunHandle } from '../providers/types'
import type { ProviderRegistry } from '../providers/registry'
import type { PiRunDiagnostics } from '../providers/pi-run-diagnostics'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { ContextAdmission } from '../context-admission'
import type { ConversationStore, NativeSessionScope } from '../conversation-store'
import type { createAppSessionStore } from '../app-store'
import type { RunRegistry } from '../run-registry'
import type { RunStopLifecycle } from '../run-stop-lifecycle'
import type { UserQuestionBroker } from '../user-question'
import type { DockBadgeState } from '../dock-badge'
import type { SourceControlService } from '../source-control/service'
import type { LlmNetworkConfigurationCache } from '../llm-network-configuration'
import { RunDiffPreviewer, type SessionDiffBaselineRegistry } from '../session-diff'
import { appendCoalescedTrace, upsertTraceById } from '../live-trace'
import { RunSteering } from '../run-steering'
import { prepareRunAttachments, deleteRunAttachments } from '../attachment-store'
import type { RemoteRunCompletion } from '../remote/remote-run-binding'
import { prepareRunFrontdoor, type AppRunStartOptions } from './run-frontdoor'
import { prepareRunAdmission } from './run-admission'
import { createLiveRunState } from './run-live-state'
import { createRunDiffLifecycle } from './run-diff'
import { createSessionPublisher } from './run-session'
import { startRunProviderAndRegister, startProviderAfterBaseline } from './run-startup'
import { createRemoteRunState } from './run-remote-state'
import { createManagedConversationSettlement } from './run-settlement'
import { handleRunCompletion } from './run-completion'
import { handleRunFailure } from './run-failure'
import { archiveTraceTurn } from './archive'
import type { RunControl } from './run-control'

type RunHost = {
  providerRegistry: ProviderRegistry
  piRunDiagnostics: PiRunDiagnostics
  isShuttingDown: () => boolean
  getCurrentCwd: () => string | undefined
  getWindow: () => BrowserWindow | null
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  resolveRemoteProjectDirectory: (cwd: string) => string
  resolveKnownProjectDirectory: (cwd: string) => string
  providerOperationGate: ProviderOperationGate
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, profile?: string) => string
  contextAdmission: ContextAdmission
  getStartupManagedRecovery: () => Promise<void>
  resetSessionContext: (key: string) => void
  sessionRevisionByContext: Map<string, number>
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  runs: RunRegistry<ActiveRun, RunControl>
  deletingSessions: Set<string>
  conversationStore: () => ConversationStore
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope) => Promise<void>
  recordingBlockedSessions: Map<string, string>
  homeDir: string
  nextRunSequence: () => number
  llmNetworkConfiguration: LlmNetworkConfigurationCache
  sessionDiffBaselines: SessionDiffBaselineRegistry
  queueTrace: (event: TraceEvent) => void
  rendererCanReceive: () => boolean
  mainEventId: (prefix: string, runId: string) => string
  LIVE_TOOL_CONTENT_POLICY: Parameters<typeof createLiveRunState>[0]['LIVE_TOOL_CONTENT_POLICY']
  recordingRecoveryHint: string
  sessionBaselineKey: (context: string, sessionId: string) => string
  dockBadge: DockBadgeState
  userQuestionBroker: UserQuestionBroker
  publishQuestionOpened: (request: AgentQuestionRequest) => void
  publishQuestionClosed: (runId: string, questionId: string, intervention?: AgentIntervention) => void
  requestRunStop: (runId: string) => boolean
  bumpSessionRevision: (key: string) => void
  sourceControl: SourceControlService
  remoteRunIds: Set<string>
  remoteRunLedgerIds: Map<string, string>
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  flushTraceSend: () => void
  runStopLifecycle: RunStopLifecycle
}

export async function startRun(
  payload: AgentStartRequest,
  options: AppRunStartOptions,
  host: RunHost
): Promise<{ runId: string } | RemoteRunCompletion> {
  const {
    providerRegistry, isShuttingDown, getCurrentCwd, getWindow, appSessionStore,
    resolveRemoteProjectDirectory, resolveKnownProjectDirectory, providerOperationGate,
    providerContextKey, providerSessionKey, contextAdmission, getStartupManagedRecovery,
    resetSessionContext, sessionRevisionByContext, sessionByContext, sessionAliasesByContext,
    runs, deletingSessions, conversationStore, assertLegacyConversationWriteAllowed,
    recordingBlockedSessions, homeDir, nextRunSequence, llmNetworkConfiguration,
    sessionDiffBaselines, queueTrace, rendererCanReceive, mainEventId, LIVE_TOOL_CONTENT_POLICY,
    recordingRecoveryHint, sessionBaselineKey, dockBadge, userQuestionBroker,
    publishQuestionOpened, publishQuestionClosed, requestRunStop, bumpSessionRevision,
    sourceControl, remoteRunIds, remoteRunLedgerIds, boundedLiveRun, mirrorSessionTranscript,
    flushTraceSend, runStopLifecycle
  } = host
  const frontdoor = prepareRunFrontdoor(payload, options, {
    providerRegistry, isShuttingDown: isShuttingDown(), currentCwd: getCurrentCwd(), appSessionStore, resolveRemoteProjectDirectory,
    resolveKnownProjectDirectory, providerOperationGate, providerContextKey
  })
  const { isRemoteRun, request, providerId, agentProfileId, startPerf, firstTracePerf,
    firstTextPerf, adapter, runtimeProvider, cwd, catalogCwd, startLease, managedConversation,
    admissionKeys, assertSessionNotArchived } = frontdoor
  let remoteResult: Promise<RemoteRunCompletion> | undefined
  try {
    const started = await contextAdmission.runMany(admissionKeys, async () => {
      const admitted = await prepareRunAdmission(frontdoor, options, {
        providerRegistry, getStartupManagedRecovery,
        isShuttingDown,
        providerContextKey, providerSessionKey, resetSessionContext, sessionRevisionByContext,
        sessionByContext, sessionAliasesByContext, runs, appSessionStore, deletingSessions,
        conversationStore, assertLegacyConversationWriteAllowed, recordingBlockedSessions
      })
      const { contextKey, scopedSessionKey, resume, editSourceSessionId,
        managedRecorderEnabled, managedRecorderEnablement, managedCommitHookEnv,
        canonicalLifecycle, codexHookTrust, openCodePluginTrust, mcpExecutionSnapshot } = admitted
      let { contextRevision } = admitted
      const liveRunState = await createLiveRunState({
        options, providerId, runtimeProvider, request, managedConversation, cwd, catalogCwd, resume, contextKey,
        agentProfileId, codexHookTrust, openCodePluginTrust, managedRecorderEnabled, managedRecorderEnablement, homeDir,
        createRunId: (managed, runOptions) => managed?.runId ?? runOptions.runId ?? `run-${Date.now().toString(36)}-${nextRunSequence()}`,
        llmNetworkConfiguration, sessionDiffBaselines, appSessionStore, recordingBlockedSessions, getWindow, runs, queueTrace,
        rendererCanReceive, mainEventId, LIVE_TOOL_CONTENT_POLICY, recordingRecoveryHint, userDataDir: app.getPath('userData'),
        scopedSessionKey, isRemoteRun, editSourceSessionId, deleteRunAttachments, sessionBaselineKey
      })
      let { runId, diffContextKey, finishTurnWallTiming, turnChangeJournal, attachments, managedInputTextHash,
        displayPrompt, runtimePrompt, runState, persistRunData, cleanupProvisional, notifyDiffChangeRef,
        ingestion, emit, persistLlmPerformance, turnDiffCapture, patchExcludeBasenames,
        sessionBaselineReady, sessionBaselineOrigin, sessionBaselineCapture, releaseSessionBaseline } = liveRunState
      if (providerId === 'pi') host.piRunDiagnostics.record(runId, 'main_preparing', { mainDone: false, mainSettled: false })
      const diffPreviewer = new RunDiffPreviewer({
        runId,
        turnCapture: cwd ? turnDiffCapture : null,
        sessionCapture: sessionBaselineCapture,
        ...(sessionBaselineOrigin ? { sessionBaselineOrigin } : {}),
        hints: () => ({ ...turnChangeJournal?.snapshot(), patchExcludeBasenames }),
        emit: ({ stage, id, snapshot }) => {
          const event: TraceEvent = {
            id,
            ts: new Date().toISOString(),
            runId,
            kind: 'harness',
            stage,
            providerId,
            runtimeProvider,
            turnDiff: snapshot
          }
          upsertTraceById(runState.items, event)
          if (runs.isFocused(runId)) queueTrace(event)
        },
        onError: (scope, error) => console.warn('[scry] diff preview failed:', runId, scope, error)
      })
      notifyDiffChangeRef.current = () => void diffPreviewer.notifyChange()
      const diffLifecycle = createRunDiffLifecycle({ diffPreviewer, turnDiffCapture, turnChangeJournal, patchExcludeBasenames, cwd, contextKey, runId, providerId, runtimeProvider, runState, sessionDiffBaselines, getDiffContextKey: () => diffContextKey, getObservedSessionId: () => liveRunState.observedSessionId, getResume: () => resume, getContextRevision: () => contextRevision, mainEventId, appendCoalescedTrace, queueTrace, runs })
      const { finalizeTurnDiff, cancelTurnDiff, finalizeSessionDiff } = diffLifecycle
      const publishSessionId = createSessionPublisher({
        runState,
        providerId,
        agentProfileId,
        runtimeProvider,
        runId,
        cwd,
        catalogCwd,
        displayPrompt,
        contextKey,
        editSourceSessionId,
        managedConversation,
        isRemoteRun,
        onSession: options.onSession,
        getContextRevision: () => contextRevision,
        getDiffContextKey: () => diffContextKey,
        setDiffContextKey: (value) => { diffContextKey = value },
        setObservedSessionId: (value) => { liveRunState.observedSessionId = value },
        sessionBaselineKey,
        sessionDiffBaselines,
        sessionByContext,
        sessionAliasesByContext,
        scopedSessionKey,
        dockBadge,
        appSessionStore,
        runs,
        getWindow,
        initialSessionId: resume,
        sessionRevisionByContext
      })
      const handle = { current: null as ProviderRunHandle | null }
      const steering = new RunSteering(
        runState,
        () => handle.current?.steer,
        (input) => prepareRunAttachments(app.getPath('userData'), runId, input.attachments,
          cwd ? { providerId, cwd, sessionId: runState.externalSessionId } : undefined, input.messageId),
        emit
      )
      const interruptedState = { value: options.stopSignal?.aborted === true }
      const runtimeStartup = await startRunProviderAndRegister({
        options,
        providerId,
        runtimeProvider,
        providerRegistry,
        piRunDiagnostics: host.piRunDiagnostics,
        adapter,
        request,
        runtimePrompt,
        managedConversation,
        runId,
        cwd,
        agentProfileId,
        resume,
        attachments,
        codexHookTrust,
        openCodePluginTrust,
        managedRecorderEnabled,
        managedInputTextHash,
        displayPrompt,
        handle,
        steering,
        userQuestionBroker,
        publishSessionId,
        emit,
        runState,
        ingestion,
        firstTracePerf,
        firstTextPerf,
        mainEventId,
        isRemoteRun,
        mcpExecutionSnapshot,
        conversationStore,
        catalogCwd,
        publishQuestionOpened,
        publishQuestionClosed,
        runs,
        requestRunStop,
        contextKey,
        setContextRevision: (value) => { contextRevision = value },
        getObservedSessionId: () => liveRunState.observedSessionId,
        sessionByContext,
        sessionRevisionByContext,
        bumpSessionRevision,
        cleanupProvisional,
        finalizeTurnDiff,
        cancelTurnDiff,
        sourceControl,
        assertSessionNotArchived,
        remoteRunIds,
        remoteRunLedgerIds,
        deleteRunAttachments,
        turnDiffCapture,
        sessionBaselineReady,
        startPerf,
        dockBadge,
        scopedSessionKey,
        getWindow,
        boundedLiveRun,
        releaseSessionBaseline,
        interruptedState,
        canonicalLifecycle,
        assertLegacyConversationWriteAllowed
      })
      const { runProvider, requestRemoteStop, eventLog, getObservedProviderStartedAt, resolveSettled } = runtimeStartup
      const remoteState = createRemoteRunState({ isRemoteRun, runId, providerId, runtimeProvider, runState, getObservedSessionId: () => liveRunState.observedSessionId, getWindow, dockBadge, scopedSessionKey, runs })
      const runTerminalState = remoteState.state
      remoteResult = remoteState.remoteResult
      const { finishRemote, markTerminalAttention } = remoteState
      const settleManagedConversation = createManagedConversationSettlement({ state: runTerminalState, managedConversation, handle, cwd, runId, displayPrompt, runState, userDataDir: app.getPath('userData') })
      const runtimePromise = startProviderAfterBaseline({ turnDiffCapture, sessionBaselineReady, markReady: () => firstTextPerf.mark('git_baseline_ready'), runProvider })
      const completionContext = () => ({
        state: runTerminalState,
        providerId,
        agentProfileId,
        runtimeProvider,
        cwd,
        catalogCwd,
        runId,
        request,
        options,
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
        observedProviderStartedAt: getObservedProviderStartedAt(),
        getObservedSessionId: () => liveRunState.observedSessionId,
        getResume: () => resume,
        publishSessionId,
        appSessionStore,
        mirrorSessionTranscript,
        ingestion,
        flushTraceSend,
        persistRunData,
        settleManagedConversation,
        finishRemote,
        markTerminalAttention,
        firstTextPerf,
        runs
      })
      runtimePromise
        .then(
          (result) => handleRunCompletion(result, completionContext()),
          (error: unknown) => handleRunFailure(error, {
            ...completionContext(), handle, interrupted: runtimeStartup.getInterrupted(), queueTrace, mainEventId
          })
        )
        .catch(async (error) => {
          console.error('[scry] run completion handler failed:', error)
          await finalizeTurnDiff()
          if (runTerminalState.terminalArchiveArgs && !runTerminalState.terminalArchiveCommitted) {
            try {
              await archiveTraceTurn(runTerminalState.terminalArchiveArgs)
              runTerminalState.terminalArchiveCommitted = true
              if (runTerminalState.terminalArchiveArgs.sessionId) {
                recordingBlockedSessions.delete(scopedSessionKey(runTerminalState.terminalArchiveArgs.sessionId))
              }
            } catch (archiveError) {
              if (runTerminalState.terminalArchiveArgs.sessionId) recordingBlockedSessions.set(
                scopedSessionKey(runTerminalState.terminalArchiveArgs.sessionId),
                recordingRecoveryHint
              )
              console.error('[scry] fallback terminal archive failed:', archiveError)
            }
          }
          if (!runState.done) runState.done = true
          flushTraceSend()
          getWindow()?.webContents.send('agent:error', {
            runId,
            message: `Scry 处理 Provider 终态失败：${String((error as Error).message)}`,
            category: 'recording',
            hint: '保留 userData 与 workspace/.scry 后重启 Scry 检查归档'
          })
          if (isRemoteRun) runTerminalState.remoteRecordingFailed = true
          markTerminalAttention(
            runTerminalState.terminalArchiveArgs?.sessionId ?? liveRunState.observedSessionId ?? resume ?? runId,
            !runtimeStartup.getInterrupted()
          )
          finishRemote(runtimeStartup.getInterrupted() ? 'interrupted' : 'failed', String((error as Error).message ?? error))
        })
        .catch((error) => {
          if (isRemoteRun && !runTerminalState.remoteCompletion) {
            runTerminalState.remoteRecordingFailed = true
            finishRemote(runtimeStartup.getInterrupted() ? 'interrupted' : 'failed', String((error as Error).message ?? error))
          }
        })
        .finally(async () => {
          try {
            if (providerId === 'pi') host.piRunDiagnostics.record(runId, 'main_settlement', { mainDone: runState.done })
            await settleManagedConversation(runTerminalState.terminalStatus ?? (runtimeStartup.getInterrupted() ? 'interrupted' : 'failed'))
            options.stopSignal?.removeEventListener('abort', requestRemoteStop)
            runState.providerSettled = true
            firstTracePerf.finish(undefined, runtimeStartup.getInterrupted() ? 'cancelled' : 'unavailable')
            firstTextPerf.finish(undefined, runtimeStartup.getInterrupted() ? 'cancelled' : 'unavailable')
            runStopLifecycle.settle(runId)
            userQuestionBroker.cancelRun(runId)
            runs.remove(runId)
            releaseSessionBaseline?.()
            resolveSettled?.()
            if (providerId === 'pi') host.piRunDiagnostics.record(runId, 'main_settled', { mainDone: runState.done, mainSettled: true })
            void eventLog?.close()
          } finally {
            if (isRemoteRun) {
              if (!runTerminalState.remoteCompletion) {
                runTerminalState.remoteRecordingFailed = true
                finishRemote('failed', 'remote_run_terminal_outcome_unknown')
              }
              remoteRunIds.delete(runId)
              remoteRunLedgerIds.delete(runId)
              if (runTerminalState.remoteCompletion) runTerminalState.resolveRemoteCompletion?.(runTerminalState.remoteCompletion)
            }
          }
        })
      startPerf.finish({ attachments: attachments.length })
      return { runId, ...(runState.externalSessionId ? { externalSessionId: runState.externalSessionId } : {}) }
    })
    return isRemoteRun ? await remoteResult! : started
  } catch (error) {
    startPerf.finish(undefined, 'error')
    firstTracePerf.finish(undefined, 'error')
    firstTextPerf.finish(undefined, 'error')
    throw error
  } finally {
    startLease?.release()
  }
}
