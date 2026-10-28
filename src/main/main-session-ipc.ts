import type { IpcMainInvokeEvent } from 'electron'
import type { createMainProviderRuntime } from './main-provider-runtime'
import type { createMainCatalogRuntime } from './main-catalog-runtime'
import type { createAppConversationRuntime } from './conversation-app-runtime'
import type { createDesktopTaskEntry } from './desktop-task-entry'
import { mirrorTranscript } from './transcript-archive'
import type { ProviderId } from '../shared/provider'
import type { ManagedTurnTiming } from '../core/turn-recorder/managed'
import { cloneForkArchiveTurns as cloneForkArchiveTurnsInRuntime } from './main-fork-archive'
import { forkManagedConversation as forkManagedConversationInRuntime } from './main-fork-conversation'
import type { NativeSessionScope } from './conversation-store'
import { registerMainInitialIpc, type MainInitialIpcDeps } from './main-initial-ipc'
import { registerSessionForkIpc } from './session-fork-ipc'
import { registerSessionCatalogIpc } from './session-catalog-ipc'
import { registerConversationIpc, type ConversationAppIpcDependencies } from './conversation-app-ipc'
import { registerSessionDeletionIpc } from './session-deletion-ipc'
import { registerSessionHistoryLoadIpc, type SessionHistoryIpcDeps, type SessionHistoryState } from './session-history-ipc'
import { registerSessionHistoryOlderIpc, type SessionHistoryOlderIpcDeps } from './session-history-older-ipc'

export function createForkManagedConversation(deps: Parameters<typeof forkManagedConversationInRuntime>[1]): (input: Parameters<typeof forkManagedConversationInRuntime>[0]) => ReturnType<typeof forkManagedConversationInRuntime> {
  return input => forkManagedConversationInRuntime(input, deps)
}

export function createLegacyConversationWriteGuard(deps: {
  unsettledRuns: () => Array<{ providerId?: string; agentProfileId?: string; cwd?: string; runId: string }>
  conversationStore: () => { list: (cwd: string | undefined) => Promise<Array<{ turns: Array<{ runId?: string }> }>>; assertLegacyWriteAllowed: (scope: NativeSessionScope, deletion?: { ownerId?: string }) => Promise<void> }
}): (scope: NativeSessionScope, deletion?: { ownerId?: string }) => Promise<void> {
  return async (scope, deletion) => {
    const activeIds = new Set(deps.unsettledRuns().filter(run => run.providerId === scope.providerId && run.agentProfileId === scope.agentProfileId && (run.cwd ?? '') === scope.cwd).map(run => run.runId))
    if (activeIds.size && (await deps.conversationStore().list(scope.cwd)).some(conversation => conversation.turns.some(turn => turn.runId && activeIds.has(turn.runId)))) throw new Error('统一对话仍在执行或保存证据，不能从旧入口写入；请等待本轮收敛')
    await deps.conversationStore().assertLegacyWriteAllowed(scope, deletion)
  }
}

export function createArchiveHelpers(userDataDir: () => string): {
  cloneForkArchiveTurns: (args: Parameters<typeof cloneForkArchiveTurnsInRuntime>[0]) => void
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
} {
  return {
    cloneForkArchiveTurns: args => cloneForkArchiveTurns(args, userDataDir),
    mirrorSessionTranscript: (providerId, cwd, sessionId) => mirrorSessionTranscript(providerId, cwd, sessionId, userDataDir)
  }
}

export function cloneForkArchiveTurns(args: Parameters<typeof cloneForkArchiveTurnsInRuntime>[0], userDataDir: () => string): void {
  cloneForkArchiveTurnsInRuntime(args, { getUserData: userDataDir })
}

export async function mirrorSessionTranscript(providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined, userDataDir: () => string): Promise<void> {
  if (providerId !== 'claude' || !cwd || !sessionId) return
  try {
    const ok = await mirrorTranscript({ cwd, sessionId, userDataDir: userDataDir() })
    if (!ok) console.warn('[scry] transcript mirror skipped:', cwd, sessionId)
  } catch (error) {
    console.warn('[scry] transcript mirror failed:', cwd, sessionId, error)
  }
}

export function observedTurnTiming(startedAt: string | undefined, completedAt: string): ManagedTurnTiming | undefined {
  if (!startedAt) return undefined
  const started = Date.parse(startedAt)
  const completed = Date.parse(completedAt)
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return undefined
  return { startedAt, completedAt, durationMs: Math.max(0, completed - started) }
}

export type MainTrustedIpcHandler = <TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
) => void

