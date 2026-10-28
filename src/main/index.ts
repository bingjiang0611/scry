import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  detectAgentsFast,
  shellEnv,
  warmShellEnv
} from './claude-locate'

import { recordTurn, setBillingEnvProvider } from './db'
import { SessionDiffBaselineRegistry } from './session-diff'
import { readTraceArchiveAsync } from './transcript-archive'
import { mergeSessionTurns } from './session-history'
import { invalidateSessionHistoryLoad as invalidateSessionHistory, type SessionHistoryState } from './session-history-ipc'
import {
  createAppSessionStore,
} from './app-store'
import { isMcpGuardReport } from '../shared/mcpguard-report'
import { appendUsage } from './usage-jsonl'
import { LlmNetworkConfigurationCache } from './llm-network-configuration'
import {
  providerIdForAgentId,
  type AgentStartRequest
} from '../shared/runtime'
import { capabilityUnavailable } from '../shared/provider'

import { isSafeOAuthAuthorizationUrl, prepareOAuthLoopback } from './oauth-loopback'
import { ProviderOperationGate, providerOperationKey } from './provider-operation-gate'
import { verifyForkArchiveBoundary } from './session-fork'
import { appendCoalescedTrace } from './live-trace'
import { performanceRecordingEnabled } from './performance-timing'
import { recordRendererPerformance } from './performance-recording'
import { persistTraceToolEvents, TRACE_TOOL_CONTENT_POLICY } from './trace-tool-content'
import { LIVE_TOOL_CONTENT_POLICY } from './main-run-observation'
import type { RemoteRunCompletion } from './remote/remote-run-binding'
import { type AppRunStartOptions } from './app-run-start'
import { settleSuccessfulAppRun } from './app-run-terminal-success'
import { settleFailedAppRun } from './app-run-terminal-failure'
import { startAppRunAdmission } from './app-run-admission'
import { executeAppRun } from './app-run-execution-context'
import { recoverAppRunRecording } from './app-run-recording-recovery'
import { prepareAppRunEditLastTurn } from './app-run-edit-last-turn'
import { assertWorkflowAuthoringIdentity, assertWorkflowAuthoringStart } from './workflow-authoring'
import { archiveTraceTurn, persistTerminalProgress } from './app-turn-archive'
import { DockBadgeState } from './dock-badge'
import { archiveSessionId } from './session-id'
import { archiveSessionAndStop } from './session-archive'
import {
  canonicalExistingDirectory
} from './workspace-authorization'
import { assertTrustedIpcEvent as assertTrustedIpcEventForWindow, registerTrustedIpcHandler } from './ipc-trust'
import { resolveWorkflowTemplateEdit } from './workflow-template-command'
import { providerRecordingPolicy } from './provider-recording-policy'
import { resolveRendererEntryUrl } from './renderer-security'
import { buildMcpExecutionSnapshot } from './mcp-execution-trust'
import { updateRunAttachmentOwner } from './attachment-store'
import { createArchiveHelpers, observedTurnTiming, createForkManagedConversation, createLegacyConversationWriteGuard, registerMainSessionIpcFromInfrastructure } from './main-session-ipc'
import { createMainInfrastructureRuntime } from './main-entry-runtime'
import { createMainDesktopRemoteState, createMainWindowFactory, openMainLocalPath, registerMainDesktopIpc } from './main-desktop-ipc'
import { createMainRunRuntime, createMainRunStopControls, registerMainWorkflowIpc } from './main-workflow-ipc'
import { submitDesktopConversation } from './desktop-conversation-submission'
import { conversationItemsFromTrace, readConversationHistoryItem } from './conversation-history'
import { ensureFailedTerminalResult, terminalOutcomeLabel } from './run-outcome'
import { runTerminationHint } from '../shared/runtime'
import { classifyError } from './error-classify'
import {
  ContextAdmission,
  expectedRestartSourceMatches,
  expectedSessionMatches,
  runConflictsWithSession,
  waitForCompletedRuns
} from './context-admission'

