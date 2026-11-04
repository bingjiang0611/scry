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
import type { RunTraceRouter } from '../run-trace-router'
import type { UserQuestionBroker } from '../user-question'
import type { DockBadgeState } from '../dock-badge'
import type { SourceControlService } from '../source-control/service'
import type { LlmNetworkConfigurationCache } from '../llm-network-configuration'
import type { SessionDiffBaselineRegistry } from '../session-diff'
import { appendCoalescedTrace } from '../live-trace'
import { RunSteering } from '../run-steering'
import { prepareRunAttachments, deleteRunAttachments } from '../attachment-store'
import type { RemoteRunCompletion } from '../remote/remote-run-binding'
import { prepareRunFrontdoor, type AppRunStartOptions } from './run-frontdoor'
import { prepareRunAdmission } from './run-admission'
import { createLiveRunState } from './run-live-state'
import { createRunDiffLifecycle, createRunDiffPreviewer } from './run-diff'
import { createSessionPublisher } from './run-session'
import { startRunProviderAndRegister, startProviderAfterBaseline } from './run-startup'
import { createRemoteRunState } from './run-remote-state'
import { attachRunSettlement, createManagedConversationSettlement, type RunSettlementDeps } from './run-settlement'
import { handleRunCompletion } from './run-completion'
import { handleRunFailure } from './run-failure'
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
  publishTrace: (event: TraceEvent) => void
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
  forgetBoundedRun: (runId: string) => void
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  flushTraceSend: () => void
  runStopLifecycle: RunStopLifecycle
  runTraces: Pick<RunTraceRouter, 'settle' | 'hasDemand'>
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
    sessionDiffBaselines, publishTrace, rendererCanReceive, mainEventId, LIVE_TOOL_CONTENT_POLICY,
    recordingRecoveryHint, sessionBaselineKey, dockBadge, userQuestionBroker,
    publishQuestionOpened, publishQuestionClosed, requestRunStop, bumpSessionRevision,
    sourceControl, remoteRunIds, remoteRunLedgerIds, boundedLiveRun, forgetBoundedRun, mirrorSessionTranscript,
    flushTraceSend, runStopLifecycle, runTraces
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
        llmNetworkConfiguration, sessionDiffBaselines, appSessionStore, recordingBlockedSessions, getWindow, publishTrace,
        rendererCanReceive, mainEventId, LIVE_TOOL_CONTENT_POLICY, recordingRecoveryHint, userDataDir: app.getPath('userData'),
        scopedSessionKey, isRemoteRun, editSourceSessionId, deleteRunAttachments, sessionBaselineKey
      })
      let { runId, diffContextKey, finishTurnWallTiming, turnChangeJournal, attachments, managedInputTextHash,
        displayPrompt, runtimePrompt, runState, persistRunData, cleanupProvisional, notifyDiffChangeRef,
        ingestion, emit, persistLlmPerformance, turnDiffCapture, patchExcludeBasenames,
        sessionBaselineReady, sessionBaselineOrigin, sessionBaselineCapture, releaseSessionBaseline } = liveRunState
      if (providerId === 'pi') host.piRunDiagnostics.record(runId, 'main_preparing', { mainDone: false, mainSettled: false })
      const diffPreviewer = createRunDiffPreviewer({
        runId, providerId, runtimeProvider, cwd, turnCapture: turnDiffCapture,
        sessionCapture: sessionBaselineCapture, sessionBaselineOrigin, turnChangeJournal,
        patchExcludeBasenames, runState, publishTrace
      })
      notifyDiffChangeRef.current = () => void diffPreviewer.notifyChange()
      const diffLifecycle = createRunDiffLifecycle({ isRemoteRun, diffPreviewer, turnDiffCapture, turnChangeJournal, patchExcludeBasenames, cwd, contextKey, runId, providerId, runtimeProvider, runState, sessionDiffBaselines, getDiffContextKey: () => diffContextKey, getObservedSessionId: () => liveRunState.observedSessionId, getResume: () => resume, getContextRevision: () => contextRevision, mainEventId, appendCoalescedTrace, publishTrace })
      const { setDiffPreviewDemand, finalizeTurnDiff, cancelTurnDiff, finalizeSessionDiff } = diffLifecycle
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
      runtimeStartup.control.setDiffPreviewDemand = setDiffPreviewDemand
      setDiffPreviewDemand?.(runTraces.hasDemand(runId))
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
      // Provider settle, completion handling and local finalization are one ordered chain:
      // settlement is recorded first, finalization owns the registry entry last.
      const settlement: RunSettlementDeps = {
        onProviderSettled: () => {
          runState.providerSettled = true
          runState.localFinalizing = true
          runStopLifecycle.settle(runId)
        },
        finalizeTurnDiff,
        runState,
        runId,
        providerId,
        isRemoteRun,
        remote: remoteState,
        settleManagedConversation,
        interrupted: runtimeStartup.getInterrupted,
        flushTraceSend,
        getWindow,
        recordingBlockedSessions,
        scopedSessionKey,
        recordingRecoveryHint,
        getObservedSessionId: () => liveRunState.observedSessionId,
        resume,
        piRunDiagnostics: host.piRunDiagnostics,
        lifecycle: {
          runStopLifecycle, userQuestionBroker, runTraces, runs, forgetBoundedRun,
          releaseSessionBaseline, resolveSettled,
          clearDiffPreviewDemand: () => { runtimeStartup.control.setDiffPreviewDemand = undefined },
          closeEventLog: () => void eventLog?.close()
        },
        firstTracePerf, firstTextPerf,
        stopSignal: options.stopSignal,
        requestRemoteStop,
        remoteRunIds, remoteRunLedgerIds
      }
      attachRunSettlement(
        runtimePromise,
        (result) => handleRunCompletion(result, completionContext()),
        (error) => handleRunFailure(error, {
          ...completionContext(), handle, interrupted: runtimeStartup.getInterrupted(), publishTrace, mainEventId
        }),
        settlement
      )
      startPerf.finish({ attachments: attachments.length })
      return { runId, ...(runState.externalSessionId ? { externalSessionId: runState.externalSessionId } : {}) }
    })
    options.onRegistered?.(started)
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