type Initial = MainInitialIpcDeps

type InitialApp = Omit<Initial['app'], 'handleTrusted'>
type InitialProviderDiscovery = Omit<Initial['providerDiscovery'], 'handleTrusted'>
type InitialAgentContext = Omit<Initial['agentContext'], 'handleTrusted'>
type InitialWorkspace = Omit<Initial['workspace'], 'handleTrusted'>
type InitialTerminal = Omit<Initial['terminal'], 'handleTrusted'>
type SessionFork = Omit<Parameters<typeof registerSessionForkIpc>[0], 'handleTrusted'>
type SessionCatalog = Omit<Parameters<typeof registerSessionCatalogIpc>[0], 'handleTrusted'>
type SessionDeletion = Omit<Parameters<typeof registerSessionDeletionIpc>[0], 'handleTrusted' | 'prepareConversationDeletion'>
type SessionHistory = Omit<SessionHistoryIpcDeps, 'register'>
type SessionHistoryOlder = Omit<SessionHistoryOlderIpcDeps, 'register'>
type Conversation = Omit<ConversationAppIpcDependencies, 'register' | 'deleteOneSession'>

export interface MainSessionInitialContext {
  providerRuntime: ReturnType<typeof createMainProviderRuntime>
  catalogRuntime: ReturnType<typeof createMainCatalogRuntime>
  ui: {
    window: InitialApp['window']
    nativeTheme: InitialApp['nativeTheme']
    clipboard: InitialApp['clipboard']
    performanceRecordingEnabled: InitialApp['performanceRecordingEnabled']
    recordRendererPerformance: InitialApp['recordRendererPerformance']
    dialog: InitialWorkspace['dialog']
    detectFast: InitialProviderDiscovery['detectFast']
    canonicalExistingDirectory: InitialAgentContext['canonicalExistingDirectory']
    invalidateSessionHistoryLoad: InitialAgentContext['invalidateSessionHistoryLoad']
    dockBadge: InitialAgentContext['dockBadge']
    openLocalPath: InitialWorkspace['openLocalPath']
    homeFileAccess: InitialWorkspace['homeFileAccess']
    shell: InitialWorkspace['shell']
    sourceControl: Initial['sourceControl']
    sourceControlService: Initial['sourceControlService']
    assertTrustedIpcEvent: InitialTerminal['assertTrustedIpcEvent']
    terminalOutput: InitialTerminal['terminalOutput']
    getTerminalManager: InitialTerminal['getTerminalManager']
  }
  currentCwd: () => string | undefined
  isShuttingDown: () => boolean
  rendererCanReceive: () => boolean
  setCurrentCwd: (dir: string | undefined) => void
  resetSessionContext: (key: string) => void
}

export interface MainSessionIpcDeps {
  handleTrusted: MainTrustedIpcHandler
  initial: {
    app: InitialApp
    providerDiscovery: InitialProviderDiscovery
    agentContext: InitialAgentContext
    sourceControl: Initial['sourceControl']
    sourceControlService: Initial['sourceControlService']
    workspace: InitialWorkspace
    terminal: InitialTerminal
  }
  fork: SessionFork
  catalog: SessionCatalog
  conversation: Conversation
  deletion: SessionDeletion
  historyState: SessionHistoryState
  history: SessionHistory
  historyOlder: SessionHistoryOlder
}

function initialFromContext(context: MainSessionInitialContext): MainSessionIpcDeps['initial'] {
  const { providerRuntime: p, catalogRuntime: c, ui, currentCwd, isShuttingDown, rendererCanReceive, setCurrentCwd, resetSessionContext } = context
  return {
    app: { window: ui.window, nativeTheme: ui.nativeTheme, clipboard: ui.clipboard, performanceRecordingEnabled: ui.performanceRecordingEnabled, recordRendererPerformance: ui.recordRendererPerformance },
    providerDiscovery: { providerRegistry: p.providerRegistry, providerCompatibility: p.providerCompatibility, smokeProviderEnabled: p.smokeProviderEnabled, smokeDetectedAgents: p.smokeDetectedAgents, detectFast: ui.detectFast, storedPiProfilesNotDetected: c.storedPiProfilesNotDetected, piProfileStore: c.piProfileStore, dialog: ui.dialog, window: ui.window, currentCwd },
    agentContext: { providerRegistry: p.providerRegistry, withProviderOperation: p.withProviderOperation, recentStore: c.recentStore, dialog: ui.dialog, clipboard: ui.clipboard, canonicalExistingDirectory: ui.canonicalExistingDirectory, invalidateSessionHistoryLoad: ui.invalidateSessionHistoryLoad, rememberProject: c.rememberProject, setCurrentCwd, currentCwd, resolveKnownProjectDirectory: c.resolveKnownProjectDirectory, dockBadge: ui.dockBadge, window: ui.window, providerContextKey: p.providerContextKey, resetSessionContext },
    sourceControl: ui.sourceControl,
    sourceControlService: ui.sourceControlService,
    workspace: { currentCwd, homeFileAccess: ui.homeFileAccess, resolveKnownProjectDirectory: c.resolveKnownProjectDirectory, knownProjectDirectories: c.knownProjectDirectories, window: ui.window, dialog: ui.dialog, openLocalPath: ui.openLocalPath, shell: ui.shell },
    terminal: { assertTrustedIpcEvent: ui.assertTrustedIpcEvent, rendererCanReceive, terminalOutput: ui.terminalOutput, getTerminalManager: ui.getTerminalManager, currentCwd, isShuttingDown }
  }
}