for (const k of Object.keys(process.env)) {
  if (k === 'CLAUDECODE' || k === 'AI_AGENT' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_')) {
    delete process.env[k]
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const packagedRendererEntryUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
const rendererEntryUrl = resolveRendererEntryUrl(
  process.env.ELECTRON_RENDERER_URL,
  packagedRendererEntryUrl,
  app.isPackaged
)
const useDevelopmentRenderer = rendererEntryUrl !== packagedRendererEntryUrl
let win: BrowserWindow | null = null
let runSeq = 0
let isShuttingDown = false
const isOwnedTestApp = process.env.SCRY_TEST_APP === '1'
const disabledChromiumFeatures = app.commandLine.getSwitchValue('disable-features')
app.commandLine.appendSwitch('disable-features',
  [disabledChromiumFeatures, 'AccessibilityBlockFlowIterator'].filter(Boolean).join(','))
if (isOwnedTestApp && process.platform === 'darwin') app.setActivationPolicy('prohibited')
const mainEventId = (prefix: string, runId: string): string => `${prefix}-${runId}-${randomUUID()}`
let startupManagedRecovery: Promise<void> = Promise.resolve()
const primaryInstance = isOwnedTestApp || app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (isOwnedTestApp || !win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}
setBillingEnvProvider(shellEnv)

const sessionByContext = new Map<string, string>()
const sessionHistoryState: SessionHistoryState = { revision: 0, abortController: null, cache: null }
function invalidateSessionHistoryLoad(reason: string): void {
  invalidateSessionHistory(sessionHistoryState, reason)
}
const sessionRevisionByContext = new Map<string, number>()
const sessionAliasesByContext = new Map<string, Map<string, string>>()

const sessionDiffBaselines = new SessionDiffBaselineRegistry()
const sessionBaselineKey = (context: string, sessionId: string): string => JSON.stringify([context, 'session', sessionId])
const contextAdmission = new ContextAdmission()
const recordingBlockedSessions = new Map<string, string>()
const providerOperationGate = new ProviderOperationGate()
const recordingRecoveryHint = '不要开始下一轮；保留 userData/trace-turn-progress、managed-turn-progress、managed-turn-commits 与 workspace/.scry 后重试恢复'
const deletingSessions = new Set<string>()
let currentCwd: string | undefined
function rendererCanReceive(): boolean {
  return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed())
}

const homeDir = homedir()
let appSessionStoreInstance: ReturnType<typeof createAppSessionStore> | undefined
const appSessionStore = () => appSessionStoreInstance ??= createAppSessionStore(app.getPath('userData'))
const infrastructure = createMainInfrastructureRuntime({
  homeDir, getUserData: () => app.getPath('userData'), getVersion: () => app.getVersion(), isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath, appPath: app.getAppPath(), getCurrentCwd: () => currentCwd, rendererCanReceive, getWindow: () => win,
  providerOperationGate, shellEnv, appSessionStore, providerIdForAgentId, canonicalExistingDirectory,
  forkNative: forkManagedConversation, startAppRun, readConversationHistoryItem, readTraceArchive: readTraceArchiveAsync, mergeSessionTurns,
  unsettledDirectories: () => runs.unsettledStates().map(run => run.cwd), sessionByContext, sessionAliasesByContext, sessionRevisionByContext
})
const { terminalRuntime, homeFileAccess, catalogRuntime, conversationRuntime, desktopTaskEntry, providerRuntime, sourceControl, activeRunSessionKey, bumpSessionRevision, resetSessionContext } = infrastructure
const { terminalOutput, getTerminalManager, terminalManager } = terminalRuntime
const { rememberProject, knownProjectDirectories, resolveKnownProjectDirectory,
  resolveTemplateProjectDirectory, remoteProjectRoots, resolveRemoteProjectDirectory,
  listPiProfiles } = catalogRuntime
const { conversationStore } = conversationRuntime
const assertLegacyConversationWriteAllowed = createLegacyConversationWriteGuard({ unsettledRuns: () => runs.unsettledStates(), conversationStore })
const { providerRegistry,
  providerContextKey, withProviderOperation, canonicalProviderCwd, providerSessionKey,
  resolveCodexHookTrust, resolveOpenCodePluginTrust, withoutCommitHookCapability, resolveManagedCommitHookEnv,
  resolveGrantedManagedCommitHookEnv, ensureMcpExecutionAuthorized, authorizedMcpExecution } = providerRuntime
let badgePermissionWarningShown = false
const dockBadge = new DockBadgeState((count) => {
  if (app.setBadgeCount(count) || process.platform !== 'darwin' || badgePermissionWarningShown) return
  badgePermissionWarningShown = true
  console.warn('[scry] macOS Dock badge permission is unavailable')
}, (snapshot) => {
  try { win?.webContents.send('agent:unreadSessions', snapshot) }
  catch (error) { console.warn('[scry] unread session notification failed:', error) }
})
function setCurrentCwd(dir: string | undefined): void {
  currentCwd = dir
}

function createWindow(): void {
  createMainWindowFactory({ dirname: __dirname, rendererEntryUrl, useDevelopmentRenderer, isOwnedTestApp, isShuttingDown: () => isShuttingDown, getWindow: () => win, setWindow: value => { win = value }, dockBadge, terminalOutput, traceOutput })()
}
function assertTrustedIpcEvent(event: IpcMainInvokeEvent): void {
  assertTrustedIpcEventForWindow(event, win, rendererEntryUrl)
}

function handleTrusted<TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
): void {
  registerTrustedIpcHandler(ipcMain, channel, () => win, rendererEntryUrl, listener)
}

