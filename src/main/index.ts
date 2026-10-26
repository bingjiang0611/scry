import { app, ipcMain, dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppRunStartOptions } from './bootstrap/run-frontdoor'
import { startRun } from './bootstrap/run-execution'
import { startWorkspaceRun } from './bootstrap/workspace-start'
import { createForkOperations } from './bootstrap/run-fork'
import { createSessionCatalog } from './bootstrap/session-catalog'
import { createHistoryRuntime } from './bootstrap/history-runtime'
import { createSessionState, mirrorSessionTranscript } from './bootstrap/session-state'
import { createRemoteConnections, configuredRemotePermissionMode } from './bootstrap/remote-connections'
import { resolveSessionRunIds } from './db'
import { SourceControlService } from './source-control/service'
import { registerSourceControlIpc } from './source-control/ipc'
import { registerWorkspaceSelectionIpc } from './source-control/workspace-ipc'
import { readUsageStats } from './usage-jsonl'
import { LlmNetworkConfigurationCache } from './llm-network-configuration'
import {
  normalizeAgentForkSessionRequest,
  type AgentForkSessionResult,
  type AgentStartRequest,
  type AgentStartResult
} from '../shared/runtime'
import { type ProviderContext, type ProviderId } from '../shared/provider'
import { providerOperationKey } from './provider-operation-gate'
import { CommandReceipts } from './command-receipts'
import { RemoteHostService } from './remote/remote-host-service'
import { registerDesktopClientIpc } from './remote/desktop-client-ipc'
import type { DesktopRemoteForkSessionRequest } from '../shared/desktop-remote'
import {
  canonicalExistingDirectory
} from './workspace-authorization'
import { assertTrustedIpcEvent as assertTrustedIpcEventForWindow, registerTrustedIpcHandler } from './ipc-trust'
import { listRemoteDirectories, resolveCanonicalRemoteProjectDirectory } from './remote/remote-directory-browser'
import type { ConversationServiceDeps } from './conversation-service'
import type { Conversation } from '../shared/conversation'
import type { ConversationDeletionPreview } from '../shared/conversation-api'
import { initializeAppEnvironment, registerAppLifecycle } from './bootstrap/app-lifecycle'
import { registerAgentRuntimeHandlers } from './bootstrap/agent-runtime-ipc'
import { createTraceRuntime } from './bootstrap/trace-runtime'
import { deleteConversationHistory } from './conversation-history'
import { createWindow as createBootstrapWindow } from './bootstrap/window'
import { createRendererRestartLog } from './bootstrap/renderer-restart'
import { ensureMcpExecutionAuthorized, authorizedMcpExecution } from './bootstrap/trust'
import { registerWorkspaceHandlers } from './bootstrap/workspace'
import { registerAppAgentHandlers } from './bootstrap/app-agent'
import { registerConversationHandlers } from './bootstrap/conversation'
import { createProviderRuntime } from './bootstrap/provider-runtime'
import { createWorkspaceRuntime } from './bootstrap/workspace-runtime'
import { createPiProfileRuntime } from './bootstrap/pi-profiles'
import { createTerminalRuntime } from './bootstrap/terminal-runtime'
import type { RemoteRunCompletion } from './remote/remote-run-binding'
import { registerSessionDeletionHandlers, type SessionDeletionRequest } from './bootstrap/session-deletion'
import { registerProviderHandlers } from './bootstrap/provider-handlers'
import { registerProjectHandlers } from './bootstrap/project-handlers'
import { registerRemoteHostHandlers, type RemoteHostRuntime } from './bootstrap/remote-host'

const __dirname = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null
const { rendererEntryUrl, useDevelopmentRenderer, isOwnedTestApp, primaryInstance } =
  initializeAppEnvironment(__dirname, () => win)
let runSeq = 0
let isShuttingDown = false
let startupManagedRecovery: Promise<void> = Promise.resolve()
const mainEventId = (prefix: string, runId: string): string => `${prefix}-${runId}-${randomUUID()}`