type SessionBindings = MainSessionIpcDeps['fork'] & MainSessionIpcDeps['catalog'] & MainSessionIpcDeps['conversation'] & MainSessionIpcDeps['deletion'] & MainSessionIpcDeps['history'] & MainSessionIpcDeps['historyOlder']

type SessionRegistrationState = Pick<SessionBindings, 'providerOperationGate' | 'currentCwd' | 'contextAdmission' | 'startupManagedRecovery' | 'assertLegacyConversationWriteAllowed' | 'readTraceArchive' | 'resolveCodexHookTrust' | 'resolveOpenCodePluginTrust' | 'ensureMcpExecutionAuthorized' | 'userDataDir' | 'cloneForkArchiveTurns' | 'resetSessionContext' | 'setSessionForContext' | 'invalidateSessionHistoryLoad' | 'activeRuns' | 'requestRunStop' | 'submitDesktopConversation' | 'getStartupManagedRecovery' | 'runInContext' | 'runInContexts' | 'unsettledRuns' | 'loadAppSessions' | 'isDeletingSession' | 'userData' | 'sendConversationChanged' | 'dialog' | 'window' | 'isOwnedTestApp' | 'deletingSessions' | 'sessionByContext' | 'sessionDiffBaselines' | 'sessionBaselineKey' | 'recordingBlockedSessions' | 'dockBadge' | 'rendererCanReceive' | 'sendDataUpdated' | 'homeDir' | 'isShuttingDown' | 'runs' | 'isWindowFocused' | 'showItemInFolder' | 'appSessionStore' | 'setCurrentCwd' | 'sessionAliasesByContext' | 'bumpSessionRevision'> & {
  submitDesktopConversation: Conversation['submitDesktopConversation']
}