const openLocalPath = openMainLocalPath
const { cloneForkArchiveTurns, mirrorSessionTranscript } = createArchiveHelpers(() => app.getPath('userData'))

function forkManagedConversation(input: Parameters<ReturnType<typeof createForkManagedConversation>>[0]): ReturnType<ReturnType<typeof createForkManagedConversation>> {
  return createForkManagedConversation({ resolveKnownProjectDirectory, providerRegistry, providerOperationGate, providerContextKey, contextAdmission, runs, readTraceArchive: readTraceArchiveAsync, verifyForkArchiveBoundary, resolveCodexHookTrust, ensureMcpExecutionAuthorized, authorizedMcpExecution, getUserData: () => app.getPath('userData') })(input)
}

const { sessionRefFromRequest, changeLegacySessionMetadata } = registerMainSessionIpcFromInfrastructure({
  handleTrusted,
  initialContext: { providerRuntime, catalogRuntime, ui: { window: () => win, nativeTheme, clipboard, performanceRecordingEnabled, recordRendererPerformance, dialog, detectFast: detectAgentsFast, canonicalExistingDirectory, invalidateSessionHistoryLoad, dockBadge, openLocalPath, homeFileAccess, shell, sourceControl: handleTrusted, sourceControlService: sourceControl, assertTrustedIpcEvent, terminalOutput, getTerminalManager }, currentCwd: () => currentCwd, isShuttingDown: () => isShuttingDown, rendererCanReceive, setCurrentCwd, resetSessionContext },
  historyState: sessionHistoryState,
  infrastructure: { providerRuntime, catalogRuntime, conversationRuntime, desktopTaskEntry },
  state: {
    providerOperationGate, appSessionStore, currentCwd: () => currentCwd, contextAdmission, startupManagedRecovery: () => startupManagedRecovery,
    assertLegacyConversationWriteAllowed, readTraceArchive: readTraceArchiveAsync, resolveCodexHookTrust, resolveOpenCodePluginTrust,
    ensureMcpExecutionAuthorized, userDataDir: () => app.getPath('userData'), cloneForkArchiveTurns,
    resetSessionContext, setSessionForContext: (key, sessionId) => sessionByContext.set(key, sessionId), invalidateSessionHistoryLoad,
    activeRuns: () => runs.activeStates(), requestRunStop: runId => requestRunStop(runId),
    submitDesktopConversation: (conversation, request) => submitDesktopConversation(conversation, request, { editTemplate: (workspace, target) => resolveWorkflowTemplateEdit(workflowComposition.workflowTemplates, workspace, target), entry: desktopTaskEntry, templateTasks: workflowComposition.desktopWorkflowTasks, editTasks: workflowComposition.desktopWorkflowTasks, setSizeGuideline: value => workflowComposition.workflowService.setSizeGuideline(value), setWorkflowMode: (id, expectedRevision, mode) => conversationStore().updateMetadata(id, expectedRevision, { kind: 'workflow_mode', mode }), routeWorkflow: (conversation, input) => workflowComposition.workflowService.routeCommand({ command: input.prompt, commandId: input.commandId, workspace: conversation.cwd, routingMode: input.routingMode, orchestrator: { role: 'orchestrator', providerId: input.providerId, ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}) }, roles: [] }) }),
    getStartupManagedRecovery: () => startupManagedRecovery, runInContext: (key, action) => contextAdmission.run(key, action), runInContexts: (keys, action) => contextAdmission.runMany(keys, action), unsettledRuns: () => runs.unsettledStates(), loadAppSessions: () => appSessionStore().load(), isDeletingSession: key => deletingSessions.has(key), userData: () => app.getPath('userData'), sendConversationChanged: conversationId => win?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId }),
    dialog, window: () => win, isOwnedTestApp, showItemInFolder: cwd => shell.showItemInFolder(cwd), deletingSessions, sessionByContext, sessionDiffBaselines, sessionBaselineKey, recordingBlockedSessions, dockBadge, rendererCanReceive, sendDataUpdated: payload => win?.webContents.send('agent:dataUpdated', payload), homeDir, isShuttingDown: () => isShuttingDown, runs: () => runs, isWindowFocused: () => Boolean(win?.isFocused()), setCurrentCwd, sessionAliasesByContext, bumpSessionRevision
  }
})