const {
  sessionByContext, sessionRevisionByContext, sessionAliasesByContext,
  sessionDiffBaselines, sessionBaselineKey, contextAdmission, recordingBlockedSessions,
  providerOperationGate, recordingRecoveryHint, deletingSessions, adoptingSessionKeys,
  providerContextKey, providerSessionKey, canonicalProviderCwd, withProviderOperation,
  dockBadge, activeRunSessionKey, bumpSessionRevision, resetSessionContext
} = createSessionState(() => win)
const historyRuntime = createHistoryRuntime()
const { invalidateSessionHistoryLoad } = historyRuntime

let currentCwd: string | undefined
function rendererCanReceive(): boolean {
  return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed())
}

const { terminalOutput, getTerminalManager, getTerminalManagerInstance } = createTerminalRuntime({
  userDataDir: app.getPath('userData'), getCurrentCwd: () => currentCwd, getHomeDir: () => homeDir,
  getWindow: () => win, rendererCanReceive
})
const { homeDir, homeFileAccess, recentStore, projectStore, rememberProject, knownProjectDirectories, resolveKnownProjectDirectory, remoteProjectRoots, resolveRemoteProjectDirectory } = createWorkspaceRuntime({
  appUserDataDir: app.getPath('userData'), loadSessions: () => appSessionStore().load()
})
const {
  appSessionStore, conversationStore, conversationService,
  assertLegacyConversationWriteAllowed, listProjectCatalog
} = createSessionCatalog({
  recentStore, projectStore, forkManagedConversation, startAppRun,
  getWindow: () => win,
  unsettledRuns: () => runs.unsettledStates(),
  getProviderRegistry: () => providerRegistry
})
const { piProfileStore, detectInstalledAgents, storedPiProfilesNotDetected, listPiProfiles, resolvePiProfile } = createPiProfileRuntime({ userDataDir: app.getPath('userData') })
const { providerCompatibility, providerRegistry, smokeProviderEnabled, smokeDetectedAgents } = createProviderRuntime({ homeDir, listPiProfiles, resolvePiProfile })

function setCurrentCwd(dir: string | undefined): void {
  // Selection is not process ownership. Existing shells retain their spawn cwd;
  // only explicit close or app shutdown terminates them. New starts still validate currentCwd.
  currentCwd = dir
}

// 注：原来扫 ~/.claude/projects 列举 transcript 的逻辑（readHeadPreview/readCwd/collectSessions）
// 已移除——app 只列自己起过的会话（见 app-sessions），不采集 terminal 裸跑的 claude。

const rendererAutoReloadCooldownMs = 60_000
// 崩溃重载会丢掉整棵 UI 树；把原因留给重载后的 renderer 读一次，避免界面假装“继续”。
const rendererRestart = createRendererRestartLog()

const createWindow = (): void => createBootstrapWindow({
  __dirname,
  rendererEntryUrl,
  useDevelopmentRenderer,
  isOwnedTestApp,
  getWindow: () => win,
  setWindow: (next) => { win = next },
  terminalOutput,
  traceOutput,
  dockBadge,
  isShuttingDown: () => isShuttingDown,
  rendererAutoReloadCooldownMs,
  rendererRestart
})

function assertTrustedIpcEvent(event: IpcMainInvokeEvent): void {
  assertTrustedIpcEventForWindow(event, win, rendererEntryUrl)
}

function handleTrusted<TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
): void {
  registerTrustedIpcHandler(ipcMain, channel, () => win, rendererEntryUrl, listener)
}

registerAppAgentHandlers({
  handleTrusted, getWindow: () => win, smokeProviderEnabled, smokeDetectedAgents,
  storedPiProfilesNotDetected, providerCompatibility, detectInstalledAgents, providerRegistry,
  dialog, piProfileStore, invalidateRemoteProviderMetadata, recentStore, canonicalExistingDirectory,
  invalidateSessionHistoryLoad, rememberProject, setCurrentCwd,
  resolveKnownProjectDirectory, getCurrentCwd: () => currentCwd
})

// one-shot：重载后的新 renderer 读一次即消费，正常启动不会继续报警。
handleTrusted('app:rendererRestart', () => rendererRestart.take())