export function registerMainSessionIpcFromInfrastructure(deps: {
  handleTrusted: MainTrustedIpcHandler
  initialContext: MainSessionInitialContext
  historyState: SessionHistoryState
  infrastructure: {
    providerRuntime: ReturnType<typeof createMainProviderRuntime>
    catalogRuntime: ReturnType<typeof createMainCatalogRuntime>
    conversationRuntime: ReturnType<typeof createAppConversationRuntime>
    desktopTaskEntry: ReturnType<typeof createDesktopTaskEntry>
  }
  state: SessionRegistrationState
}): MainSessionIpcResult {
  const { providerRuntime: p, catalogRuntime: c, conversationRuntime: v, desktopTaskEntry: t } = deps.infrastructure
  const s = deps.state
  const bindings: SessionBindings = {
    providerRegistry: p.providerRegistry, providerOperationGate: s.providerOperationGate, resolveKnownProjectDirectory: c.resolveKnownProjectDirectory,
    currentCwd: s.currentCwd, providerContextKey: p.providerContextKey, contextAdmission: s.contextAdmission, startupManagedRecovery: s.startupManagedRecovery,
    assertLegacyConversationWriteAllowed: s.assertLegacyConversationWriteAllowed, readTraceArchive: s.readTraceArchive,
    resolveCodexHookTrust: s.resolveCodexHookTrust, resolveOpenCodePluginTrust: s.resolveOpenCodePluginTrust,
    ensureMcpExecutionAuthorized: s.ensureMcpExecutionAuthorized, authorizedMcpExecution: p.authorizedMcpExecution, userDataDir: s.userDataDir, cloneForkArchiveTurns: s.cloneForkArchiveTurns,
    resetSessionContext: s.resetSessionContext, setSessionForContext: s.setSessionForContext, invalidateSessionHistoryLoad: s.invalidateSessionHistoryLoad,
    appSessionStore: s.appSessionStore, rememberProject: c.rememberProject, projectStore: c.projectStore, recentStore: c.recentStore,
    listProjectCatalog: c.listProjectCatalog, showItemInFolder: s.showItemInFolder, conversationStore: v.conversationStore,
    adoptingSessionKeys: v.adoptingSessionKeys, providerSessionKey: p.providerSessionKey, activeRuns: s.activeRuns, requestRunStop: s.requestRunStop,
    service: v.conversationService, submitDesktopTask: request => t.submit(request), submitDesktopConversation: s.submitDesktopConversation,
    listDesktopTaskCommands: (conversation, request) => t.commands(conversation, request), store: v.conversationStore,
    getStartupManagedRecovery: s.getStartupManagedRecovery, resolveKnownProjectDirectoryAsync: c.resolveTemplateProjectDirectory,
    providerContinuationKey: context => p.providerRegistry.continuationKey(context), runInContext: s.runInContext, runInContexts: s.runInContexts,
    unsettledRuns: s.unsettledRuns, loadAppSessions: s.loadAppSessions, isDeletingSession: s.isDeletingSession, userData: s.userData,
    sendConversationChanged: s.sendConversationChanged, dialog: s.dialog, window: s.window, isOwnedTestApp: s.isOwnedTestApp,
    deletingSessions: s.deletingSessions, sessionByContext: s.sessionByContext, sessionDiffBaselines: s.sessionDiffBaselines,
    sessionBaselineKey: s.sessionBaselineKey, recordingBlockedSessions: s.recordingBlockedSessions, dockBadge: s.dockBadge,
    rendererCanReceive: s.rendererCanReceive, sendDataUpdated: s.sendDataUpdated, homeDir: s.homeDir, isShuttingDown: s.isShuttingDown,
    runs: s.runs, isWindowFocused: s.isWindowFocused, setCurrentCwd: s.setCurrentCwd, sessionAliasesByContext: s.sessionAliasesByContext,
    bumpSessionRevision: s.bumpSessionRevision
  }
  return registerMainSessionIpcFromBindings({ handleTrusted: deps.handleTrusted, initialContext: deps.initialContext, historyState: deps.historyState, bindings })
}

export function registerMainSessionIpcFromBindings(deps: {
  handleTrusted: MainTrustedIpcHandler
  initialContext: MainSessionInitialContext
  historyState: SessionHistoryState
  bindings: SessionBindings
}): MainSessionIpcResult {
  const { handleTrusted, bindings } = deps
  return registerMainSessionIpc({
    handleTrusted,
    initial: initialFromContext(deps.initialContext),
    fork: { ...bindings },
    catalog: { ...bindings },
    conversation: { ...bindings },
    deletion: { ...bindings },
    historyState: deps.historyState,
    history: { ...bindings },
    historyOlder: { ...bindings }
  })
}

export interface MainSessionIpcResult {
  sessionRefFromRequest: ReturnType<typeof registerSessionCatalogIpc>['sessionRefFromRequest']
  changeLegacySessionMetadata: ReturnType<typeof registerSessionCatalogIpc>['changeLegacySessionMetadata']
}

export function registerMainSessionIpc(deps: MainSessionIpcDeps): MainSessionIpcResult {
  const { handleTrusted } = deps
  registerMainInitialIpc({
    app: { ...deps.initial.app, handleTrusted },
    providerDiscovery: { ...deps.initial.providerDiscovery, handleTrusted },
    agentContext: { ...deps.initial.agentContext, handleTrusted },
    sourceControl: deps.initial.sourceControl,
    sourceControlService: deps.initial.sourceControlService,
    workspace: { ...deps.initial.workspace, handleTrusted },
    terminal: { ...deps.initial.terminal, handleTrusted }
  })

  registerSessionForkIpc({ handleTrusted, ...deps.fork })
  const catalog = registerSessionCatalogIpc({ handleTrusted, ...deps.catalog })
  const conversationIpc = registerConversationIpc({
    register: handleTrusted,
    ...deps.conversation,
    deleteOneSession: (request, options) => deleteOneSession(request, options)
  })
  const { deleteOneSession } = registerSessionDeletionIpc({
    handleTrusted,
    ...deps.deletion,
    prepareConversationDeletion: conversationIpc.prepareConversationDeletion
  })

  registerSessionHistoryLoadIpc(deps.historyState, { register: handleTrusted, ...deps.history })
  registerSessionHistoryOlderIpc(deps.historyState, { register: handleTrusted, ...deps.historyOlder })
  return catalog
}