const llmNetworkConfiguration = new LlmNetworkConfigurationCache()
const desktopRemoteState = createMainDesktopRemoteState(() => app.getPath('userData'))
const { remoteRunIds, remoteRunLedgerIds } = desktopRemoteState
const runRuntime = createMainRunRuntime({ dockBadge, getWindow: () => win, rendererCanReceive, mainEventId, activeRunSessionKey, appendTrace: appendCoalescedTrace })
const { runs, runStopLifecycle, userQuestionBroker, traceOutput, publishQuestionOpened, publishQuestionClosed, flushTraceSend, queueTrace, boundedLiveRun } = runRuntime
const { requestRunStop, requestRunStopAgain } = createMainRunStopControls({ runs, runStopLifecycle, cancelQuestions: runId => userQuestionBroker.cancelRun(runId) })

async function startAppRun(payload: AgentStartRequest, options: AppRunStartOptions = {}): Promise<{ runId: string } | RemoteRunCompletion> {
  return startAppRunAdmission({
    providerRegistry, workflowSystems, resolveTemplateProjectDirectory, resolveRemoteProjectDirectory, resolveKnownProjectDirectory, currentCwd, canonicalExistingDirectory, appSessionStore, providerOperationKey, providerOperationGate, providerContextKey, contextAdmission, startupManagedRecovery, sessionRevisionByContext, sessionByContext, sessionAliasesByContext, deletingSessions, runs, expectedRestartSourceMatches, expectedSessionMatches, runConflictsWithSession, waitForCompletedRuns, providerSessionKey, conversationStore, assertLegacyConversationWriteAllowed, recoverAppRunRecording, resolveManagedCommitHookEnv, recordingBlockedSessions, resolveCodexHookTrust, resolveOpenCodePluginTrust, ensureMcpExecutionAuthorized, prepareAppRunEditLastTurn, authorizedMcpExecution, sessionBaselineKey, randomUUID, nextRunId: () => `run-${Date.now().toString(36)}-${runSeq++}`, isShuttingDown, warmShellEnv, resolveWorkflowAuthoringStart: assertWorkflowAuthoringStart, traceToolContentPolicy: TRACE_TOOL_CONTENT_POLICY, recordingRecoveryHint, resetSessionContext, cloneForkArchiveTurns
  }, payload, options, state => executeAppRun(state, {
    sessionBaselineKey, llmNetworkConfiguration, homeDir,
    recordTurn, appSessionStore, win, rendererCanReceive, runs, queueTrace,
    persistTraceToolEvents, getUserData: () => app.getPath('userData'), mainEventId,
    liveToolContentPolicy: LIVE_TOOL_CONTENT_POLICY, appendTrace: appendCoalescedTrace,
    sessionDiffBaselines, dockBadge, providerRegistry, conversationStore,
    assertLegacyConversationWriteAllowed, workflowRunControls, authorizedMcpExecution,
    assertWorkflowAuthoringIdentity, userQuestionBroker, publishQuestionOpened,
    publishQuestionClosed, remoteRunIds, remoteRunLedgerIds, requestRunStop,
    flushTraceSend, recordingRecoveryHint, recordingBlockedSessions,
    updateRunAttachmentOwner, appendUsage, ensureFailedTerminalResult, runTerminationHint,
    classifyError, terminalOutcomeLabel, persistTerminalProgress, archiveTraceTurn,
    settleSuccessfulAppRun, settleFailedAppRun, mirrorSessionTranscript, observedTurnTiming,
    providerRecordingPolicy, archiveSessionId, runStopLifecycle, sessionRevisionByContext,
    sessionByContext, sessionAliasesByContext, bumpSessionRevision, sourceControl, boundedLiveRun,
    conversationItemsFromTrace
  })
  )
}

