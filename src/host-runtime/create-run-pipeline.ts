import type { BrowserWindow } from 'electron'
import { createTraceRuntime, type RunRendererSink } from '../main/bootstrap/trace-runtime'
import type { ActiveRun } from '../shared/trace'
import type { DockBadgeState } from '../main/dock-badge'
import { CommandReceipts } from '../main/command-receipts'
import { LlmNetworkConfigurationCache } from '../main/llm-network-configuration'
import { startRun } from '../main/bootstrap/run-execution'
import { startWorkspaceRun } from '../main/bootstrap/workspace-start'
import type { AppRunStartOptions } from '../main/bootstrap/run-frontdoor'
import type { AgentStartRequest, AgentStartResult } from '../shared/runtime'
import type { RemoteRunCompletion } from '../main/remote/remote-run-binding'

// M2-4: the run pipeline's assembly entry. Everything below is a plain value or a
// function that main (or the daemon) supplies, so this module never needs the
// electron runtime; only the `BrowserWindow` *type* appears, and that is erased.
export interface RunPipelineInputs {
  renderer: RunRendererSink
  rendererCanReceive: () => boolean
  activeRunSessionKey: (run: ActiveRun) => string | null
  dockBadge: DockBadgeState
  mainEventId: (prefix: string, runId: string) => string
  getWindow: () => BrowserWindow | null
  getCurrentCwd: () => string | undefined
  getStartupManagedRecovery: () => Promise<void>
  isShuttingDown: () => boolean
  nextRunSequence: () => number
  sourceControl: Parameters<typeof startWorkspaceRun>[2]['sourceControl']
  providerRegistry: Parameters<typeof startRun>[2]['providerRegistry']
  resolveKnownProjectDirectory: Parameters<typeof startWorkspaceRun>[2]['resolveKnownProjectDirectory']
  resolveRemoteProjectDirectory: Parameters<typeof startRun>[2]['resolveRemoteProjectDirectory']
  startWorkspaceRun: typeof startWorkspaceRun
  startRun: typeof startRun
  piRunDiagnostics: Parameters<typeof startRun>[2]['piRunDiagnostics']
  appSessionStore: Parameters<typeof startRun>[2]['appSessionStore']
  providerOperationGate: Parameters<typeof startRun>[2]['providerOperationGate']
  providerContextKey: Parameters<typeof startRun>[2]['providerContextKey']
  providerSessionKey: Parameters<typeof startRun>[2]['providerSessionKey']
  contextAdmission: Parameters<typeof startRun>[2]['contextAdmission']
  resetSessionContext: Parameters<typeof startRun>[2]['resetSessionContext']
  sessionRevisionByContext: Parameters<typeof startRun>[2]['sessionRevisionByContext']
  sessionByContext: Parameters<typeof startRun>[2]['sessionByContext']
  sessionAliasesByContext: Parameters<typeof startRun>[2]['sessionAliasesByContext']
  deletingSessions: Parameters<typeof startRun>[2]['deletingSessions']
  conversationStore: Parameters<typeof startRun>[2]['conversationStore']
  assertLegacyConversationWriteAllowed: Parameters<typeof startRun>[2]['assertLegacyConversationWriteAllowed']
  recordingBlockedSessions: Parameters<typeof startRun>[2]['recordingBlockedSessions']
  homeDir: string
  sessionDiffBaselines: Parameters<typeof startRun>[2]['sessionDiffBaselines']
  recordingRecoveryHint: Parameters<typeof startRun>[2]['recordingRecoveryHint']
  sessionBaselineKey: Parameters<typeof startRun>[2]['sessionBaselineKey']
  requestRunStop: (runId: string) => boolean
  bumpSessionRevision: Parameters<typeof startRun>[2]['bumpSessionRevision']
  remoteRunIds: Set<string>
  remoteRunLedgerIds: Map<string, string>
  mirrorSessionTranscript: Parameters<typeof startRun>[2]['mirrorSessionTranscript']
}