async function openLocalPath(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

const sourceControl = new SourceControlService({
  userData: app.getPath('userData'),
  authorizeDirectory: resolveKnownProjectDirectory,
  unsettledDirectories: () => runs.unsettledStates().map(run => run.cwd),
  registeredWorkspaceRun: (runId, cwd) => runs.get(runId)?.state.cwd === cwd
})
registerSourceControlIpc(handleTrusted, sourceControl)
registerWorkspaceSelectionIpc(handleTrusted, sourceControl)
registerWorkspaceHandlers({
  handleTrusted,
  getCurrentCwd: () => currentCwd,
  setCurrentCwd,
  invalidateSessionHistoryLoad,
  resolveKnownProjectDirectory,
  homeFileAccess,
  knownProjectDirectories,
  openLocalPath,
  shell,
  dialog,
  getWindow: () => win,
  getTerminalManager,
  isShuttingDown: () => isShuttingDown,
  rendererCanReceive,
  assertTrustedIpcEvent,
  terminalOutput,
  providerRegistry,
  providerContextKey,
  resetSessionContext,
  dockBadge
})


const forkOperations = createForkOperations({
  resolveKnownProjectDirectory, providerRegistry, providerOperationGate, contextAdmission,
  providerContextKey, assertLegacyConversationWriteAllowed, resetSessionContext,
  sessionByContext, invalidateSessionHistoryLoad, appSessionStore, rememberProject,
  unsettledRuns: () => runs.unsettledStates(),
  getCurrentCwd: () => currentCwd,
  getStartupManagedRecovery: () => startupManagedRecovery
})
async function forkManagedConversation(input: Parameters<NonNullable<ConversationServiceDeps['forkNative']>>[0]): Promise<string> {
  return forkOperations.forkManagedConversation(input)
}
async function forkSessionWithAuthority(request: DesktopRemoteForkSessionRequest, authorize?: () => void): Promise<AgentForkSessionResult> {
  return forkOperations.forkSessionWithAuthority(request, authorize)
}

handleTrusted('agent:forkSession', async (_event, payload: unknown): Promise<AgentForkSessionResult> =>
  forkSessionWithAuthority(normalizeAgentForkSessionRequest(payload)))

registerProviderHandlers({
  handleTrusted, providerRegistry, withProviderOperation, getRemoteProviderDiscovery: () => remoteProviderDiscovery,
  refreshInvalidatedRemoteProviderMetadata, ensureMcpExecutionAuthorized, authorizedMcpExecution,
  homeDir, getCurrentCwd: () => currentCwd, getRuns: () => runs, canonicalProviderCwd,
  providerOperationKey, providerOperationGate
})

// 单目录会话列表（当前工作目录）：只列 app 自己起过的会话
handleTrusted('agent:listSessions', (_e, context: ProviderContext) => {
  return appSessionStore().listSessions(context.cwd ?? '', context.providerId, context.agentProfileId)
})

// 左侧栏项目目录独立于会话保留；老数据从 recent folders 与 app 会话 catalog 一次性补齐。
handleTrusted('agent:listProjects', () => listProjectCatalog())
handleTrusted('agent:catalogHealth', () => appSessionStore().health())

const conversationDeletion = { prepare: undefined as ((conversation: Conversation) => Promise<ConversationDeletionPreview>) | undefined }
const sessionDeletion = registerSessionDeletionHandlers({
  handleTrusted, getRuns: () => runs, appSessionStore, conversationStore, contextAdmission, getStartupManagedRecovery: () => startupManagedRecovery,
  providerContextKey, providerSessionKey, deletingSessions, sessionDiffBaselines, sessionBaselineKey, recordingBlockedSessions,
  getWindow: () => win, rendererCanReceive, appUserDataDir: app.getPath('userData'), isOwnedTestApp, requestRunStop,
  assertLegacyConversationWriteAllowed, sessionByContext, adoptingSessionKeys, dockBadge,
  prepareConversationDeletion: (conversation) => conversationDeletion.prepare!(conversation)
})
const { deleteOneSession, sessionRefFromRequest, changeLegacySessionMetadata } = sessionDeletion

const { prepareConversationDeletion } = registerConversationHandlers({
  handleTrusted, resolveKnownProjectDirectory, providerContextKey, contextAdmission, getStartupManagedRecovery: () => startupManagedRecovery,
  appSessionStore, conversationStore, getRuns: () => runs, providerRegistry, deletingSessions, adoptingSessionKeys,
  conversationService, invalidateSessionHistoryLoad, getWindow: () => win,
  deleteOneSession: (request, options) => deleteOneSession(request as SessionDeletionRequest, options as Parameters<typeof deleteOneSession>[1]),
  resolveSessionRunIds, deleteConversationHistory, appUserDataDir: app.getPath('userData'),
  providerSessionKey, assertLegacyConversationWriteAllowed, rememberProject
})

conversationDeletion.prepare = prepareConversationDeletion

registerProjectHandlers({ handleTrusted, projectStore, recentStore })

historyRuntime.register({
  handleTrusted, appSessionStore, sessionByContext, sessionAliasesByContext,
  providerContextKey, providerSessionKey, resolveKnownProjectDirectory, providerRegistry,
  getRuns: () => runs, dockBadge, setCurrentCwd, rememberProject,
  homeDir, userDataDir: app.getPath('userData'), isShuttingDown: () => isShuttingDown,
  getWindow: () => win, bumpSessionRevision
})


const traceRuntime = createTraceRuntime({
  getWindow: () => win, rendererCanReceive, activeRunSessionKey, dockBadge, mainEventId
})
const {
  runs, runStopLifecycle, publishQuestionOpened, publishQuestionClosed,
  userQuestionBroker, traceOutput, flushTraceSend, queueTrace, boundedLiveRun,
  LIVE_TOOL_CONTENT_POLICY
} = traceRuntime
const llmNetworkConfiguration = new LlmNetworkConfigurationCache()


function startAppRun(payload: AgentStartRequest, options?: AppRunStartOptions & { origin?: 'local' }): Promise<AgentStartResult>
function startAppRun(payload: AgentStartRequest, options?: AppRunStartOptions): Promise<AgentStartResult | RemoteRunCompletion>
async function startAppRun(payload: AgentStartRequest, options: AppRunStartOptions = {}): Promise<AgentStartResult | RemoteRunCompletion> {
  if (payload?.workspace !== undefined) return startWorkspaceRun(payload, options, {
    sourceControl, providerRegistry, resolveKnownProjectDirectory, rememberProject,
    getCurrentCwd: () => currentCwd, getStartupManagedRecovery: () => startupManagedRecovery,
    start: startAppRun
  })
  return startRun(payload, options, {
    providerRegistry, appSessionStore, resolveRemoteProjectDirectory, resolveKnownProjectDirectory,
    providerOperationGate, providerContextKey, providerSessionKey, contextAdmission,
    resetSessionContext, sessionRevisionByContext, sessionByContext, sessionAliasesByContext,
    runs, deletingSessions, conversationStore, assertLegacyConversationWriteAllowed,
    recordingBlockedSessions, homeDir, llmNetworkConfiguration, sessionDiffBaselines, queueTrace,
    rendererCanReceive, mainEventId, LIVE_TOOL_CONTENT_POLICY, recordingRecoveryHint, sessionBaselineKey,
    dockBadge, userQuestionBroker, publishQuestionOpened, publishQuestionClosed, requestRunStop,
    bumpSessionRevision, sourceControl, remoteRunIds, remoteRunLedgerIds, boundedLiveRun,
    mirrorSessionTranscript, flushTraceSend, runStopLifecycle,
    isShuttingDown: () => isShuttingDown,
    getCurrentCwd: () => currentCwd,
    getWindow: () => win,
    getStartupManagedRecovery: () => startupManagedRecovery,
    nextRunSequence: () => runSeq++
  })
}
/** 远端分发的收据台账；键是 ledger 的 runId，与本地 IPC 的命令标识互不干扰。 */
const remoteStartReceipts = new CommandReceipts<RemoteRunCompletion>()
registerAgentRuntimeHandlers({
  handleTrusted, startAppRun, runs, boundedLiveRun, dockBadge, activeRunSessionKey,
  userQuestionBroker, resolveKnownProjectDirectory, traceOutput, requestRunStop,
  getWindow: () => win,
  getCurrentCwd: () => currentCwd,
  getRemoteRunLedgerId: (runId) => remoteRunLedgerIds.get(runId),
  getRemoteHostService: () => remoteHostService
})

// Shared by the Mac stop button and a paired device stopping a Mac run.
function requestRunStop(runId: string): boolean {
  return traceRuntime.requestRunStop(runId)
}

// Device-started runs live in the same RunRegistry as Mac runs, so every Mac and
// remote-history reader sees one active-run truth: history while the first turn
// is still running, the Mac sidebar/session view, stop, and same-session
// conflicts. They are never auto-focused. Their questions remain owned by the
// remote broker, while the canonical RunRegistry state mirrors pending UI.
const remoteRunIds = new Set<string>()
// scry runId -> durable ledger runId, the key of the remote question broker.
const remoteRunLedgerIds = new Map<string, string>()
// B2-lite：累计用量统计（读 usage.jsonl 聚合）
handleTrusted('agent:usageStats', (_event, context?: ProviderContext) =>
  readUsageStats(app.getPath('userData'), context ? {
    providerId: context.providerId,
    agentProfileId: context.agentProfileId,
    cwd: context.cwd ?? ''
  } : {})
)

// Remote-access subsystem (iOS control client). Packaged builds start it against
// the official public relay; development remains opt-in and SCRY_REMOTE_HOST=0
// is an explicit kill switch. The relay only sees opaque inner-mTLS bytes.
let remoteHostService: RemoteHostService | null = null
const remoteConnections = createRemoteConnections({
  providerRegistry, listPiProfiles, resolvePiProfile, resolveRemoteProjectDirectory,
  withProviderOperation, remoteProjectRoots, hasRemoteHost: () => remoteHostService !== null
})
const { requireDesktopRemoteClient, remoteProviderDiscovery, refreshRemoteProviderSnapshot } = remoteConnections
registerDesktopClientIpc(handleTrusted, requireDesktopRemoteClient)
let remoteProviderRefresh: ReturnType<typeof setInterval> | undefined

function invalidateRemoteProviderMetadata(providerId: ProviderId): void {
  remoteConnections.invalidateRemoteProviderMetadata(providerId)
}
function refreshInvalidatedRemoteProviderMetadata(): void {
  remoteConnections.refreshInvalidatedRemoteProviderMetadata()
}

const remoteHostRuntime: RemoteHostRuntime = {
  get remoteHostService() { return remoteHostService },
  set remoteHostService(value) { remoteHostService = value },
  get remoteProviderRefresh() { return remoteProviderRefresh },
  set remoteProviderRefresh(value) { remoteProviderRefresh = value },
  getRemoteProviderDiscovery: () => remoteProviderDiscovery,
  refreshRemoteProviderSnapshot,
  configuredRemotePermissionMode,
  remoteStartReceipts,
  startAppRun,
  sourceControl,
  providerOperationGate,
  providerRegistry,
  runs,
  requestRunStop,
  forkSessionWithAuthority,
  deleteOneSession,
  sessionRefFromRequest,
  changeLegacySessionMetadata,
  appSessionStore,
  knownProjectDirectories,
  remoteProjectRoots,
  resolveRemoteProjectDirectory,
  resolveCanonicalRemoteProjectDirectory,
  listRemoteDirectories,
  rememberProject,
  remoteRunIds,
  userQuestionBroker,
  withProviderOperation,
  providerContextKey,
  boundedLiveRun,
  getCurrentCwd: () => currentCwd,
  homeDir,
  openLocalPath,
  desktopRemoteClient: requireDesktopRemoteClient,
  get isShuttingDown() { return isShuttingDown }
}



registerRemoteHostHandlers(handleTrusted, remoteHostRuntime)

registerAppLifecycle({
  primaryInstance, useDevelopmentRenderer, dockBadge, createWindow, traceOutput, runs,
  remoteHostRuntime, requireDesktopRemoteClient, conversationStore, terminalOutput,
  getTerminalManagerInstance, runStopLifecycle, sessionDiffBaselines, userQuestionBroker,
  mirrorSessionTranscript, providerRegistry, sourceControl,
  setStartupManagedRecovery: (recovery) => { startupManagedRecovery = recovery },
  beginShutdown: () => { isShuttingDown = true },
  getRemoteHostService: () => remoteHostService,
  getDesktopRemoteClient: remoteConnections.getDesktopRemoteClient
})