const workflowComposition = registerMainWorkflowIpc({
  handleTrusted,
  userData: app.getPath('userData'),
  providerRegistry,
  providerContextKey,
  providerContinuationKey: context => providerRegistry.continuationKey(context),
  withProviderOperation,
  startAppRun,
  requestRunStop,
  requestRunStopAgain,
  resolveTemplateProjectDirectory,
  rendererCanReceive,
  sendProgress: progress => { if (rendererCanReceive()) win?.webContents.send('workflow:progress', progress) },
  currentCwd: () => currentCwd,
  canonicalExistingDirectory,
  remoteRunLedgerIds,
  remoteHost: desktopRemoteState.getRemoteHost,
  conversationStore,
  desktopTaskEntry,
  run: { runs, boundedLiveRun, activeRunSessionKey, dockBadge, window: () => win, userQuestionBroker, traceOutput, requestRunStop },
  userDataDir: () => app.getPath('userData'),
  resolveKnownProjectDirectory,
  recorder: {},
  analytics: {}
})
const { workflowService, workflowSystems, workflowRunControls } = workflowComposition

registerMainDesktopIpc({
  handleTrusted,
  state: desktopRemoteState,
  userDataDir: () => app.getPath('userData'),
  isShuttingDown: () => isShuttingDown,
  providerRegistry,
  listPiProfiles,
  remoteProjectRoots,
  knownProjectDirectories,
  resolveRemoteProjectDirectory,
  sourceControl,
  openLocalPath,
  rememberProject,
  providerOperationGate,
  remoteStartReceipts: workflowComposition.remoteStartReceipts,
  startAppRun,
  requestRunStop,
  appSessionStore,
  sessionRefFromRequest,
  changeLegacySessionMetadata,
  archiveSessionAndStop,
  runs,
  userQuestionBroker,
  withProviderOperation,
  providerContextKey,
  boundedLiveRun,
  mcp: { withProviderOperation, providerRegistry, runs, ensureMcpExecutionAuthorized, authorizedMcpExecution, buildMcpExecutionSnapshot, homeDir, shellEnv, shell, isSafeOAuthAuthorizationUrl, prepareOAuthLoopback, isMcpGuardReport, capabilityUnavailable, canonicalProviderCwd, providerOperationKey, providerOperationGate },
  lifecycle: {
    primaryInstance,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    useDevelopmentRenderer,
    getUserData: () => app.getPath('userData'),
    getWindow: () => win,
    createWindow,
    setShuttingDown: value => { isShuttingDown = value },
    setStartupRecovery: value => { startupManagedRecovery = value },
    dockBadge,
    traceOutput,
    runs,
    terminalOutput,
    terminalManager,
    runStopLifecycle,
    sessionDiffBaselines,
    providerRegistry,
    sourceControl,
    conversationStore,
    workflowService,
    resolveGrantedManagedCommitHookEnv,
    mirrorSessionTranscript: (providerId, cwd, sessionId) => providerId ? mirrorSessionTranscript(providerId, cwd, sessionId) : Promise.resolve(),
    userQuestionBroker,
    withoutCommitHookCapability
  }
})