export function createRunPipeline(inputs: RunPipelineInputs) {
  const {
    rendererCanReceive, activeRunSessionKey, dockBadge, mainEventId, sourceControl, providerRegistry,
    resolveKnownProjectDirectory, resolveRemoteProjectDirectory, piRunDiagnostics, appSessionStore,
    providerOperationGate, providerContextKey, providerSessionKey, contextAdmission, resetSessionContext,
    sessionRevisionByContext, sessionByContext, sessionAliasesByContext, deletingSessions, conversationStore,
    assertLegacyConversationWriteAllowed, recordingBlockedSessions, homeDir, sessionDiffBaselines,
    recordingRecoveryHint, sessionBaselineKey, requestRunStop, bumpSessionRevision, remoteRunIds,
    remoteRunLedgerIds, mirrorSessionTranscript
  } = inputs
  // `startWorkspaceRun` is injected so a test can drive the pipeline without the
  // real front door; the recursion below stays on this module's own function.
  const workspaceStart = inputs.startWorkspaceRun
  const run = inputs.startRun

const traceRuntime = createTraceRuntime({ renderer: inputs.renderer, rendererCanReceive, activeRunSessionKey, dockBadge, mainEventId })
const {
  runs, runStopLifecycle, publishQuestionOpened, publishQuestionClosed,
  userQuestionBroker, traceOutput, flushTraceSend, boundedLiveRun, forgetBoundedRun,
  LIVE_TOOL_CONTENT_POLICY, publishTrace, runTraces
} = traceRuntime
const llmNetworkConfiguration = new LlmNetworkConfigurationCache()


function startAppRun(payload: AgentStartRequest, options?: AppRunStartOptions & { origin?: 'local' }): Promise<AgentStartResult>
function startAppRun(payload: AgentStartRequest, options?: AppRunStartOptions): Promise<AgentStartResult | RemoteRunCompletion>
async function startAppRun(payload: AgentStartRequest, options: AppRunStartOptions = {}): Promise<AgentStartResult | RemoteRunCompletion> {
  if (payload?.workspace !== undefined) return workspaceStart(payload, options, {
    sourceControl, providerRegistry, resolveKnownProjectDirectory,
    getCurrentCwd: inputs.getCurrentCwd, getStartupManagedRecovery: inputs.getStartupManagedRecovery,
    start: startAppRun
  })
  return run(payload, options, {
    providerRegistry, piRunDiagnostics, appSessionStore, resolveRemoteProjectDirectory, resolveKnownProjectDirectory,
    providerOperationGate, providerContextKey, providerSessionKey, contextAdmission,
    resetSessionContext, sessionRevisionByContext, sessionByContext, sessionAliasesByContext,
    runs, deletingSessions, conversationStore, assertLegacyConversationWriteAllowed,
    recordingBlockedSessions, homeDir, llmNetworkConfiguration, sessionDiffBaselines, publishTrace,
    rendererCanReceive, mainEventId, LIVE_TOOL_CONTENT_POLICY, recordingRecoveryHint, sessionBaselineKey,
    dockBadge, userQuestionBroker, publishQuestionOpened, publishQuestionClosed, requestRunStop,
    bumpSessionRevision, sourceControl, remoteRunIds, remoteRunLedgerIds, boundedLiveRun,
    forgetBoundedRun, mirrorSessionTranscript, flushTraceSend, runStopLifecycle, runTraces,
    isShuttingDown: inputs.isShuttingDown,
    getCurrentCwd: inputs.getCurrentCwd,
    getWindow: inputs.getWindow,
    getStartupManagedRecovery: inputs.getStartupManagedRecovery,
    nextRunSequence: inputs.nextRunSequence
  })
}
/** 远端分发的收据台账；键是 ledger 的 runId，与本地 IPC 的命令标识互不干扰。 */
const remoteStartReceipts = new CommandReceipts<RemoteRunCompletion>()

  return {
    ...traceRuntime,
    runs, runStopLifecycle, publishQuestionOpened, publishQuestionClosed, userQuestionBroker,
    traceOutput, flushTraceSend, boundedLiveRun, forgetBoundedRun, LIVE_TOOL_CONTENT_POLICY,
    publishTrace, runTraces, startAppRun, remoteStartReceipts, llmNetworkConfiguration
  }
}
