import { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, nativeTheme, shell, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import {
  detectAgents,
  detectAgentsFast,
  packagedRecorderCliPath,
  PI_VERSION_PROBE_TIMEOUT_MS,
  probeCliVersion,
  shellEnv,
  warmShellEnv
} from './claude-locate'
import { AgentRuntimeError } from './run-outcome'
import type { ParsedTurn } from './normalize'
import { readCachedTranscript, disposeTranscriptParser } from './transcript-parser'
import { classifyError } from './error-classify'
import { billingStateQuery, deleteSessionData, deleteTurnOutboxSessionRows, importBillingFixture, initDb, recordTurn, replayDatabaseTurnOutbox, resolveSessionRunIds, setBillingEnvProvider, statsQuery, syncBillingAdmin, turnOutboxSessionRunIds, usageAnalyticsWithCreditsQuery } from './db'
import { beginGitTurnDiff, cancelGitTurnDiff, cloneGitTurnDiffCapture, finishGitTurnAndSessionDiff, finishGitTurnDiff, registerGitDiffIpc, snapshotSessionNetDiff, type GitTurnDiffCapture } from './git'
import { RunDiffPreviewer, SessionDiffBaselineRegistry, WriteCompletionTracker, sessionLoadMatchesRun } from './session-diff'
import { SourceControlService } from './source-control/service'
import { registerSourceControlIpc } from './source-control/ipc'
import {
  deleteTranscriptCopies,
  cleanupTraceArchiveTemps,
  discoverTraceArchiveSessionsAsync,
  mirrorTranscript,
  readTraceArchiveAsync,
  readTraceArchivePageAsync,
  resolveTranscriptPath,
  traceArchiveRunIds,
  upsertTraceArchiveTurn,
  type TraceArchive,
  type TraceArchiveTurn
} from './transcript-archive'
import { readPiNativeHistory, reconcilePiNativeHistory } from './pi-native-history'
import {
  readCompleteArchiveForNativeReconciliation,
  hydrateSessionHistoryPage,
  mergeSessionTurns,
  readSessionHistoryAfterCompletedRuns,
  restoreTraceArchiveTurn,
  sessionHistoryPage,
  sessionArchiveIsPageable,
  type LoadedSessionTurn,
  type SessionHistoryPage,
  type SessionHistoryPageRequest
} from './session-history'
import {
  appSessionCanResume,
  cleanupAppStoreAtomicTemps,
  createAppSessionStore,
  createProjectStore,
  createRecentFoldersStore,
  isSessionProviderId,
  mergeProjectMetas,
  type AppSessionRef,
  type ProjectMeta
} from './app-store'
import { isMcpGuardReport } from '../shared/mcpguard-report'
import { appendLlmPerformance, appendUsage, cleanupUsageAtomicTemps, deleteUsageSessionRows, readUsageStats, usageSessionRunIds } from './usage-jsonl'
import { LlmPerformanceObserver } from './llm-performance'
import { readLlmPerformanceHistory } from './llm-performance-history'
import { LlmNetworkConfigurationCache } from './llm-network-configuration'
import { summarizeRunningLlmSessions, type LlmNetworkConfiguration } from '../shared/llm-performance'
import { stopObservedBackgroundTask } from './background-task-control'
import { RunSteering, steerObservedRun } from './run-steering'
import type { BackgroundTaskStopResult } from '../shared/background-work'
import { isRendererPerformanceSample } from '../shared/performance'
import { isDiffPreviewStage, type ActiveRun, type TraceEvent, type TurnDiffBaselineOrigin, type TurnDiffReason, type TurnDiffSnapshot, type UsageAnalyticsRangeDays } from '../shared/trace'
import {
  normalizeAgentForkSessionRequest,
  normalizeAgentStartRequest,
  providerIdForAgentId,
  runTerminationHint,
  type AgentForceKillScope,
  isAgentPermissionMode,
  type AgentForkSessionResult,
  type AgentPermissionMode,
  type AgentInputAttachment,
  type AgentIntervention,
  type AgentQuestionRequest,
  type AgentQuestionResponse,
  type AgentStartRequest,
  type AgentSteerInput,
  type AgentSteerResult,
  type RuntimeProvider
} from '../shared/runtime'
import { capabilityUnavailable, type DeleteArchivedSessionsResult, type DeleteSessionResult, type ProviderContext, type ProviderId, type SessionProviderId } from '../shared/provider'
import { parseDisabledProviders, ProviderRegistry } from './providers/registry'
import { ProviderCompatibilityStore } from './provider-compatibility-manifest'
import type { AuthorizedMcpExecution, ProviderRunHandle } from './providers/types'
import { createBuiltInProviderAdapters } from './providers'
import { createSmokeProviderAdapter } from './providers/smoke'
import { piRpcEnvironment, probePiAgent } from './providers/pi'
import { createPiAgentProfileStore, piProfileForExecutable, undetectedPiProfiles, type PiAgentProfile } from './pi-agent-profiles'
import { composeProviderDetectionResults, createCachedAsyncLoader } from './provider-detection'
import { isSafeOAuthAuthorizationUrl, prepareOAuthLoopback } from './oauth-loopback'
import { ProviderOperationGate, providerOperationKey } from './provider-operation-gate'
import { verifyForkArchiveBoundary } from './session-fork'
import { appendCoalescedTrace, upsertTraceById } from './live-trace'
import { LiveTraceIngestion } from './live-trace-ingestion'
import { createTurnWallTimer } from './turn-wall-timing'
import { CommandReceipts } from './command-receipts'
import { PerformanceTrace, performanceRecordingEnabled } from './performance-timing'
import { startPerformanceRecording, stopPerformanceRecording, recordRendererPerformance, recordResourcePerformance, recordStartupPerformance, performanceRecordingHealth } from './performance-recording'
import { configureProviderEventLog, openProviderEventWriter } from './provider-event-log'
import { startPerformanceResourceMonitor, type PerformanceResourceMonitor } from './performance-resource-monitor'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { sanitizeToolEvents } from '../core/turn-recorder/tool-content'
import { persistTraceToolEvents, readAppTraceContentPage } from './trace-tool-content'
import {
  isManagedRecorderProvider,
  managedRecorderAllowsMissingProviderTurnId,
  managedRecorderMode,
  recoverManagedRecorderTurns,
  type ManagedTurnTiming
} from '../core/turn-recorder/managed'
import { resolveRecorderEnablement, resolveRecorderLocation } from '../core/turn-recorder/config'
import { readAuthorizedRecorderContentPage } from './recorder-content-access'
import { TurnChangeJournal } from '../core/turn-recorder/change-journal'
import { attachConfiguredHookCommands, loadClaudeHookConfig, loadCodexHookConfig } from './hook-config'
import { UserQuestionBroker, type UserQuestionChange } from './user-question'
import { RunRegistry } from './run-registry'
import { RunStopLifecycle } from './run-stop-lifecycle'
import { RemoteHostService, type RemoteHostServiceDependencies } from './remote/remote-host-service'
import { DesktopRemoteClient } from './remote/desktop-client'
import { registerDesktopClientIpc } from './remote/desktop-client-ipc'
import { createDesktopHostReader } from './remote/desktop-host-reader'
import { createDesktopWorkbench } from './remote/desktop-workbench'
import { listDesktopDirectories, selectDesktopDirectory } from './remote/desktop-directory-picker'
import { createRemoteRunBinding, type RemoteRunCompletion } from './remote/remote-run-binding'
import { ReverseTunnelTransport } from './remote/relay-client'
import { createRelayConnect } from './remote/relay-connect'
import { createRelayConnectWS } from './remote/relay-connect-ws'
import { ensureHostIdentity } from './remote/host-identity'
import { ensureRelayCredential } from './remote/relay-credential'
import { DEFAULT_PUBLIC_RELAY_WS, remoteHostEnabled } from './remote/remote-defaults'
import { remoteProviderEntry, remoteProviderMetadata } from './remote/remote-provider-snapshot'
import { createInFlightDeduper } from './remote/provider-discovery'
import type { RemoteProviderRef } from './remote/remote-gateway'
import type { DesktopRemoteContext, DesktopRemoteSessionAction } from '../shared/desktop-remote'
import type { RemoteStatus } from '../shared/remote'
import { DockBadgeState } from './dock-badge'
import { sessionAttentionKey } from '../shared/session-attention'
import { archiveSessionId } from './session-id'
import { archiveSessionAndStop } from './session-archive'
import {
  codexHookFingerprint,
  createCodexHookGrantStore,
  hooksRequiringBypass,
  type CodexHookInspection,
  type CodexHookTrustGrant
} from './codex-hook-trust'
import {
  createOpenCodePluginGrantStore,
  type OpenCodeProjectPluginAuthorization
} from './opencode-plugin-trust'
import { readOpenCodeProjectProjection } from './providers/opencode-server'
import {
  createWorkspaceEntry,
  listWorkspace,
  moveWorkspaceEntry,
  openWorkspaceFileExternally,
  readWorkspaceFile,
  readWorkspaceFilePage,
  resolveWorkspaceFileOpenTarget,
  renameWorkspaceEntry,
  trashWorkspaceEntry,
  writeWorkspaceFile
} from './workspace-files'
import type {
  WorkspaceCreateRequest,
  WorkspaceFilePageRequest,
  WorkspaceListRequest,
  WorkspaceMoveRequest,
  WorkspacePathRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest
} from '../shared/workspace'
import { HomeFileAccess } from './home-file-access'
import { createTerminalManager, type TerminalManager } from './terminal-manager'
import { TerminalRecordingWorkerClient } from './terminal-recording-backend'
import { TerminalOutputBridge } from './terminal-output'
import { TraceOutputBridge, type TraceBatchReceipt } from './trace-output'
import { flattenTraceItems, previewTraceItems } from './remote/trace-output'
import {
  authorizedWorkspaceRequest,
  canonicalExistingDirectory,
  knownProjectDirectory
} from './workspace-authorization'
import { windowBackgroundColor, windowTitleBarOptions } from './window-chrome'
import { assertTrustedIpcEvent as assertTrustedIpcEventForWindow, registerTrustedIpcHandler } from './ipc-trust'
import { writeClipboardText } from './clipboard-text'
import { canonicalRemoteProjectRoots, listRemoteDirectories, resolveCanonicalRemoteProjectDirectory, resolveRemoteProjectDirectory as resolveRemoteDescendant } from './remote/remote-directory-browser'
import { readRemoteHistoryTurnsPage, readRemoteHistoryVersion } from './remote/history-reader'
import { observeSessionStatus } from './remote/remote-workspace'
import type {
  TerminalCloseRequest,
  TerminalRecordingRequest,
  TerminalRecordingListRequest,
  TerminalResizeRequest,
  TerminalStartRequest,
  TerminalOwnershipRequest,
  TerminalWriteRequest
} from '../shared/terminal'
import {
  editContextMenuTemplate,
  imageContextMenuTemplate,
  shouldShowEditContextMenu,
  shouldShowImageContextMenu
} from './edit-context-menu'
import {
  canonicalOrObservedTurnTiming,
  commitManagedTraceTurn,
  persistManagedTraceProgress,
  recoverManagedTraceProgress,
  recoverManagedTraceTurns,
  cleanupManagedTurnTemps,
  deleteManagedTurnArtifacts,
  managedRecoveryScopes,
  managedSessionRunIds
} from './managed-turn-commit'
import {
  createCommitHookTrustStore,
  inspectCommitHookBundle,
  resolveGrantedCommitHookCapability
} from './commit-hook-trust'
import { redeliverGrantedCommitHooksAtStartup } from './commit-hook-startup'
import { providerRecordingPolicy } from './provider-recording-policy'
import {
  configureRendererPermissions,
  isAllowedRendererRequest,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  resolveRendererEntryUrl,
  rendererContentSecurityPolicy
} from './renderer-security'
import {
  buildMcpExecutionSnapshot,
  McpExecutionTrust,
  type McpExecutionOperation,
  type McpExecutionSnapshot
} from './mcp-execution-trust'
import {
  attachmentSessionRunIds,
  deleteRunAttachments,
  prepareRunAttachments,
  providerAttachmentPrompt,
  storeAttachmentReference,
  updateRunAttachmentOwner,
  type PreparedAttachment
} from './attachment-store'
import { deleteOwnedSessionData } from './session-deletion'
import { ConversationStore, type NativeSessionScope } from './conversation-store'
import { ConversationService, parseConversationTarget, type ConversationServiceDeps, type ManagedConversationStart } from './conversation-service'
import type { Conversation, ConversationDeletionResult } from '../shared/conversation'
import { liveConversationDeletionCatalog, planConversationDeletion, resolveConversationDeletionRuns } from './conversation-deletion'
import { parseConversationLegacySource, prepareConversationAdoption } from './conversation-adoption'
import { conversationItemsFromTrace, deleteConversationHistory, readConversationHistoryItem } from './conversation-history'
import { ensureFailedTerminalResult, terminalOutcomeLabel } from './run-outcome'
import { enforceShutdownDeadline, settleRunsForShutdown } from './shutdown'
import {
  ContextAdmission,
  canRestartInterruptedLocalOnlySession,
  expectedRestartSourceMatches,
  expectedSessionMatches,
  runConflictsWithSession,
  waitForCompletedRuns
} from './context-admission'
import {
  cleanupTraceTurnProgressTemps,
  deleteTraceTurnProgress,
  deleteTraceTurnProgressArtifacts,
  isProviderlessTerminalTurn,
  persistTraceTurnProgress,
  persistUnresolvedTraceTurnProgress,
  recoverTraceTurnProgress,
  shouldUseManagedTerminalPersistence,
  traceProgressSessionRunIds
} from './trace-turn-progress'

// scry 开发期可能从一个父 Claude Code 会话内启动，继承了 CLAUDECODE / CLAUDE_CODE_* /
// AI_AGENT 等环境变量，会让 SDK 驱动的 claude 子进程认证错乱（误判为嵌套会话 → Not logged in）。
// 启动时清掉这些继承来的变量，让 SDK 的 cli.js 以干净的用户级环境读本机登录态（Keychain/OAuth）。
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
// Chromium 148 (Electron 42) 在辅助功能客户端接入后会走 AXBlockFlowIterator 计算行内邻居，
// ax_block_flow_iterator.cc:169 的 CHECK_DEREF(box_fragment->Items()) 会把 renderer 直接打死（SIGTRAP），
// 窗口只剩背景色。关闭该特性让 Blink 回到 AbstractInlineTextBox 路径，绕开崩溃点。
// 升级 Electron 时复核：上游修复该 CHECK 或移除此特性开关后应删除这里。
const disabledChromiumFeatures = app.commandLine.getSwitchValue('disable-features')
app.commandLine.appendSwitch('disable-features',
  [disabledChromiumFeatures, 'AccessibilityBlockFlowIterator'].filter(Boolean).join(','))
// Isolated automation stays hidden: showInactive still displays a native window.
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

// 每个 Provider + cwd 维护各自的会话；空 cwd 是“不绑定项目”的持久会话作用域。
const sessionByContext = new Map<string, string>()
const sessionRevisionByContext = new Map<string, number>()
const sessionAliasesByContext = new Map<string, Map<string, string>>()
let loadSessionRevision = 0
let loadSessionAbortController: AbortController | null = null
// 已加载会话的单条历史缓存：翻页复用归一化事件，但附件只在页越过 IPC 前读取。
// 这把图片 I/O/base64 与常驻内存限制在可见页；事件源仍完整解析，后续由源级索引继续收窄。
let sessionHistoryCache: {
  revision: number
  key: string
  turns: LoadedSessionTurn[]
  transcriptTurns: ParsedTurn[]
  archive: TraceArchive | null
  context: { userDataDir: string }
  archiveSource?: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId }
  archiveSnapshotTotalTurns?: number
  hookConfig: ReturnType<typeof loadClaudeHookConfig> | null
} | null = null

function invalidateSessionHistoryLoad(reason: string): void {
  loadSessionRevision += 1
  loadSessionAbortController?.abort(new Error(reason))
  loadSessionAbortController = null
  sessionHistoryCache = null
}

// Both local and remote runs own baselines by provider/profile/cwd/session.
// Selection revisions cannot rename or discard a different run's Git capture.
const sessionDiffBaselines = new SessionDiffBaselineRegistry()
const sessionBaselineKey = (context: string, sessionId: string): string => JSON.stringify([context, 'session', sessionId])
const contextAdmission = new ContextAdmission()
const recordingBlockedSessions = new Map<string, string>()
const providerOperationGate = new ProviderOperationGate()
const recordingRecoveryHint = '不要开始下一轮；保留 userData/trace-turn-progress、managed-turn-progress、managed-turn-commits 与 workspace/.scry 后重试恢复'
const deletingSessions = new Set<string>()
let currentCwd: string | undefined
let terminalManager: TerminalManager | undefined
let terminalManagerPromise: Promise<TerminalManager> | undefined

function rendererCanReceive(): boolean {
  return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed())
}

const terminalOutput = new TerminalOutputBridge({
  canSend: rendererCanReceive,
  sendData: (events) => win?.webContents.send('terminal:data', events),
  sendExit: (event) => win?.webContents.send('terminal:exit', event),
  pauseTerminal: (id) => terminalManager?.pauseOutput(id),
  resumeTerminal: (id) => terminalManager?.resumeOutput(id),
  warn: (message, id) => console.warn(`[scry] ${message}:`, id)
})

async function getTerminalManager(): Promise<TerminalManager> {
  if (terminalManager) return terminalManager
  if (!terminalManagerPromise) {
    terminalManagerPromise = warmShellEnv()
      .then((env) => {
        let manager: TerminalManager | undefined
        const recordingBackend = TerminalRecordingWorkerClient.create(
          join(app.getPath('userData'), 'terminal-recordings'),
          {
            onFailure: (id) => {
              console.warn('[scry] terminal recording unavailable:', id)
              if (rendererCanReceive()) win?.webContents.send('terminal:recordingError', {
                id, message: '终端录制失败，已保存内容可能不完整；Shell 继续运行。'
              })
            },
            onFlow: ({ id, paused }) => {
              if (paused) manager?.pauseRecording(id)
              else manager?.resumeRecording(id)
            }
          }
        )
        manager = createTerminalManager({
          getCurrentCwd: () => currentCwd,
          defaultCwd: homeDir,
          onData: (event) => terminalOutput.data(event),
          onExit: (event) => terminalOutput.exit(event),
          recordingBackend,
          onRecordingError: (event) => {
            console.warn('[scry] terminal recording unavailable:', event.id)
            if (rendererCanReceive()) win?.webContents.send('terminal:recordingError', event)
          },
          shell: env.SHELL || process.env.SHELL || '/bin/zsh',
          env
        })
        terminalManager = manager
        return manager
      })
      .catch((error) => {
        terminalManagerPromise = undefined
        throw error
      })
  }
  return terminalManagerPromise
}

const homeDir = homedir()
const homeFileAccess = new HomeFileAccess(homeDir)
const recentStore = () => createRecentFoldersStore(app.getPath('userData'))
const projectStore = () => createProjectStore(app.getPath('userData'))
const rememberProject = (cwd: string): void => {
  const canonical = canonicalExistingDirectory(cwd)
  recentStore().push(canonical)
  projectStore().remember(canonical)
}
const knownProjectDirectories = (): Set<string> => new Set([
  ...recentStore().load(),
  ...projectStore().load().filter((project) => !project.removedAt).map((project) => project.cwd),
  ...appSessionStore().load().map((session) => session.cwd).filter(Boolean)
])
const resolveKnownProjectDirectory = (cwd: string): string => knownProjectDirectory(cwd, knownProjectDirectories())
const remoteProjectRoots = (): string[] => canonicalRemoteProjectRoots(knownProjectDirectories())
const resolveRemoteProjectDirectory = (cwd: string): string => resolveRemoteDescendant(cwd, knownProjectDirectories())
let traceCatalogRecovery: Promise<void> | null = null
const recoverTraceCatalogOnce = (): Promise<void> => {
  if (traceCatalogRecovery) return traceCatalogRecovery
  traceCatalogRecovery = (async () => {
    const store = appSessionStore()
    const catalog = store.load()
    const knownCwds = new Set(catalog.map((session) => session.cwd))
    const known = new Set(catalog.flatMap((session) =>
      session.externalSessionId
        ? [`${session.providerId}\0${session.agentProfileId ?? ''}\0${session.cwd}\0${session.externalSessionId}`]
        : []
    ))
    for (const summary of await discoverTraceArchiveSessionsAsync(app.getPath('userData'))) {
      // Recovery targets the Qoder catalog gap that loses otherwise healthy native sessions.
      // Never resurrect archived regression evidence as new projects.
      if (summary.providerId !== 'qoder' || !knownCwds.has(summary.cwd)) continue
      const key = `${summary.providerId}\0\0${summary.cwd}\0${summary.sessionId}`
      if (known.has(key)) continue
      store.record({
        providerId: summary.providerId,
        runtimeProvider: summary.runtimeProvider,
        runId: summary.runId,
        externalSessionId: summary.sessionId,
        cwd: summary.cwd,
        prompt: summary.prompt
      })
      known.add(key)
    }
  })()
  return traceCatalogRecovery
}
const listProjectCatalog = async (): Promise<ProjectMeta[]> => {
  await recoverTraceCatalogOnce()
  const sessionProjects = appSessionStore().listProjects()
  const now = Date.now()
  const observed = new Map<string, number>()
  recentStore().load().forEach((cwd, index) => observed.set(cwd, now - index))
  for (const project of sessionProjects) {
    if (project.cwd) observed.set(project.cwd, Math.max(observed.get(project.cwd) ?? 0, project.mtime))
  }
  const store = projectStore()
  store.seed([...observed].map(([cwd, lastOpenedAt]) => ({ cwd, lastOpenedAt })))
  const projects = mergeProjectMetas(store.load(), sessionProjects)
  return Promise.all(projects.map(async (project) => {
    const conversations = await conversationService().list(project.cwd)
    const ownedNativeAliases = await conversationService().nativeSessionAliases(project.cwd)
    return {
      ...project,
      // Only the local sidebar projection hides aliases. Raw app/provider
      // catalogs remain unchanged and retain their native evidence.
      sessions: project.sessions.filter((session) => {
        const nativeId = session.externalSessionId ?? session.sessionId
        const alias = `${session.providerId}\0${session.agentProfileId ?? ''}\0${project.cwd}\0${nativeId}`
        return !ownedNativeAliases.has(alias)
      }),
      conversations
    }
  }))
}
const piProfileStore = () => createPiAgentProfileStore(app.getPath('userData'))
const fullAgentDetection = createCachedAsyncLoader(() => detectAgents({
  versionProbeEnv: (agent, executable) => providerIdForAgentId(agent.id) === 'pi'
    ? piRpcEnvironment({ id: agent.id, label: agent.name, executable })
    : undefined
}), { ttlMs: 60_000 })
const detectInstalledAgents = () => fullAgentDetection.load()
// Provider descriptors and runtime profile resolution only need executable identity. Do not turn
// their frequent availability reads into version subprocesses for every installed Provider.
const detectedPiProfiles = async (): Promise<PiAgentProfile[]> => detectAgentsFast().flatMap((agent) => {
  if (providerIdForAgentId(agent.id) !== 'pi') return []
  try {
    const profile = piProfileForExecutable(agent.path)
    return [{ ...profile, id: agent.id, label: agent.name }]
  } catch {
    return []
  }
})
const storedPiProfiles = (): PiAgentProfile[] => {
  try {
    return piProfileStore().load().flatMap((stored) => {
      try {
        const current = piProfileForExecutable(stored.executable)
        return [{ ...current, id: stored.id, label: stored.label }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}
const storedPiProfilesNotDetected = (detected: Array<{ id: string }>): PiAgentProfile[] =>
  undetectedPiProfiles(storedPiProfiles(), detected)
const listPiProfiles = async (): Promise<PiAgentProfile[]> => {
  const detected = await detectedPiProfiles()
  return [...detected, ...storedPiProfilesNotDetected(detected.map((profile) => ({ id: profile.id, path: profile.executable })))]
}
const resolvePiProfile = async (id: string): Promise<PiAgentProfile | undefined> => {
  if (id === 'pi:default' || id === 'pi:rotom') return (await detectedPiProfiles()).find((profile) => profile.id === id)
  return storedPiProfiles().find((profile) => profile.id === id)
}
let appSessionStoreInstance: ReturnType<typeof createAppSessionStore> | undefined
const appSessionStore = () => appSessionStoreInstance ??= createAppSessionStore(app.getPath('userData'))
let conversationStoreInstance: ConversationStore | undefined
const conversationStore = () => conversationStoreInstance ??= new ConversationStore(app.getPath('userData'))
async function assertLegacyConversationWriteAllowed(scope: NativeSessionScope, deletion?: { ownerId?: string }): Promise<void> {
  const activeIds = new Set(runs.unsettledStates().filter((run) => run.providerId === scope.providerId &&
    run.agentProfileId === scope.agentProfileId && (run.cwd ?? '') === scope.cwd).map((run) => run.runId))
  if (activeIds.size && (await conversationStore().list(scope.cwd)).some((conversation) =>
    conversation.turns.some((turn) => activeIds.has(turn.runId)))) {
    throw new Error('统一对话仍在执行或保存证据，不能从旧入口写入；请等待本轮收敛')
  }
  await conversationStore().assertLegacyWriteAllowed(scope, deletion)
}
const adoptingSessionKeys = new Set<string>()
let conversationServiceInstance: ConversationService | undefined
const conversationService = (): ConversationService => conversationServiceInstance ??= new ConversationService({
  store: conversationStore(),
  resolveContinuationKey: (context) => providerRegistry.continuationKey(context),
  forkNative: forkManagedConversation,
  supportsHistoricalInput: (providerId) => providerRegistry.get(providerId).historicalContext === true,
  supportsHistoryReader: (providerId) => providerRegistry.get(providerId).historyReader === true,
  startAppRun: async (request, options) => {
    const result = await startAppRun(request, options)
    if (!('runId' in result)) throw new Error('统一对话不能使用远程执行结果')
    return result
  },
  loadItemText: (conversation, ref) => readConversationHistoryItem(app.getPath('userData'), conversation, ref),
  loadTurn: async (conversation, turn) => {
    if (!turn.archive) return undefined
    const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)
    if (!binding) return undefined
    const archive = await readTraceArchiveAsync({
      userDataDir: app.getPath('userData'), cwd: conversation.cwd,
      sessionId: turn.archive.sessionId, providerId: binding.providerId
    })
    return archive ? mergeSessionTurns([], archive, { userDataDir: app.getPath('userData') }).find((candidate) => candidate.runId === turn.runId) : undefined
  }
})
const smokeProviderEnabled = process.env.SCRY_ELECTRON_SMOKE_PROVIDER === '1' &&
  process.env.ELECTRON_ENABLE_LOGGING === '1' &&
  process.argv.some((arg) => arg.startsWith('--remote-debugging-port='))
const smokeProviderIds: Array<'claude' | 'codex' | 'pi'> = process.env.SCRY_ELECTRON_SMOKE_CONVERSATIONS === '1' ? ['codex', 'claude', 'pi'] : ['codex']
const smokeDetectedAgents = smokeProviderIds.map(id => ({
  id: id === 'pi' ? 'pi:0123456789abcdef' : id,
  name: id === 'pi' ? 'Pi · Rotom Smoke Fixture' : `${id} Smoke Fixture`, bin: id, path: process.execPath
}))
const builtInProviderAdapters = smokeProviderEnabled ? smokeProviderIds.map((id) => createSmokeProviderAdapter(id)) : createBuiltInProviderAdapters(
  homeDir,
  join(app.getPath('userData'), 'codex-home-v1'),
  join(app.getPath('userData'), 'provider-auth', 'opencode'),
  join(app.getPath('userData'), 'provider-state', 'opencode-v1'),
  { listProfiles: listPiProfiles, resolveProfile: resolvePiProfile,
    historyExtensionPath: join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'scry-history', 'pi-history-reader.mjs') }
)
/**
 * 兼容性策略在进程内保持一份。远端地址只有用户/部署配置了才会访问；
 * 没配置就只用内置策略，不产生额外网络请求。拉取失败不影响 Provider 探测。
 */
const providerCompatibility = new ProviderCompatibilityStore({
  scryVersion: app.getVersion(),
  cachePath: join(app.getPath('userData'), 'provider-compatibility-v1.json'),
  ...(process.env.SCRY_PROVIDER_MANIFEST_URL?.trim()
    ? { remoteUrl: process.env.SCRY_PROVIDER_MANIFEST_URL.trim() }
    : {})
})
const providerRegistry = new ProviderRegistry(
  builtInProviderAdapters,
  {
    disabledProviders: parseDisabledProviders(process.env.SCRY_DISABLED_PROVIDERS),
    runControlsEnabled: process.env.SCRY_RUN_CONTROLS?.trim() !== '0',
    compatibility: (providerId, version) => providerCompatibility.advisory(providerId, version)
  }
)
const codexHookGrantStore = () => createCodexHookGrantStore(app.getPath('userData'))
const openCodePluginGrantStore = () => createOpenCodePluginGrantStore(app.getPath('userData'))
const mcpExecutionTrust = new McpExecutionTrust()

const providerContextKey = (providerId: ProviderId, cwd: string, agentProfileId?: string): string =>
  `${providerId}\0${agentProfileId ?? ''}\0${cwd}`
const withProviderOperation = async <T>(
  providerId: ProviderId,
  operation: () => T | Promise<T>,
  agentProfileId?: string
): Promise<T> => {
  const lease = providerOperationGate.acquireOperation(providerOperationKey(providerId, agentProfileId))
  if (!lease.ok) throw new Error('当前 Provider 正在认证 MCP，请等待认证完成或超时后重试')
  try {
    return await operation()
  } finally {
    lease.release()
  }
}
const canonicalProviderCwd = (cwd?: string): string => {
  try {
    return realpathSync(cwd ?? process.cwd())
  } catch {
    return cwd ?? process.cwd()
  }
}
const providerSessionKey = (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string): string =>
  sessionAttentionKey({ providerId, agentProfileId, cwd, sessionId })
let badgePermissionWarningShown = false
const dockBadge = new DockBadgeState((count) => {
  if (app.setBadgeCount(count) || process.platform !== 'darwin' || badgePermissionWarningShown) return
  badgePermissionWarningShown = true
  console.warn('[scry] macOS Dock badge permission is unavailable')
}, (snapshot) => {
  try {
    win?.webContents.send('agent:unreadSessions', snapshot)
  } catch (error) {
    console.warn('[scry] unread session notification failed:', error)
  }
})
const activeRunSessionKey = (run: ActiveRun): string | null => {
  if (!run.providerId) return null
  return providerSessionKey(
    run.providerId,
    run.cwd ?? '',
    run.externalSessionId ?? run.sessionId ?? run.runId,
    run.agentProfileId
  )
}

function codexHookInspectionError(cwd: string, message: string, nextAction: string): AgentRuntimeError {
  return new AgentRuntimeError(message, {
    provider: 'codex_cli',
    stage: 'capability',
    cwd,
    nextAction
  })
}

async function resolveCodexHookTrust(cwd: string): Promise<CodexHookTrustGrant[]> {
  let inspection: CodexHookInspection
  try {
    inspection = await providerRegistry.inspectHookTrust({ providerId: 'codex', cwd })
  } catch (error) {
    throw codexHookInspectionError(
      cwd,
      `Codex Hook 预检失败：${String((error as Error).message)}`,
      '确认 Codex CLI 可用并重试；Scry 不会在无法校验 Hook 指纹时自动绕过信任'
    )
  }
  if (inspection.errors.length > 0) {
    throw codexHookInspectionError(
      cwd,
      `Codex Hook 配置读取失败：${inspection.errors.join('；')}`,
      '修复 Codex hooks/list 报告的配置错误后重试'
    )
  }

  const pending = hooksRequiringBypass(inspection.hooks)
  if (pending.length === 0) return []

  const trust = pending.map(({ key, currentHash }) => ({ key, currentHash }))
  const fingerprint = codexHookFingerprint(inspection.hooks)
  const store = codexHookGrantStore()
  if (!store.isGranted(cwd, fingerprint)) {
    const enabledCount = inspection.hooks.filter((hook) => hook.enabled).length
    try {
      store.grant(cwd, fingerprint, enabledCount)
    } catch (error) {
      throw codexHookInspectionError(
        cwd,
        `Codex Hook 授权保存失败：${String((error as Error).message)}`,
        '检查 Scry userData 目录写权限后重试'
      )
    }
  }
  return trust
}

async function resolveOpenCodePluginTrust(cwd: string): Promise<OpenCodeProjectPluginAuthorization | undefined> {
  let projection
  try {
    projection = await readOpenCodeProjectProjection(cwd)
  } catch (error) {
    throw new AgentRuntimeError(`OpenCode 项目 plugin 预检失败：${String((error as Error).message)}`, {
      provider: 'opencode_server',
      stage: 'capability',
      cwd,
      nextAction: '修复 opencode.json plugin 声明；Scry 仅允许本仓内 ./ 相对普通文件'
    })
  }
  if (projection.plugins.length === 0) return undefined

  const store = openCodePluginGrantStore()
  if (!store.isGranted(projection.cwd, projection.pluginFingerprint)) {
    try {
      store.grant(projection.cwd, projection.pluginFingerprint, projection.plugins.length)
    } catch (error) {
      throw new AgentRuntimeError(`OpenCode 项目 plugin 授权保存失败：${String((error as Error).message)}`, {
        provider: 'opencode_server',
        stage: 'capability',
        cwd,
        nextAction: '检查 Scry userData 目录写权限后重试'
      })
    }
  }
  return {
    cwd: projection.cwd,
    fingerprint: projection.pluginFingerprint,
    plugins: projection.plugins
  }
}

function withoutCommitHookCapability(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy.SCRY_RECORDER_COMMIT_HOOK
  delete copy.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT
  return copy
}

async function resolveManagedCommitHookEnv(
  cwd: string,
  knownEnablement?: Awaited<ReturnType<typeof resolveRecorderEnablement>>
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = withoutCommitHookCapability()
  // managedRecorderMode 已在发送前验证过同一份配置时复用结果，避免热路径重复读取、
  // 解析并遍历 .scry 配置。调用方没有快照（例如独立恢复路径）时仍在这里现查。
  const enablement = knownEnablement ?? await resolveRecorderEnablement(cwd)
  if (!enablement.enabled || !enablement.config.commitHook) return baseEnv
  let inspection
  try {
    inspection = await inspectCommitHookBundle(cwd, enablement.config.commitHook)
  } catch (error) {
    console.warn('[scry] recorder commit hook bundle inspection failed:', cwd, error)
    return baseEnv
  }

  const store = createCommitHookTrustStore(app.getPath('userData'))
  let granted = await store.isGranted(inspection.workspace, inspection.fingerprint)
  if (granted) {
    try {
      const capability = await store.materialize(inspection)
      const recorderCli = packagedRecorderCliPath() ?? baseEnv.SCRY_CLI_PATH
      return {
        ...baseEnv,
        ...capability.env,
        ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
        SCRY_RECORDER_MANAGED: '1'
      }
    } catch (error) {
      console.warn('[scry] recorder commit hook materialization failed:', cwd, error)
      await store.revoke(inspection.workspace, inspection.fingerprint).catch(() => undefined)
      granted = false
    }
  }
  if (!granted) {
    try {
      await store.grant(inspection.workspace, inspection.fingerprint, 'auto')
    } catch (error) {
      console.warn('[scry] recorder commit hook grant failed:', cwd, error)
      return baseEnv
    }
  }

  try {
    const capability = await store.materialize(inspection)
    const recorderCli = packagedRecorderCliPath() ?? baseEnv.SCRY_CLI_PATH
    return {
      ...baseEnv,
      ...capability.env,
      ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
      SCRY_RECORDER_MANAGED: '1'
    }
  } catch (error) {
    console.warn('[scry] recorder commit hook materialization failed:', cwd, error)
    return baseEnv
  }
}

async function resolveGrantedManagedCommitHookEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const baseEnv = withoutCommitHookCapability()
  const enablement = await resolveRecorderEnablement(cwd)
  if (!enablement.enabled || !enablement.config.commitHook) return baseEnv
  try {
    const capability = await resolveGrantedCommitHookCapability(
      cwd,
      enablement.config.commitHook,
      app.getPath('userData'),
      undefined,
      { autoGrant: true }
    )
    if (!capability) return baseEnv
    const recorderCli = packagedRecorderCliPath() ?? baseEnv.SCRY_CLI_PATH
    return {
      ...baseEnv,
      ...capability.env,
      ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
      SCRY_RECORDER_MANAGED: '1'
    }
  } catch (error) {
    console.warn('[scry] granted recorder commit hook recovery capability failed:', cwd, error)
    return baseEnv
  }
}

async function ensureMcpExecutionAuthorized(
  context: ProviderContext,
  operation: McpExecutionOperation,
  targetId?: string
): Promise<McpExecutionSnapshot | null> {
  const build = (): McpExecutionSnapshot => buildMcpExecutionSnapshot({
    providerId: context.providerId,
    cwd: context.cwd,
    homeDir,
    settingSources: context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
    env: shellEnv(),
    selectedTargetId: targetId
  })
  const snapshot = build()
  if (snapshot.errors.length > 0) {
    throw new Error(`MCP 配置无法安全执行：${snapshot.errors.join('；')}`)
  }
  const selected = targetId
    ? snapshot.targets.filter((target) => target.targetId === targetId)
    : snapshot.targets.filter((target) => target.enabled)
  if (targetId && selected.length !== 1) throw new Error(`找不到精确 MCP 配置目标：${targetId}`)
  if (selected.length === 0) return operation === 'run' ? null : snapshot

  // 仓库 MCP 默认自动授权全部选中目标；旧的部分授权不会继续限制当前配置。
  // 配置、可执行文件或指纹变化仍会在启动边界重新校验。
  const executionTargetIds = undefined

  const verified = build()
  if (verified.errors.length > 0 || verified.fingerprint !== snapshot.fingerprint) {
    throw new Error('MCP 配置在授权后发生变化，已拒绝执行')
  }
  mcpExecutionTrust.grant(operation, verified, executionTargetIds)
  return executionTargetIds === undefined ? verified : { ...verified, executionTargetIds }
}

function authorizedMcpExecution(snapshot: McpExecutionSnapshot | null): AuthorizedMcpExecution | undefined {
  if (!snapshot) return undefined
  const verified = buildMcpExecutionSnapshot({
    providerId: snapshot.providerId,
    cwd: snapshot.cwd,
    homeDir,
    settingSources: snapshot.settingSources,
    env: shellEnv(),
    selectedTargetId: snapshot.selectedTargetId
  })
  if (verified.errors.length > 0 || verified.fingerprint !== snapshot.fingerprint) {
    throw new Error('MCP 可执行文件或配置在启动边界发生变化，已拒绝执行')
  }
  const executionTargetIds = snapshot.executionTargetIds === undefined
    ? null
    : new Set(snapshot.executionTargetIds)
  return {
    cwd: verified.cwd,
    fingerprint: verified.fingerprint,
    targets: verified.targets
      .filter((target) => executionTargetIds === null || executionTargetIds.has(target.targetId))
      .map(({ targetId, name, enabled, config }) => ({ targetId, name, enabled, config })),
    env: { ...verified.executionEnv }
  }
}

function bumpSessionRevision(key: string): void {
  sessionRevisionByContext.set(key, (sessionRevisionByContext.get(key) ?? 0) + 1)
}

function resetSessionContext(key: string): void {
  bumpSessionRevision(key)
  sessionByContext.delete(key)
  sessionAliasesByContext.delete(key)
}

function setCurrentCwd(dir: string | undefined): void {
  // Selection is not process ownership. Existing shells retain their spawn cwd;
  // only explicit close or app shutdown terminates them. New starts still validate currentCwd.
  currentCwd = dir
}

async function mirrorSessionTranscript(providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined): Promise<void> {
  if (providerId !== 'claude' || !cwd || !sessionId) return
  try {
    const ok = await mirrorTranscript({ cwd, sessionId, userDataDir: app.getPath('userData') })
    if (!ok) console.warn('[scry] transcript mirror skipped:', cwd, sessionId)
  } catch (error) {
    console.warn('[scry] transcript mirror failed:', cwd, sessionId, error)
  }
}

interface ArchiveTraceTurnArgs {
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd: string | undefined
  sessionId: string | undefined
  providerTurnId?: string
  forkTurnId?: string
  runId: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done: boolean
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  error?: string
  errorHint?: string
  observedTiming?: ManagedTurnTiming
  commitHookEnv?: NodeJS.ProcessEnv
  managedRecorderEnabled: boolean
  beforePersist?: () => Promise<void>
}

function cloneForkArchiveTurns(args: {
  turns: TraceArchiveTurn[]
  targetSessionId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd: string
}): void {
  const userDataDir = app.getPath('userData')
  const clonedRunIds: string[] = []
  try {
    for (const source of args.turns) {
      const runId = `fork-${createHash('sha256')
        .update(`${args.targetSessionId}\0${source.runId}`)
        .digest('hex')
        .slice(0, 24)}`
      clonedRunIds.push(runId)
      const restored = restoreTraceArchiveTurn(source, { userDataDir })
      const attachments = prepareRunAttachments(userDataDir, runId, restored.attachments ?? [], {
        providerId: args.providerId,
        cwd: args.cwd,
        sessionId: args.targetSessionId
      })
      const ok = upsertTraceArchiveTurn({
        cwd: args.cwd,
        sessionId: args.targetSessionId,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        userDataDir,
        turn: {
          ...source,
          runId,
          attachments,
          items: source.items.map((event) => ({ ...event, runId }))
        }
      })
      if (!ok) throw new Error('Scry 无法复制分支前缀归档')
    }
  } catch (error) {
    deleteTranscriptCopies({
      cwd: args.cwd,
      sessionId: args.targetSessionId,
      userDataDir,
      providerId: args.providerId
    })
    for (const runId of clonedRunIds) deleteRunAttachments(userDataDir, runId)
    throw error
  }
}

function observedTurnTiming(startedAt: string | undefined, completedAt: string): ManagedTurnTiming | undefined {
  if (!startedAt) return undefined
  const started = Date.parse(startedAt)
  const completed = Date.parse(completedAt)
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return undefined
  return { startedAt, completedAt, durationMs: Math.max(0, completed - started) }
}

function buildTraceArchiveTurn(args: ArchiveTraceTurnArgs): {
  turn: TraceArchiveTurn
  timing: ManagedTurnTiming | null
} {
  // 运行中 Diff 预览只服务实时 UI：它是终态同一条 Git capture 的临时重算，
  // 落盘会在 archive 对账里重复计入 diff 证据，也会让重启后回放出过期临时快照。
  const persistedItems = args.items
    .filter((event) => !(event.kind === 'harness' && isDiffPreviewStage(event.stage)))
    .map((event) => {
      const { hookConfiguredCommands: _currentConfig, ...persisted } = event
      return persisted
    })
  const turnEvidence = aggregateTurnEvidence({
    userText: args.userText,
    events: persistedItems,
    source: 'scry_provider_adapter'
  })
  const timing = canonicalOrObservedTurnTiming(persistedItems, args.providerId, args.status, args.observedTiming)
  return {
    timing,
    turn: {
      runId: args.runId,
      ...(args.providerTurnId ? { providerTurnId: args.providerTurnId } : {}),
      ...(args.forkTurnId ? { forkTurnId: args.forkTurnId } : {}),
      userText: args.userText,
      attachments: args.attachments?.map((attachment) =>
        storeAttachmentReference(app.getPath('userData'), args.runId, attachment)
      ),
      items: persistedItems,
      turnEvidence,
      done: args.done,
      status: args.status,
      error: args.error,
      errorHint: args.errorHint,
      ...(timing ?? {}),
      ts: timing ? Date.parse(timing.completedAt) : Date.now()
    }
  }
}

async function persistTerminalProgress(args: ArchiveTraceTurnArgs): Promise<void> {
  await args.beforePersist?.()
  const { turn, timing } = buildTraceArchiveTurn(args)
  const archiveCwd = args.cwd ?? ''
  const managedPolicy = args.managedRecorderEnabled && archiveCwd && isManagedRecorderProvider(args.providerId)
  if (args.managedRecorderEnabled && !managedPolicy) {
    throw new Error('managed recorder launch policy has no valid workspace/provider identity')
  }
  if (!args.sessionId) {
    // Provider 在产出任何内容前就失败时没有原生 session 可恢复；不能把这类失败（参数/权限
    // 校验、CLI 缺失、pinned recorder CLI 版本不符）持久化成永久 pending，否则用户修正环境后
    // 仍无法开始下一轮。
    if (isProviderlessTerminalTurn(turn)) return
    if (managedPolicy) {
      await persistUnresolvedTraceTurnProgress({
        userDataDir: app.getPath('userData'),
        cwd: archiveCwd,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        turn,
        reason: 'missing_provider_session_id'
      })
      throw new Error('managed recorder requires an authoritative Provider session id')
    }
    return
  }
  // managed Provider 可能在拿到原生 session id 后、真正建立 turn 边界前失败（例如
  // Pi 的 prompt/recorder preflight）。这种轮次只有 Scry harness 证据，不能伪装成
  // canonical `.scry` turn；但 session id 已足够作为 Scry 本地 archive key。若仍强制
  // providerTurnId，会同时丢掉输入与真实启动错误，只在 catalog 留下一个空壳会话。
  const useManagedPersistence = shouldUseManagedTerminalPersistence(Boolean(managedPolicy), turn)
  if (useManagedPersistence) {
    const permitsMissingProviderTurnId = managedRecorderAllowsMissingProviderTurnId(args.providerId, args.status)
    if (!args.providerTurnId && !permitsMissingProviderTurnId) {
      throw new Error('managed recorder requires an authoritative Provider turn id')
    }
    if (!timing) throw new Error('managed recorder requires canonical Provider or observed interruption timing')
    await persistManagedTraceProgress({
      cwd: archiveCwd,
      sessionId: args.sessionId,
      providerTurnId: args.providerTurnId,
      providerId: args.providerId,
      runtimeProvider: args.runtimeProvider,
      userDataDir: app.getPath('userData'),
      turn,
      timing,
      status: args.status
    })
    return
  }
  await persistTraceTurnProgress({
    userDataDir: app.getPath('userData'),
    cwd: archiveCwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    runtimeProvider: args.runtimeProvider,
    turn
  })
}

async function archiveTraceTurn(args: ArchiveTraceTurnArgs): Promise<void> {
  await args.beforePersist?.()
  const archiveCwd = args.cwd ?? ''
  const managedPolicy = args.managedRecorderEnabled && archiveCwd && isManagedRecorderProvider(args.providerId)
  if (args.managedRecorderEnabled && !managedPolicy) {
    throw new Error('managed recorder launch policy has no valid workspace/provider identity')
  }
  if (!args.sessionId) {
    if (isProviderlessTerminalTurn(args)) return
    if (managedPolicy) {
      throw new Error('managed recorder requires an authoritative Provider session id')
    }
    return
  }
  const { turn, timing } = buildTraceArchiveTurn(args)
  const useManagedPersistence = shouldUseManagedTerminalPersistence(Boolean(managedPolicy), turn)
  if (useManagedPersistence) {
    if (!timing) {
      throw new Error('managed recorder requires canonical Provider or observed interruption timing')
    }
    const permitsMissingProviderTurnId = managedRecorderAllowsMissingProviderTurnId(args.providerId, args.status)
    if (!args.providerTurnId && !permitsMissingProviderTurnId) {
      throw new Error('managed recorder requires an authoritative Provider turn id')
    }
    if (timing) {
      await commitManagedTraceTurn({
        cwd: archiveCwd,
        sessionId: args.sessionId,
        providerTurnId: args.providerTurnId,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        userDataDir: app.getPath('userData'),
        turn,
        timing,
        status: args.status
      }, { commitHookEnv: args.commitHookEnv, requireManaged: true })
      return
    }
  }
  const ok = upsertTraceArchiveTurn({
    cwd: archiveCwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    runtimeProvider: args.runtimeProvider,
    userDataDir: app.getPath('userData'),
    turn
  })
  if (!ok) throw new Error(`trace archive write failed for ${args.runId}`)
  await deleteTraceTurnProgress(app.getPath('userData'), args.runId)
}

// 注：原来扫 ~/.claude/projects 列举 transcript 的逻辑（readHeadPreview/readCwd/collectSessions）
// 已移除——app 只列自己起过的会话（见 app-sessions），不采集 terminal 裸跑的 claude。

const rendererAutoReloadCooldownMs = 60_000

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 860,
    title: 'Scry',
    show: false,
    backgroundColor: windowBackgroundColor('dark'),
    ...windowTitleBarOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Background fixtures still need real animation frames and bounded UI waits.
      backgroundThrottling: !isOwnedTestApp
    }
  })
  const createdWindow = win
  createdWindow.on('focus', () => {
    // A completion received while the app was in the background is considered
    // read once its already-selected conversation becomes visible again.
    // DockBadgeState clears only that conversation and preserves other unread runs.
    dockBadge.focusWindow()
  })
  createdWindow.on('closed', () => {
    terminalOutput.detachRenderer()
    // renderer 消失后没人再 ACK 在途 trace 字节；不清零会让下一个窗口永久卡在 high-water。
    traceOutput.reset()
    if (win === createdWindow) win = null
  })
  createdWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    terminalOutput.detachRenderer()
    traceOutput.reset()
  })
  // Renderer 崩溃后窗口不会自己恢复，只剩背景色（黑屏）。自动重载一次；冷却期内再次崩溃说明
  // 可能是确定性崩溃，改为询问用户，避免无限重载循环。重载后 app:rendererReady 会重新驱动 trace 投递。
  let lastRendererAutoReloadAt = Number.NEGATIVE_INFINITY
  createdWindow.webContents.on('render-process-gone', (_event, details) => {
    terminalOutput.detachRenderer()
    traceOutput.reset()
    console.error(`[scry] renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason === 'clean-exit' || isShuttingDown || createdWindow.isDestroyed()) return
    const now = Date.now()
    if (now - lastRendererAutoReloadAt >= rendererAutoReloadCooldownMs) {
      lastRendererAutoReloadAt = now
      createdWindow.webContents.reload()
      return
    }
    void dialog.showMessageBox(createdWindow, {
      type: 'error',
      message: '界面进程反复崩溃',
      detail: `原因：${details.reason}（exit ${details.exitCode}）。`,
      buttons: ['重新加载', '关闭窗口'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (createdWindow.isDestroyed()) return
      if (response === 0) {
        lastRendererAutoReloadAt = Date.now()
        createdWindow.webContents.reload()
      } else {
        createdWindow.close()
      }
    })
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[scry] preload failed: ${preloadPath}`, error)
  })
  const rendererSession = win.webContents.session
  configureRendererPermissions(rendererSession, rendererEntryUrl)
  rendererSession.webRequest.onBeforeRequest((details, callback) => {
    callback(isAllowedRendererRequest(details.url, rendererEntryUrl) ? {} : { cancel: true })
  })
  rendererSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [rendererContentSecurityPolicy(rendererEntryUrl)]
      }
    })
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, rendererEntryUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (isTrustedRendererUrl(url, rendererEntryUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  let windowShown = false
  const onIpcMessage = (_event: unknown, channel: string): void => {
    if (channel !== 'app:rendererReady' || !win) return
    if (!isTrustedRendererUrl(win.webContents.getURL(), rendererEntryUrl)) return
    // renderer 已经挂好监听：恢复 trace 投递，而不是靠定时器轮询等它就绪。
    // 监听器刻意不在首次 show 之后摘除，这样 renderer 重挂后也能重新驱动投递。
    traceOutput.rendererReady()
    showWindow()
  }
  const showWindow = (): void => {
    if (isOwnedTestApp || windowShown || !win || win.isDestroyed()) return
    windowShown = true
    win.show()
  }
  // ready-to-show 只代表第一帧能画，React 还没恢复 workspace/active run；此时 show 会先闪欢迎页。
  // Renderer 在关键快照稳定后主动发 app:rendererReady。保留超时兜底，避免 renderer 异常时窗口永久不可见。
  win.webContents.on('ipc-message', onIpcMessage)
  win.webContents.on('context-menu', (_event, params) => {
    if (!win) return
    if (shouldShowImageContextMenu(params)) {
      const { x, y } = params
      Menu.buildFromTemplate(imageContextMenuTemplate(() => {
        if (!createdWindow.isDestroyed()) createdWindow.webContents.copyImageAt(x, y)
      })).popup({ window: win })
      return
    }
    if (shouldShowEditContextMenu(params)) {
      Menu.buildFromTemplate(editContextMenuTemplate(params)).popup({ window: win })
    }
  })
  setTimeout(showWindow, 2500)
  if (useDevelopmentRenderer) {
    win.loadURL(rendererEntryUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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

handleTrusted('app:setTheme', (_event, theme: unknown) => {
  if (theme !== 'dark' && theme !== 'light') throw new Error('无效的界面主题')
  nativeTheme.themeSource = theme
  win?.setBackgroundColor(windowBackgroundColor(theme))
  return true as const
})

handleTrusted('app:copyText', (_event, text: unknown) => writeClipboardText(text, clipboard))
handleTrusted('app:performanceDiagnosticsEnabled', () => performanceRecordingEnabled())
handleTrusted('app:reportRendererPerformance', (_event, sample: unknown) => {
  if (!isRendererPerformanceSample(sample)) throw new Error('无效的 renderer 性能样本')
  if (!performanceRecordingEnabled()) return false
  recordRendererPerformance(sample)
  return true
})

handleTrusted('agent:detectFast', () => {
  if (smokeProviderEnabled) return smokeDetectedAgents
  const detected = detectAgentsFast().flatMap((agent) => {
    const providerId = providerIdForAgentId(agent.id)
    if (!providerId) return []
    return [{
      ...agent,
      ...(providerId === 'pi'
        ? { agentProfileId: agent.id, runtimeProvider: 'pi_rpc' as const, transport: 'JSONL RPC subprocess' }
        : {})
    }]
  })
  return [
    ...detected,
    ...storedPiProfilesNotDetected(detected).map((profile) => ({
      id: profile.id,
      name: profile.label,
      bin: basename(profile.executable),
      path: profile.executable,
      agentProfileId: profile.id,
      runtimeProvider: 'pi_rpc' as const,
      transport: 'JSONL RPC subprocess'
    }))
  ]
})

handleTrusted('agent:detect', async () => {
  // 让这次描述用上最新策略；hydrate/refresh 自己吞掉所有失败，不会阻断探测。
  await providerCompatibility.hydrate()
  await providerCompatibility.refresh()
  // 先异步完成 PATH/版本探测，让 descriptor 的同步 fallback 命中已知路径，避免阻塞主进程。
  // Capability disabling alone does not disable discovery's real --version subprocesses.
  const detected = smokeProviderEnabled ? smokeDetectedAgents : await detectInstalledAgents()
  const descriptors = await providerRegistry.describe()
  return composeProviderDetectionResults({
    detected,
    descriptors,
    storedPiProfiles: smokeProviderEnabled ? [] : storedPiProfilesNotDetected(detected),
    probeStoredPiProfile: async (profile) => probeCliVersion(profile.executable, ['--version'], {
      env: await piRpcEnvironment(profile),
      timeout: PI_VERSION_PROBE_TIMEOUT_MS
    }),
    // adapter 自述的版本经常是空，本机真实版本来自 CLI 探测；用最终生效的版本重算判定。
    compatibility: (providerId, version) => providerCompatibility.advisory(providerId, version)
  })
})

handleTrusted('agent:addPiProfile', async () => {
  const result = await dialog.showOpenDialog({ title: '选择 Pi Agent 启动器', properties: ['openFile'] })
  if (result.canceled || result.filePaths.length === 0) return null
  try {
    const profile = piProfileForExecutable(result.filePaths[0])
    const versionProbe = await probeCliVersion(profile.executable, ['--version'], {
      env: await piRpcEnvironment(profile),
      timeout: PI_VERSION_PROBE_TIMEOUT_MS
    })
    await probePiAgent(profile, currentCwd)
    const stored = piProfileStore().add(profile)
    const descriptor = (await providerRegistry.describe()).find((entry) => entry.id === 'pi')
    if (!descriptor) throw new Error('Pi Provider 未注册')
    return {
      id: stored.id,
      name: stored.label,
      bin: basename(stored.executable),
      path: stored.executable,
      version: versionProbe.version ?? descriptor.version,
      runtimeProvider: descriptor.runtimeProvider,
      transport: descriptor.transport,
      capabilities: descriptor.capabilities,
      health: descriptor.health,
      agentProfileId: stored.id
    }
  } catch (error) {
    const options = {
      type: 'error' as const,
      title: '无法添加 Pi Agent',
      message: '所选启动器未通过 Pi RPC 握手',
      detail: String((error as Error).message)
    }
    if (win && !win.isDestroyed()) await dialog.showMessageBox(win, options)
    else await dialog.showMessageBox(options)
    return null
  }
})

handleTrusted('agent:removePiProfile', (_event, id: unknown) => {
  if (typeof id !== 'string' || !/^pi:[a-f0-9]{16}$/.test(id)) throw new Error('无效的 Pi Agent Profile')
  piProfileStore().remove(id)
  return true as const
})

handleTrusted('agent:providerDescriptors', () => providerRegistry.describe())

handleTrusted('agent:recentFolders', () => recentStore().load())
handleTrusted('agent:removeRecentFolder', (_event, dir: string) => recentStore().remove(dir))

handleTrusted('agent:chooseFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || r.filePaths.length === 0) return null
  const dir = canonicalExistingDirectory(r.filePaths[0])
  invalidateSessionHistoryLoad('workspace selection changed')
  rememberProject(dir)
  setCurrentCwd(dir)
  return dir
})

handleTrusted('agent:clipboardImage', () => {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const size = image.getSize()
  const bytes = image.toPNG()
  return {
    kind: 'image',
    name: `clipboard-${Date.now().toString(36)}.png`,
    mimeType: 'image/png',
    dataBase64: bytes.toString('base64'),
    size: bytes.byteLength,
    width: size.width,
    height: size.height
  } satisfies AgentInputAttachment
})

async function openLocalPath(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

const sourceControl = new SourceControlService({
  userData: app.getPath('userData'),
  authorizeDirectory: resolveKnownProjectDirectory,
  unsettledDirectories: () => runs.unsettledStates().map(run => run.cwd)
})
registerSourceControlIpc(handleTrusted, sourceControl)

handleTrusted('workspace:list', (_event, request: WorkspaceListRequest) =>
  listWorkspace(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:resolveFile', async (_event, request: WorkspacePathRequest) =>
  resolveWorkspaceFileOpenTarget(request.cwd === '~'
    ? request
    : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }, homeFileAccess))
handleTrusted('workspace:read', (_event, request: WorkspacePathRequest) =>
  readWorkspaceFile(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:readPage', (_event, request: WorkspaceFilePageRequest) =>
  readWorkspaceFilePage(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:readKnown', async (_event, request: WorkspacePathRequest) =>
  readWorkspaceFile(homeFileAccess.isReadOnlyTarget(request.cwd)
    ? await homeFileAccess.authorize(request)
    : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }))
handleTrusted('workspace:readPageKnown', async (_event, request: WorkspaceFilePageRequest) =>
  readWorkspaceFilePage(homeFileAccess.isReadOnlyTarget(request.cwd)
    ? await homeFileAccess.authorize(request)
    : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }))
handleTrusted('workspace:openExternal', (_event, request: WorkspacePathRequest) =>
  openWorkspaceFileExternally(
    authorizedWorkspaceRequest(currentCwd, request),
    openLocalPath,
    {
      roots: [...knownProjectDirectories()],
      choose: async (candidates) => {
        const selectable = candidates.length > 0 && candidates.length <= 5
        const options = {
          type: 'question' as const,
          message: selectable ? '文件在其他项目中，是否打开？' : '当前会话目录中未找到文件',
          detail: `相对路径：${request.path}\n会话目录：${request.cwd}\n\n` + (selectable
            ? candidates.map((candidate, i) => `${i + 1}. ${join(candidate.cwd, candidate.path)}`).join('\n')
            : candidates.length > 5 ? '多个已知项目包含此路径，请切换到目标项目再打开。'
              : '未在已知项目中找到可打开的同路径文件。请确认文件是否已移动，或让 Agent 提供完整路径。'),
          buttons: selectable ? ['取消', ...candidates.map((candidate, i) => `打开 ${i + 1} · ${basename(candidate.cwd)}`)] : ['关闭'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        }
        const result = win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options)
        const selected = selectable ? candidates[result.response - 1] : undefined
        return selected ? { ...selected, cwd: resolveKnownProjectDirectory(selected.cwd) } : null
      }
    }
  ))
handleTrusted('workspace:openKnownExternal', async (_event, request: WorkspacePathRequest) =>
  openWorkspaceFileExternally(
    homeFileAccess.isReadOnlyTarget(request.cwd)
      ? await homeFileAccess.authorize(request)
      : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) },
    openLocalPath
  ))
handleTrusted('workspace:write', (_event, request: WorkspaceWriteRequest) =>
  writeWorkspaceFile(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:create', (_event, request: WorkspaceCreateRequest) =>
  createWorkspaceEntry(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:rename', (_event, request: WorkspaceRenameRequest) =>
  renameWorkspaceEntry(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:move', (_event, request: WorkspaceMoveRequest) =>
  moveWorkspaceEntry(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:trash', (_event, request: WorkspacePathRequest) =>
  trashWorkspaceEntry(authorizedWorkspaceRequest(currentCwd, request), (path) => shell.trashItem(path)))

handleTrusted('terminal:start', async (event, request: TerminalStartRequest) => {
  const manager = await getTerminalManager()
  if (isShuttingDown || !rendererCanReceive()) throw new Error('终端窗口已关闭')
  assertTrustedIpcEvent(event)
  const session = manager.start(request)
  const ownershipEpoch = terminalOutput.started(session.id)
  try {
    assertTrustedIpcEvent(event)
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
  } catch (error) {
    terminalOutput.detach(session.id)
    throw error
  }
  if (isShuttingDown) {
    terminalOutput.terminalClosed(session.id)
    manager.close({ id: session.id })
    throw new Error('终端窗口已关闭')
  }
  return { ...session, ownershipEpoch }
})
handleTrusted('terminal:active', async (event) => {
  const manager = await getTerminalManager()
  assertTrustedIpcEvent(event)
  return manager.activeSessions()
})
handleTrusted('terminal:attach', async (event, request: { id: string }) => {
  const manager = await getTerminalManager()
  assertTrustedIpcEvent(event)
  const session = manager.session(request?.id)
  const ownershipEpoch = terminalOutput.attach(session.id)
  const catchUp = await manager.recordingCheckpoint(session.id)
  try {
    assertTrustedIpcEvent(event)
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
  } catch (error) {
    terminalOutput.detach(session.id)
    throw error
  }
  return { ...session, ownershipEpoch, catchUp }
})
handleTrusted('terminal:write', async (event, request: TerminalWriteRequest) => {
  const manager = await getTerminalManager()
  if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
  assertTrustedIpcEvent(event)
  if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
  manager.write(request)
  return true as const
})
handleTrusted('terminal:resize', async (event, request: TerminalResizeRequest) => {
  const manager = await getTerminalManager()
  if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
  assertTrustedIpcEvent(event)
  if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
  manager.resize(request)
  return true as const
})
handleTrusted('terminal:recordingList', async (event, request: TerminalRecordingListRequest) => {
  const manager = await getTerminalManager()
  assertTrustedIpcEvent(event)
  const cwd = currentCwd
  const page = await manager.listRecordings(request)
  assertTrustedIpcEvent(event)
  if (cwd !== currentCwd) throw new Error('terminal_recording_workspace_changed')
  return page
})
handleTrusted('terminal:recordingRead', async (event, request: TerminalRecordingRequest) => {
  const manager = await getTerminalManager()
  assertTrustedIpcEvent(event)
  return manager.readRecording(request)
})
handleTrusted('terminal:recordingDelete', async (event, request: TerminalCloseRequest) => {
  const manager = await getTerminalManager()
  assertTrustedIpcEvent(event)
  await manager.deleteRecording(request?.id)
  assertTrustedIpcEvent(event)
  return true as const
})
handleTrusted('terminal:ready', (_event, request: TerminalOwnershipRequest) => {
  if (!request || typeof request.id !== 'string' || !request.id.startsWith('terminal-')) throw new Error('终端 ready 无效')
  return terminalOutput.ready(request.id, request.ownershipEpoch)
})
handleTrusted('terminal:ack', (_event, request: TerminalOwnershipRequest & { bytes: number }) => {
  if (!request || typeof request.id !== 'string') throw new Error('终端输出确认无效')
  return terminalOutput.ack(request.id, request.ownershipEpoch, request.bytes)
})
handleTrusted('terminal:close', async (event, request: TerminalOwnershipRequest) => {
  const manager = await getTerminalManager()
  if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
  assertTrustedIpcEvent(event)
  if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
  terminalOutput.terminalClosed(request.id)
  manager.close(request)
  return true as const
})

handleTrusted('agent:setCwd', (_e, dir: string | null) => {
  const cwd = typeof dir === 'string' && dir.trim() ? resolveKnownProjectDirectory(dir) : undefined
  if (cwd !== currentCwd) invalidateSessionHistoryLoad('workspace changed')
  setCurrentCwd(cwd)
  return cwd ?? null
})

handleTrusted('agent:newSession', async (_event, context: ProviderContext) => {
  dockBadge.view(null, Boolean(win?.isFocused()))
  const cwd = context?.cwd ?? currentCwd
  if (context?.providerId) {
    const normalizedContext = { ...context, cwd }
    const key = providerContextKey(context.providerId, cwd ?? '', context.agentProfileId)
    resetSessionContext(key)
    await providerRegistry.invalidateContext(normalizedContext)
  }
  return true
})

async function forkManagedConversation(input: Parameters<NonNullable<ConversationServiceDeps['forkNative']>>[0]): Promise<string> {
  const { source, binding, turn, permissionMode, beforeFork } = input
  const cwd = resolveKnownProjectDirectory(source.cwd)
  const { providerId, agentProfileId } = binding
  const adapter = providerRegistry.get(providerId)
  if (!adapter.forkSession) throw new Error('该轮的 Provider 不支持原生分支')
  if (providerId === 'pi' && permissionMode !== 'full_access') throw new Error('Pi 原生分支需要明确选择本机完全访问')
  const lease = providerOperationGate.acquireOperation(providerOperationKey(providerId, agentProfileId))
  if (!lease.ok) throw new Error('源 Provider 正在认证，不能创建分支')
  try {
    return await contextAdmission.run(providerContextKey(providerId, cwd, agentProfileId), async () => {
      if (runs.unsettledStates().some(run => run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd)) {
        throw new Error('源 Provider 仍在运行或保存证据，请等待收敛')
      }
      if (!turn.archive) throw new Error('分支轮次缺少已提交归档')
      const archive = await readTraceArchiveAsync({ userDataDir: app.getPath('userData'), providerId, cwd, sessionId: turn.archive.sessionId })
      const recorded = archive?.turns.find(item => item.runId === turn.runId)
      if (!recorded?.providerTurnId) throw new Error('归档没有稳定的原生轮次边界')
      const request = { providerId, agentProfileId, cwd, sourceSessionId: binding.nativeSessionId!, sourceRunId: turn.runId,
        sourceProviderTurnId: recorded.providerTurnId, sourceForkTurnId: recorded.forkTurnId ?? recorded.providerTurnId, permissionMode }
      verifyForkArchiveBoundary(archive, request)
      const codexHookTrust = providerId === 'codex' ? await resolveCodexHookTrust(cwd) : []
      const mcpSnapshot = providerId === 'pi' ? null : await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
      const result = await adapter.forkSession!.fork({ ...request, expectedContinuationKey: binding.continuationKey,
        beforeFork, codexHookTrust, mcpExecution: authorizedMcpExecution(mcpSnapshot) })
      if (!result.externalSessionId) throw new Error('Provider 未返回原生分支身份')
      return result.externalSessionId
    })
  } finally { lease.release() }
}

handleTrusted('agent:forkSession', async (_event, payload: unknown): Promise<AgentForkSessionResult> => {
  const request = normalizeAgentForkSessionRequest(payload)
  const providerId = request.providerId
  const cwd = request.cwd ? resolveKnownProjectDirectory(request.cwd) : currentCwd
  const catalogCwd = cwd ?? ''
  const agentProfileId = request.agentProfileId
  const adapter = providerRegistry.get(providerId)
  const forkSession = adapter.forkSession
  if (!forkSession) throw new Error('当前 Provider 不支持从指定轮次创建分支')
  const lifecycleKey = providerOperationKey(providerId, agentProfileId)
  const lease = providerOperationGate.acquireOperation(lifecycleKey)
  if (!lease.ok) throw new Error('当前 Provider 正在认证 MCP，已拒绝创建分支')
  const contextKey = providerContextKey(providerId, catalogCwd, agentProfileId)
  try {
    return await contextAdmission.run(contextKey, async () => {
      await startupManagedRecovery
      await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: request.sourceSessionId })
      const archive = await readTraceArchiveAsync({
        userDataDir: app.getPath('userData'),
        providerId,
        cwd: catalogCwd,
        sessionId: request.sourceSessionId
      })
      const { source, prefix } = verifyForkArchiveBoundary(archive, request)
      const codexHookTrust = providerId === 'codex' && cwd ? await resolveCodexHookTrust(cwd) : []
      const openCodePluginTrust = providerId === 'opencode' && cwd
        ? await resolveOpenCodePluginTrust(cwd)
        : undefined
      const mcpExecutionSnapshot = providerId === 'pi'
        ? null
        : await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
      await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: request.sourceSessionId })
      const forked = await forkSession.fork({
        ...request,
        cwd,
        agentProfileId,
        codexHookTrust,
        openCodePluginTrust,
        mcpExecution: authorizedMcpExecution(mcpExecutionSnapshot)
      })
      if (!forked.externalSessionId) throw new Error('Provider 未返回分支会话 ID')
      cloneForkArchiveTurns({
        turns: prefix,
        targetSessionId: forked.externalSessionId,
        providerId,
        runtimeProvider: adapter.runtimeProvider,
        cwd: catalogCwd
      })
      resetSessionContext(contextKey)
      sessionByContext.set(contextKey, forked.externalSessionId)
      invalidateSessionHistoryLoad('session forked')
      appSessionStore().record({
        providerId,
        agentProfileId,
        runtimeProvider: adapter.runtimeProvider,
        externalSessionId: forked.externalSessionId,
        cwd: catalogCwd,
        prompt: source.userText
      })
      if (cwd) rememberProject(cwd)
      return { externalSessionId: forked.externalSessionId }
    })
  } finally {
    lease.release()
  }
})

handleTrusted('agent:invalidateProviderContext', async (_event, context: ProviderContext) => {
  const normalizedContext = { ...context, cwd: context.cwd ?? currentCwd }
  await providerRegistry.invalidateContext(normalizedContext)
  return true
})
handleTrusted('agent:listSkills', (_e, context: ProviderContext) =>
  withProviderOperation(context.providerId, () => providerRegistry.listSkills(context), context.agentProfileId)
)
handleTrusted('agent:mcpSnapshot', async (_e, p: { context: ProviderContext; refresh?: boolean }) => {
  if (p.context.providerId === 'pi') {
    return withProviderOperation(
      p.context.providerId,
      () => providerRegistry.mcpSnapshot(p.context, p.refresh === true),
      p.context.agentProfileId
    )
  }
  if (!p.refresh) return providerRegistry.mcpSnapshot(p.context, false)
  return withProviderOperation(p.context.providerId, async () => {
    const snapshot = p.refresh ? await ensureMcpExecutionAuthorized(p.context, 'live') : null
    return providerRegistry.mcpSnapshot(p.context, p.refresh, authorizedMcpExecution(snapshot))
  }, p.context.agentProfileId)
})
handleTrusted('agent:testMcp', async (_e, p: { context: ProviderContext; targetId: string }) => {
  if (p.context.providerId === 'pi') return providerRegistry.testMcp(p.context, p.targetId)
  return withProviderOperation(p.context.providerId, async () => {
    const snapshot = await ensureMcpExecutionAuthorized(p.context, `test:${p.targetId}`, p.targetId)
    return providerRegistry.testMcp(p.context, p.targetId, authorizedMcpExecution(snapshot))
  }, p.context.agentProfileId)
})
handleTrusted('agent:reauthenticateMcp', async (_e, p: { context: ProviderContext; targetId: string }) => {
  const canonicalCwd = canonicalProviderCwd(p.context.cwd)
  const authKey = providerOperationKey(p.context.providerId, p.context.agentProfileId)
  const authLease = providerOperationGate.acquireAuthentication(authKey)
  if (!authLease.ok) {
    throw new Error(authLease.blockedBy === 'authentication'
      ? '当前 Provider 正在认证 MCP，请等待当前流程完成'
      : '当前 Provider 正在执行其他操作，请等待完成后再认证 MCP')
  }
  const active = runs.activeStates().find((run) => !run.done && run.providerId === p.context.providerId)
  if (active) {
    authLease.release()
    throw new Error('当前 Provider 正在执行会话，请等待本轮结束后再认证 MCP')
  }
  try {
    const snapshot = await ensureMcpExecutionAuthorized(p.context, `auth:${p.targetId}`, p.targetId)
    const normalizedContext = { ...p.context, cwd: snapshot?.cwd ?? canonicalCwd }
    const result = await providerRegistry.reauthenticateMcp(
      normalizedContext,
      p.targetId,
      authorizedMcpExecution(snapshot),
      {
        openExternal: async (url) => {
          if (!isSafeOAuthAuthorizationUrl(url)) throw new Error('Provider 返回了不安全的 MCP OAuth 授权地址')
          await shell.openExternal(url)
        },
        prepareLoopbackCallback: () => prepareOAuthLoopback()
      }
    )
    if (snapshot) {
      const verified = buildMcpExecutionSnapshot({
        providerId: p.context.providerId,
        cwd: p.context.cwd,
        homeDir,
        settingSources: p.context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
        env: shellEnv(),
        selectedTargetId: p.targetId
      })
      if (verified.errors.length > 0 || verified.fingerprint !== snapshot.fingerprint) {
        if (result.data?.status === 'authenticated' || result.data?.status === 'authenticated-unverified') {
          return {
            ...result,
            data: {
              ok: false,
              status: 'authenticated-unverified' as const,
              error: '认证期间 MCP 配置发生变化；凭据可能已更新，但当前连接状态不再可信，请重新检测'
            }
          }
        }
        throw new Error('MCP 配置在认证期间发生变化；本次状态不再可信，请重新检测后操作')
      }
    }
    return result
  } finally {
    authLease.release()
  }
})
handleTrusted('agent:mcpGuardScan', (_e, context: ProviderContext) => {
  if (providerRegistry.isDisabled(context.providerId)) {
    return capabilityUnavailable(context, 'unsupported', '该 Provider 已通过 SCRY_DISABLED_PROVIDERS 禁用')
  }
  if (context.providerId === 'pi') {
    return capabilityUnavailable(context, 'unsupported', 'Pi snapshot 仅返回脱敏后的有效配置与运行态，不包含 MCP Guard 所需的可执行配置和凭据指纹')
  }
  const snapshot = buildMcpExecutionSnapshot({
    providerId: context.providerId,
    cwd: context.cwd,
    homeDir,
    settingSources: context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
    env: shellEnv()
  })
  const report = snapshot.report
  if (!isMcpGuardReport(report)) throw new Error('mcpguard 生成了不一致的扫描报告')
  const issues = [...snapshot.errors, ...snapshot.warnings]
  return {
    ...context,
    mode: 'read',
    state: issues.length > 0 ? 'degraded' : 'ready',
    data: report,
    ...(issues.length > 0 ? { reason: issues.join('；') } : {}),
    observedAt: Date.now()
  }
})
handleTrusted('agent:listCommands', (_e, context: ProviderContext) =>
  withProviderOperation(context.providerId, () => providerRegistry.listCommands(context), context.agentProfileId)
)
handleTrusted('agent:runControls', (_e, context: ProviderContext) =>
  withProviderOperation(context.providerId, () => providerRegistry.runControls(context), context.agentProfileId)
)

// 单目录会话列表（当前工作目录）：只列 app 自己起过的会话
handleTrusted('agent:listSessions', (_e, context: ProviderContext) => {
  return appSessionStore().listSessions(context.cwd ?? '', context.providerId, context.agentProfileId)
})

// 左侧栏项目目录独立于会话保留；老数据从 recent folders 与 app 会话 catalog 一次性补齐。
handleTrusted('agent:listProjects', () => listProjectCatalog())
handleTrusted('agent:catalogHealth', () => appSessionStore().health())
async function adoptLegacyConversation(input: unknown, fingerprint?: string, requireHandoff = false) {
  const source = parseConversationLegacySource(input)
  source.cwd = resolveKnownProjectDirectory(source.cwd)
  return contextAdmission.run(providerContextKey(source.providerId, source.cwd, source.agentProfileId), async () => {
    await startupManagedRecovery
    const catalog = appSessionStore().load().find(session => session.providerId === source.providerId &&
      session.agentProfileId === source.agentProfileId && session.cwd === source.cwd &&
      (session.externalSessionId === source.externalSessionId || session.sessionId === source.externalSessionId))
    if (!catalog) throw new Error('迁移源不属于已登记的 App 会话')
    source.externalSessionId = catalog.externalSessionId ?? catalog.sessionId
    const reservations = [source.externalSessionId, catalog.sessionId, catalog.runId].filter((id): id is string => Boolean(id))
      .map(id => providerSessionKey(source.providerId, source.cwd, id))
    // Reserve before the first asynchronous read so legacy metadata cannot change
    // between the catalog snapshot and durable ownership publication.
    for (const key of reservations) adoptingSessionKeys.add(key)
    try {
      const existing = (await conversationStore().list(source.cwd)).find(conversation => conversation.bindings.some(binding =>
        binding.providerId === source.providerId && binding.agentProfileId === source.agentProfileId && binding.nativeSessionId === source.externalSessionId))
      if (existing) {
        if (existing.deletion) throw new Error('旧会话正在删除或已删除，不能重新迁入')
        const original = existing.bindings[0]
        if (!existing.adoptionFingerprint || (fingerprint !== undefined && existing.adoptionFingerprint !== fingerprint) || original.providerId !== source.providerId ||
          original.agentProfileId !== source.agentProfileId || original.nativeSessionId !== source.externalSessionId) throw new Error('旧会话已归属统一对话，请打开其稳定条目')
        const adopted = (await conversationService().list(source.cwd)).find(conversation => conversation.id === existing.id)!
        if (fingerprint === undefined) return { source, fingerprint: existing.adoptionFingerprint, title: adopted.title,
          turnCount: adopted.turnCount, adoptedConversation: adopted }
        return adopted
      }
      await assertLegacyConversationWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })
      if (runs.unsettledStates().some(run => run.providerId === source.providerId && run.agentProfileId === source.agentProfileId && run.cwd === source.cwd) ||
        [source.externalSessionId, catalog.sessionId, catalog.runId].some(id => id && deletingSessions.has(providerSessionKey(source.providerId, source.cwd, id)))) {
        throw new Error('源 Provider 仍在执行、保存证据或删除；请等待收敛后迁移')
      }
      const prepared = await prepareConversationAdoption(app.getPath('userData'), source, catalog, requireHandoff)
      if (fingerprint === undefined) return prepared.preview
      if (prepared.preview.fingerprint !== fingerprint) throw new Error('迁移源已变化，请重新预览；旧入口保留')
      const conversation = await conversationStore().create(source.cwd, prepared.seed)
      invalidateSessionHistoryLoad('session adopted into logical conversation')
      win?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: conversation.id })
      return (await conversationService().list(source.cwd)).find(item => item.id === conversation.id)!
    } finally { for (const key of reservations) adoptingSessionKeys.delete(key) }
  })
}
handleTrusted('conversation:fork', async (_event, request: unknown) => {
  await startupManagedRecovery
  const result = await conversationService().fork(request)
  invalidateSessionHistoryLoad('logical conversation fork')
  win?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: result.id })
  return result
})
handleTrusted('conversation:previewAdoption', async (_event, input: unknown, target?: unknown) => {
  const source = parseConversationLegacySource(input)
  source.cwd = resolveKnownProjectDirectory(source.cwd)
  if (target !== undefined) {
    const request = parseConversationTarget(target)
    // Both directions must remain usable before retiring the legacy entry.
    // These are read-only identity checks, never Provider launches.
    await providerRegistry.continuationKey(source)
    if (request.providerId !== source.providerId || request.agentProfileId !== source.agentProfileId) {
      await providerRegistry.continuationKey({ ...request, cwd: source.cwd })
    }
  }
  return adoptLegacyConversation(source, undefined, target !== undefined)
})
handleTrusted('conversation:adopt', (_event, source: unknown, fingerprint: unknown) => {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('迁移确认指纹无效')
  return adoptLegacyConversation(source, fingerprint)
})
function assertConversationDeletionIdle(conversation: Conversation): void {
  const runIds = new Set(conversation.turns.map(turn => turn.runId))
  if (runs.unsettledStates().some(run => runIds.has(run.runId))) throw new Error('对话仍有运行或证据保存未收敛，不能删除')
}

async function prepareConversationDeletion(conversation: Conversation) {
  const others = await conversationStore().list(conversation.cwd)
  const catalog = liveConversationDeletionCatalog(others, appSessionStore().load().filter(session => session.cwd === conversation.cwd))
  return resolveConversationDeletionRuns(planConversationDeletion(conversation, others, catalog), target =>
    resolveSessionRunIds({ providerId: target.providerId, cwd: conversation.cwd, externalSessionId: target.externalSessionId, runIds: new Set() }), others, catalog)
}

handleTrusted('conversation:previewDeletion', async (_event, id: unknown) => {
  if (typeof id !== 'string') throw new Error('对话删除请求无效')
  await startupManagedRecovery
  const conversation = await conversationStore().read(id)
  if (!conversation || (conversation.deletion?.status === 'complete' && !conversation.deletion.retainedCopies)) throw new Error('对话不存在或没有待核对的保留副本')
  assertConversationDeletionIdle(conversation)
  return prepareConversationDeletion(conversation)
})
handleTrusted('conversation:delete', async (_event, id: unknown, fingerprint: unknown): Promise<ConversationDeletionResult> => {
  if (typeof id !== 'string' || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('对话删除确认无效')
  return contextAdmission.run(`conversation-delete:${id}`, async () => {
    await startupManagedRecovery
    const original = await conversationStore().read(id)
    if (!original) throw new Error('找不到统一对话')
    if (original.deletion?.status === 'complete') {
      if (original.deletion.fingerprint === fingerprint) return original.deletion.result!
      if (!original.deletion.retainedCopies) throw new Error('对话已删除，没有待核对的保留副本')
    }
    const { conversation, plan } = await contextAdmission.runMany(original.bindings.map(binding => providerContextKey(binding.providerId, original.cwd, binding.agentProfileId)), async () => {
      const conversation = (await conversationStore().read(id))!
      assertConversationDeletionIdle(conversation)
      const plan = await prepareConversationDeletion(conversation)
      if (plan.fingerprint !== fingerprint) throw new Error('删除范围已变化，请重新预览；本次请求未执行清理')
      await conversationStore().beginDeletion(id, plan.revision, fingerprint, plan.reclaim === true)
      return { conversation, plan }
    })
    const result: ConversationDeletionResult = { ok: false, deleted: [], retained: [
      'workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history',
      'unattributed provider billing aggregates', 'unsent renderer composer drafts',
      'logical ownership tombstone (IDs, hashes and deletion receipt)'
    ], failed: [] }
    for (const target of plan.targets) {
      const scope = `${target.providerId}/${target.agentProfileId ?? 'default'}/${target.externalSessionId}`
      if (target.sharedWith.length) {
        result.retained.push(`shared Scry copies: ${scope} (${target.sharedWith.join(', ')})`)
        continue
      }
      try {
        const receipt = await deleteOneSession({ ...target, cwd: conversation.cwd }, {
          confirm: false, notifyFailure: false, conversationId: id, runIds: target.runIds
        })
        result.deleted.push(...receipt.deleted.map(store => `${scope}: ${store}`))
        result.retained.push(...receipt.retained)
        result.failed.push(...receipt.failed.map(failure => ({ ...failure, store: `${scope}: ${failure.store}` })))
        if (!receipt.ok && !receipt.failed.length) result.failed.push({ store: scope, error: receipt.reason ?? '删除结果未确认' })
      } catch (error) { result.failed.push({ store: scope, error: error instanceof Error ? error.message : String(error) }) }
    }
    try {
      await deleteConversationHistory(app.getPath('userData'), conversation)
      result.deleted.push('frozen handoff bodies')
    } catch (error) { result.failed.push({ store: 'frozen handoff bodies', error: error instanceof Error ? error.message : String(error) }) }
    result.retained = [...new Set(result.retained)]
    result.ok = result.failed.length === 0
    if (!result.ok) result.reason = 'partial_failure'
    await conversationStore().finishDeletion(id, fingerprint, result, plan.targets.some(target => target.sharedWith.length > 0))
    invalidateSessionHistoryLoad('logical conversation deletion')
    win?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: id })
    return result
  })
})
handleTrusted('conversation:update', async (_event, id: unknown, revision: unknown, change: unknown) => {
  if (typeof id !== 'string' || typeof revision !== 'number') throw new Error('对话管理请求无效')
  if (change && typeof change === 'object' && 'kind' in change && change.kind === 'archive') {
    const conversation = await conversationStore().read(id)
    const unsettled = new Set(runs.unsettledStates().map(run => run.runId))
    if (conversation?.turns.some(turn => unsettled.has(turn.runId))) {
      throw new Error('对话仍有运行或证据保存未收敛，不能存档或恢复')
    }
  }
  const result = await conversationService().update(id, revision, change)
  win?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: id })
  return result
})
handleTrusted('conversation:create', async (_event, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
  const resolved = resolveKnownProjectDirectory(cwd)
  rememberProject(resolved)
  const conversation = await conversationService().create(resolved)
  win?.webContents.send('agent:dataUpdated', { kind: 'conversation_changed', conversationId: conversation.id })
  return conversation
})
handleTrusted('conversation:list', (_event, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('统一对话工作区无效')
  return conversationService().list(resolveKnownProjectDirectory(cwd))
})
handleTrusted('conversation:read', (_event, id: unknown, beforeOrdinal?: unknown) => {
  if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
  if (beforeOrdinal !== undefined && (!Number.isSafeInteger(beforeOrdinal) || Number(beforeOrdinal) < 0)) {
    throw new Error('统一对话分页游标无效')
  }
  return conversationService().read(id, beforeOrdinal as number | undefined)
})
handleTrusted('conversation:readItem', (_event, id: unknown, ref: unknown) => {
  if (typeof id !== 'string' || !id.trim()) throw new Error('统一对话 ID 无效')
  return conversationService().readItem(id, ref)
})
handleTrusted('conversation:preview', (_event, id: unknown, request: unknown) => {
  if (typeof id !== 'string' || !id.trim() || !request || typeof request !== 'object') throw new Error('统一对话预览请求无效')
  return conversationService().preview(id, request)
})
handleTrusted('conversation:send', (_event, request: unknown) => {
  if (!request || typeof request !== 'object') throw new Error('统一对话发送请求无效')
  return conversationService().send(request)
})

const projectCwdFromRequest = (value: unknown): string => {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) throw new Error('无效的项目目录')
  return value
}

handleTrusted('agent:setProjectPinned', (_event, cwd: unknown, pinned: unknown) => {
  if (typeof pinned !== 'boolean') throw new Error('无效的项目置顶请求')
  return projectStore().setPinned(projectCwdFromRequest(cwd), pinned)
})

handleTrusted('agent:renameProject', (_event, cwd: unknown, name: unknown) => {
  const label = typeof name === 'string' ? name.trim() : ''
  if (!label || label.length > 120) throw new Error('项目名称必须为 1–120 个字符')
  return projectStore().rename(projectCwdFromRequest(cwd), label)
})

handleTrusted('agent:removeProject', (_event, cwd: unknown) => {
  const dir = projectCwdFromRequest(cwd)
  projectStore().remove(dir)
  recentStore().remove(dir)
  return true as const
})

handleTrusted('agent:revealProject', (_event, cwd: unknown) => {
  shell.showItemInFolder(projectCwdFromRequest(cwd))
  return true as const
})

// 加载一个历史会话：解析 transcript 成对话轮次，并把它设为当前会话（后续对话会 resume）
function sessionHistoryCacheKey(payload: ProviderContext, cwd: string): string {
  return `${providerContextKey(payload.providerId, cwd, payload.agentProfileId)}\u0000${payload.externalSessionId ?? ''}`
}

// Hook 命令附写只对当前页的事件做，而不是对整个会话的全部事件做。
function pageWithHookCommands(
  page: SessionHistoryPage,
  hookConfig: ReturnType<typeof loadClaudeHookConfig> | null
): SessionHistoryPage {
  if (!hookConfig) return page
  return {
    ...page,
    turns: page.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((event) => attachConfiguredHookCommands(event, hookConfig))
    }))
  }
}

handleTrusted('agent:loadSession', async (_e, payload: ProviderContext, request?: SessionHistoryPageRequest) => {
  if (!payload.externalSessionId) return null
  const perf = new PerformanceTrace('session_history.load', { provider: payload.providerId })
  loadSessionAbortController?.abort(new Error('session history request superseded'))
  const requestController = new AbortController()
  loadSessionAbortController = requestController
  const { signal } = requestController
  try {
    const requestRevision = ++loadSessionRevision
    const catalogMatches = appSessionStore().load().filter((session) =>
      session.providerId === payload.providerId && session.agentProfileId === payload.agentProfileId &&
      (session.sessionId === payload.externalSessionId || session.externalSessionId === payload.externalSessionId)
    )
    const requestedCwd = payload.cwd?.trim()
      ? resolveKnownProjectDirectory(payload.cwd)
      : payload.cwd === '' ? '' : undefined
    const catalogSession = catalogMatches.length === 1
      ? catalogMatches[0]
      : catalogMatches.find((session) => session.cwd === requestedCwd)
    if (!catalogSession) throw new Error('会话不属于当前 Scry catalog 或身份不唯一')
    perf.mark('catalog', { matches: catalogMatches.length })
    const cwd = catalogSession.cwd ? resolveKnownProjectDirectory(catalogSession.cwd) : ''
    if (requestedCwd !== undefined && requestedCwd !== cwd) throw new Error('会话工作目录与 catalog 不一致')
    const userDataDir = app.getPath('userData')
    const archiveArgs = { cwd, sessionId: payload.externalSessionId, providerId: payload.providerId, userDataDir }
    const fp =
      payload.providerId === 'claude' && cwd
        ? resolveTranscriptPath({ cwd, sessionId: payload.externalSessionId, userDataDir })
        : null
    // Pi's model-context enrichment is turn-local, so apply it to each archive page.
    // Qoder's Provider-owned history reconciliation still requires the full source.
    const archivePaged = sessionArchiveIsPageable(payload.providerId, fp)
    let archivePage: Awaited<ReturnType<typeof readTraceArchivePageAsync>> | null
    let archived: TraceArchive | null
    const matchingRuns = runs.unsettledStates()
      .filter((run) => sessionLoadMatchesRun(run, {
        providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd,
        externalSessionId: payload.externalSessionId
      }))
      .map((run) => ({ done: run.done, settled: runs.get(run.runId)!.control.settled }))
    try {
      [archivePage, archived] = await readSessionHistoryAfterCompletedRuns(matchingRuns, signal, async () => {
        const page = archivePaged
          ? await readTraceArchivePageAsync(archiveArgs, { limit: request?.limit }, signal)
          : null
        const archive = page?.archive ?? (archivePaged ? null : await readTraceArchiveAsync(archiveArgs, signal))
        return [page, archive] as const
      })
    } catch (error) {
      signal.throwIfAborted()
      throw error
    }
    if (archived) {
      for (const turn of archived.turns) {
        turn.items = await persistTraceToolEvents(userDataDir, cwd, turn.items)
        signal.throwIfAborted()
      }
    }
    perf.mark('archive', {
      archiveTurns: archived?.turns.length ?? 0,
      archiveTotalTurns: archivePage?.totalTurns ?? archived?.turns.length ?? 0,
      archiveTurnFilesRead: archivePage?.turnFilesRead ?? archived?.turns.length ?? 0
    })
    let turns: ParsedTurn[] = []
    let transcriptBytes = 0
    let transcriptParsedBytes = 0
    let transcriptCache = 'unavailable'
    if (fp) {
      try {
        if (isShuttingDown) throw new Error('transcript parser disposed')
        const parsed = await readCachedTranscript({
          path: fp,
          runId: payload.externalSessionId,
          contextKey: providerContextKey(payload.providerId, cwd, payload.agentProfileId),
          signal
        })
        turns = parsed.turns
        transcriptBytes = parsed.bytes
        transcriptParsedBytes = parsed.parsedBytes
        transcriptCache = parsed.cache
      } catch (error) {
        signal.throwIfAborted()
        if (!archived) throw error
      }
    }
    for (const turn of turns) {
      turn.items = await persistTraceToolEvents(userDataDir, cwd, turn.items)
      signal.throwIfAborted()
    }
    perf.mark('transcript', { transcriptTurns: turns.length, transcriptBytes, transcriptParsedBytes,
      transcriptCacheHit: transcriptCache === 'hit' ? 1 : 0,
      transcriptIncremental: transcriptCache === 'incremental' ? 1 : 0 })
    // Cancellation is not evidence of an empty session. Reject it so the renderer
    // cannot replace an existing timeline with an empty successful response.
    signal.throwIfAborted()
    // Older phone runs could lose their Scry archive if the host exited before
    // the Provider returned. Pi's native session is independent durable evidence;
    // read it offline rather than treating a missing Scry archive as no messages.
    let nativeTurns: LoadedSessionTurn[] | null = null
    let nativeReadNotice: string | undefined
    // An in-flight native tail has no Scry run ID; the live RunRegistry owns that
    // display. Do not add an unmatchable second copy while the Provider is running.
    if (payload.providerId === 'pi' && matchingRuns.length === 0) {
      let native: LoadedSessionTurn[] | null = null
      try {
        native = await readPiNativeHistory({ sessionRoot: join(homeDir, '.pi', 'agent', 'sessions'),
          cwd, sessionId: payload.externalSessionId, signal })
      } catch (error) {
        signal.throwIfAborted()
        if (!archived) throw error
        // A truncated/unsupported native file must not hide an intact Scry archive.
        nativeReadNotice = `已显示 Scry 归档；Pi 原生历史未能核对：${error instanceof Error ? error.message : String(error)}`
      }
      if (native && !archived) nativeTurns = native
      else if (native) {
        // A successful continuation must not hide the previously recovered prefix.
        // Reconcile only Provider-native turn IDs, never prompts or output text.
        const completeArchive = await readCompleteArchiveForNativeReconciliation(
          archivePage,
          () => readTraceArchiveAsync(archiveArgs, signal)
        )
        nativeTurns = reconcilePiNativeHistory(native, mergeSessionTurns([], completeArchive,
          { userDataDir }, { hydrateAttachments: false }))
      }
    }
    signal.throwIfAborted()
    perf.mark('native_history', { nativeTurns: nativeTurns?.length ?? 0 })
    if (!fp && !archived && !nativeTurns) {
      perf.finish({ returnedTurns: 0 })
      return null
    }
    dockBadge.view(
      providerSessionKey(payload.providerId, cwd, payload.externalSessionId, payload.agentProfileId),
      Boolean(win?.isFocused())
    )
    setCurrentCwd(cwd || undefined)
    const key = providerContextKey(payload.providerId, cwd, payload.agentProfileId)
    // 恢复当前仍在运行或收口的会话只是读取历史：它不能清掉该 run 正在使用的 session diff baseline。
    // 真正切换到另一条历史会话时递增选择 revision；它不改变任何会话的 baseline。
    const loadingUnsettledRun = runs.unsettledStates().some((run) => sessionLoadMatchesRun(run, {
      providerId: payload.providerId,
      agentProfileId: payload.agentProfileId,
      cwd,
      externalSessionId: payload.externalSessionId
    }))
    if (!loadingUnsettledRun) {
      bumpSessionRevision(key)
      sessionAliasesByContext.delete(key)
    }
    if (appSessionCanResume(catalogSession)) sessionByContext.set(key, payload.externalSessionId)
    else sessionByContext.delete(key)
    perf.mark('selection')
    if (cwd) rememberProject(cwd)
    perf.mark('project_remember')
    const historyContext = { userDataDir }
    const mergedHistory = nativeTurns ?? mergeSessionTurns(turns, archived, historyContext, { hydrateAttachments: false })
    perf.mark('merge_turns', { mergedTurns: mergedHistory.length })
    const merged: LoadedSessionTurn[] = nativeTurns ?? await providerRegistry.enrichSession(
      { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
      mergedHistory
    )
    if (nativeReadNotice && merged.length) {
      const last = merged[merged.length - 1]
      last.errorHint = [last.errorHint, nativeReadNotice].filter(Boolean).join('\n')
    }
    perf.mark('merge', { mergedTurns: merged.length })
    signal.throwIfAborted()
    const hookConfig =
      cwd && payload.providerId === 'claude'
        ? loadClaudeHookConfig(cwd, homeDir)
        : payload.providerId === 'codex'
          ? cwd ? loadCodexHookConfig(cwd, homeDir) : null
          : null
    sessionHistoryCache = {
      revision: requestRevision,
      key: sessionHistoryCacheKey(payload, cwd),
      turns: merged,
      transcriptTurns: turns,
      archive: archived,
      context: historyContext,
      ...(archivePaged && !nativeTurns ? {
        archiveSource: archiveArgs,
        archiveSnapshotTotalTurns: archivePage?.totalTurns ?? 0
      } : {}),
      hookConfig
    }
    const unhydratedPage: SessionHistoryPage = archivePage && !nativeTurns
      ? {
          turns: merged,
          offset: archivePage.offset,
          totalTurns: archivePage.totalTurns,
          hasOlder: archivePage.hasOlder,
          completeness: archivePage.hasOlder ? 'partial' : 'complete'
        }
      : sessionHistoryPage(merged, { before: undefined, limit: request?.limit })
    const page = hydrateSessionHistoryPage(
      unhydratedPage,
      turns,
      archived,
      historyContext
    )
    perf.mark('page_hydration', { returnedTurns: page.turns.length })
    const result = pageWithHookCommands(page, hookConfig)
    perf.finish({ totalTurns: page.totalTurns, returnedTurns: result.turns.length })
    return result
  } catch (error) {
    perf.finish(undefined, signal.aborted ? 'cancelled' : 'error')
    throw error
  } finally {
    perf.finish(undefined, 'unavailable')
  }
})

// 更早轮次的纯读取：不重做任何会话切换副作用（cwd / baseline / dock badge / resume）。
// revision 或 session 身份不匹配时返回 null：renderer 将它当作过期请求丢弃，而不是拼上错会话的轮次。
handleTrusted('agent:loadSessionOlder', async (_e, payload: ProviderContext, request: SessionHistoryPageRequest) => {
  if (!payload.externalSessionId) return null
  const perf = new PerformanceTrace('session_history.load_older', { provider: payload.providerId })
  try {
    const cache = sessionHistoryCache
    if (!cache || cache.revision !== loadSessionRevision) return null
    const cwd = payload.cwd?.trim() ? resolveKnownProjectDirectory(payload.cwd) : ''
    if (cache.key !== sessionHistoryCacheKey(payload, cwd)) return null
    if (request?.before == null || !Number.isFinite(request.before) || request.before <= 0) return null
    if (cache.archiveSource) {
      const sourcePage = await readTraceArchivePageAsync(cache.archiveSource, {
        ...request,
        snapshotTotalTurns: cache.archiveSnapshotTotalTurns
      })
      if (cache !== sessionHistoryCache || cache.revision !== loadSessionRevision) return null
      if (sourcePage.archive) {
        for (const turn of sourcePage.archive.turns) {
          turn.items = await persistTraceToolEvents(cache.context.userDataDir, cwd, turn.items)
        }
        if (cache !== sessionHistoryCache || cache.revision !== loadSessionRevision) return null
      }
      const turns = await providerRegistry.enrichSession(
        { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
        mergeSessionTurns([], sourcePage.archive, cache.context, { hydrateAttachments: false })
      )
      if (cache !== sessionHistoryCache || cache.revision !== loadSessionRevision) return null
      const page = hydrateSessionHistoryPage({
        turns,
        offset: sourcePage.offset,
        totalTurns: sourcePage.totalTurns,
        hasOlder: sourcePage.hasOlder,
        completeness: sourcePage.hasOlder ? 'partial' : 'complete'
      }, [], sourcePage.archive, cache.context)
      perf.mark('indexed_archive', {
        returnedTurns: page.turns.length,
        archiveTurnFilesRead: sourcePage.turnFilesRead
      })
      const result = pageWithHookCommands(page, cache.hookConfig)
      perf.finish({ totalTurns: page.totalTurns, returnedTurns: result.turns.length })
      return result
    }
    const page = hydrateSessionHistoryPage(
      sessionHistoryPage(cache.turns, request),
      cache.transcriptTurns,
      cache.archive,
      cache.context
    )
    perf.mark('cached_history', { returnedTurns: page.turns.length })
    const result = pageWithHookCommands(page, cache.hookConfig)
    perf.finish({ totalTurns: page.totalTurns, returnedTurns: result.turns.length })
    return result
  } catch (error) {
    perf.finish(undefined, 'error')
    throw error
  } finally {
    perf.finish(undefined, 'unavailable')
  }
})

type SessionDeletionRequest = Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }

// 删除一个历史会话。工作区 .scry/ 是独立 canonical evidence，明确保留。
// confirm / notifyFailure 由调用方决定：单条删除各弹一次系统弹窗，批量删除只在批次首尾各弹一次。
async function deleteOneSession(
  p: SessionDeletionRequest,
  options: { confirm: boolean; notifyFailure: boolean; conversationId?: string; runIds?: readonly string[] }
): Promise<DeleteSessionResult> {
    const empty = (): Pick<DeleteSessionResult, 'deleted' | 'retained' | 'failed'> => ({
      deleted: [],
      retained: ['workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history'],
      failed: []
    })
    if (!p.externalSessionId || p.providerId === 'legacy_unknown') {
      return { ok: false, reason: 'invalid_request', ...empty() }
    }
    const cwd = p.cwd ?? ''
    const externalSessionId = p.externalSessionId
    const providerId = p.providerId as ProviderId
    const agentProfileId = p.agentProfileId
    const admissionKey = providerContextKey(providerId, cwd, agentProfileId)
    const deletionKey = providerSessionKey(providerId, cwd, externalSessionId, agentProfileId)
    let otherOwnedRunIds = new Set<string>()
    const assertDeletionAllowed = async (): Promise<void> => {
      if (!options.conversationId) return assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd, nativeSessionId: externalSessionId }, {})
      const owner = await conversationStore().read(options.conversationId)
      if (!owner || owner.cwd !== cwd || owner.deletion?.status !== 'pending') throw new Error('没有已持久化的统一对话删除授权')
      const plan = await prepareConversationDeletion(owner)
      const target = plan.targets.find(target => target.providerId === providerId && target.agentProfileId === agentProfileId && target.externalSessionId === externalSessionId)
      if (!target || target.sharedWith.length) throw new Error('删除目标未归属该操作或仍被其他会话引用')
      otherOwnedRunIds = new Set(plan.targets.filter(other => other !== target).flatMap(other => other.runIds))
      await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd, nativeSessionId: externalSessionId }, { ownerId: options.conversationId })
    }
    const hasActiveSession = (): boolean => runs.unsettledStates().some((run) => {
      const sessionId = run.externalSessionId ?? run.sessionId
      return run.providerId === providerId && (run.cwd ?? '') === cwd &&
        (run.runId === externalSessionId || sessionId === externalSessionId || Boolean(options.runIds?.includes(run.runId)))
    })
    const reserved = await contextAdmission.run(admissionKey, async () => {
      await startupManagedRecovery
      await assertDeletionAllowed()
      if (hasActiveSession() || deletingSessions.has(deletionKey)) return false
      deletingSessions.add(deletionKey)
      return true
    })
    if (!reserved) return { ok: false, reason: 'active_session', ...empty() }
    try {
      if (options.confirm) {
        const confirmOptions = {
          type: 'warning' as const,
          buttons: ['取消', '删除 Scry 会话副本'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: '删除这个历史会话？',
          detail: '将删除 Scry 的 catalog、archive、附件、SQLite 和 usage 记录。工作区 .scry/ canonical evidence 与 Provider 原生 transcript/history 会保留。'
        }
        const confirmation = win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, confirmOptions)
          : await dialog.showMessageBox(confirmOptions)
        if (confirmation.response !== 1) {
          return { ok: false, cancelled: true, reason: 'user_cancelled', ...empty() }
        }
      }
      return contextAdmission.run(admissionKey, async () => {
        // Matching starts are fenced by deletionKey. The context admission is reacquired
        // only for the destructive phase so broad managed recovery in another session
        // cannot resurrect this session while unrelated work is deleted.
        if (hasActiveSession()) return { ok: false, reason: 'active_session', ...empty() }
        await assertDeletionAllowed()

      const userDataDir = app.getPath('userData')
      const sessionStore = appSessionStore()
      let catalogRunId: string | undefined
      try {
        catalogRunId = sessionStore.load().find((session) =>
          session.providerId === providerId && session.agentProfileId === agentProfileId && session.cwd === cwd &&
          (session.sessionId === externalSessionId || session.externalSessionId === externalSessionId)
        )?.runId
      } catch (error) {
        return {
          ok: false,
          reason: 'partial_failure',
          ...empty(),
          failed: [{ store: 'catalog', error: error instanceof Error ? error.message : String(error) }]
        }
      }
      const initialRunIds = new Set(traceArchiveRunIds({ cwd, sessionId: externalSessionId, providerId, userDataDir }))
      for (const runId of options.runIds ?? []) initialRunIds.add(runId)
      if (catalogRunId) initialRunIds.add(catalogRunId)
      for (const runId of usageSessionRunIds({ userDataDir, providerId, agentProfileId, cwd, externalSessionId })) {
        initialRunIds.add(runId)
      }
      for (const runId of attachmentSessionRunIds(userDataDir, {
        providerId,
        cwd,
        sessionId: externalSessionId
      })) initialRunIds.add(runId)
      for (const runId of managedSessionRunIds(userDataDir, { cwd, sessionId: externalSessionId, providerId })) {
        initialRunIds.add(runId)
      }
      for (const runId of traceProgressSessionRunIds(userDataDir, {
        cwd,
        sessionId: externalSessionId,
        providerId
      })) initialRunIds.add(runId)
      for (const runId of turnOutboxSessionRunIds(userDataDir, { providerId, cwd, externalSessionId })) {
        initialRunIds.add(runId)
      }
      // A catalog/native alias can reference a run whose SQLite identity is a
      // different scope in this same deletion. Its own target cleans run artifacts.
      for (const runId of otherOwnedRunIds) initialRunIds.delete(runId)
      const result = await deleteOwnedSessionData(initialRunIds, {
        resolveRunIds: (runIds) => resolveSessionRunIds({ providerId, cwd, externalSessionId, runIds }),
        deleteDatabase: (runIds) => deleteSessionData({ providerId, cwd, externalSessionId, runIds }),
        deleteUsage: (runIds) => deleteUsageSessionRows({
          userDataDir,
          providerId,
          agentProfileId,
          cwd,
          externalSessionId,
          runIds
        }),
        deleteManaged: async (runIds) => {
          const traceProgress = deleteTraceTurnProgressArtifacts(userDataDir, runIds)
          if (traceProgress.failed.length > 0) return traceProgress
          return deleteManagedTurnArtifacts(userDataDir, runIds)
        },
        deleteOutbox: (runIds) => deleteTurnOutboxSessionRows(
          userDataDir,
          { providerId, cwd, externalSessionId },
          runIds
        ),
        deleteAttachments: (runId) => deleteRunAttachments(userDataDir, runId),
        deleteTranscripts: () => deleteTranscriptCopies({ cwd, sessionId: externalSessionId, providerId, userDataDir }),
        deleteCatalog: () => sessionStore.remove({ providerId, agentProfileId, cwd, externalSessionId })
      })
      if (!result.ok) {
        if (options.notifyFailure) {
          const failureOptions = {
            type: 'error' as const,
            message: '会话未完整删除，catalog 已保留供重试',
            detail: result.failed.map((failure) => `${failure.store}: ${failure.error}`).join('\n')
          }
          if (win && !win.isDestroyed()) await dialog.showMessageBox(win, failureOptions)
          else await dialog.showMessageBox(failureOptions)
        }
        return result
      }
      const key = providerContextKey(providerId, cwd, agentProfileId)
      if (sessionByContext.get(key) === externalSessionId) sessionByContext.delete(key)
      sessionDiffBaselines.discard(sessionBaselineKey(key, externalSessionId))
      recordingBlockedSessions.delete(deletionKey)
      dockBadge.remove(deletionKey)
      if (rendererCanReceive()) {
        win?.webContents.send('agent:dataUpdated', {
          runId: catalogRunId ?? externalSessionId,
          kind: 'session_deleted'
        })
      }
      return result
      })
    } finally {
      deletingSessions.delete(deletionKey)
    }
}

handleTrusted('agent:deleteSession', (_e, p: SessionDeletionRequest) =>
  deleteOneSession(p, { confirm: !isOwnedTestApp, notifyFailure: true }))

function sessionRefFromRequest(p: unknown): AppSessionRef | null {
  if (!p || typeof p !== 'object') return null
  const request = p as Partial<AppSessionRef>
  if (typeof request.externalSessionId !== 'string' || !request.externalSessionId) return null
  if (!isSessionProviderId(request.providerId)) return null
  if (request.agentProfileId != null && typeof request.agentProfileId !== 'string') return null
  return {
    providerId: request.providerId,
    agentProfileId: request.agentProfileId,
    cwd: typeof request.cwd === 'string' ? request.cwd : '',
    externalSessionId: request.externalSessionId
  }
}

async function changeLegacySessionMetadata(ref: AppSessionRef, change: () => boolean): Promise<boolean> {
  if (ref.providerId === 'legacy_unknown') return change()
  await startupManagedRecovery
  await conversationStore().assertLegacyWriteAllowed({ ...ref, providerId: ref.providerId, nativeSessionId: ref.externalSessionId })
  if (adoptingSessionKeys.has(providerSessionKey(ref.providerId, ref.cwd, ref.externalSessionId, ref.agentProfileId))) {
    throw new Error('会话已归属统一对话或正在迁移，请从统一对话管理')
  }
  // Do not queue ordinary legacy archiving behind start preparation: it must
  // retain the existing persist-first fence and stop its registered owner.
  return change()
}

// 名称、置顶与存档只改 catalog，不动 Provider transcript 或 turn/usage/trace 数据。
handleTrusted('agent:renameSession', (_e, p: unknown, title: unknown) => {
  const ref = sessionRefFromRequest(p)
  if (!ref || typeof (p as AppSessionRef).cwd !== 'string') throw new Error('无效的会话重命名请求')
  return changeLegacySessionMetadata(ref, () => appSessionStore().rename(ref, title))
})

handleTrusted('agent:setSessionPinned', (_e, p: unknown, pinned: unknown) => {
  const ref = sessionRefFromRequest(p)
  if (!ref || typeof pinned !== 'boolean') throw new Error('无效的置顶请求')
  return changeLegacySessionMetadata(ref, () => appSessionStore().setPinned(ref, pinned))
})

handleTrusted('agent:setSessionArchived', (_e, p: unknown, archived: unknown) => {
  const ref = sessionRefFromRequest(p)
  if (!ref || typeof archived !== 'boolean') throw new Error('无效的存档请求')
  return changeLegacySessionMetadata(ref, () => archived
    ? archiveSessionAndStop(appSessionStore(), ref, runs.activeStates(), requestRunStop)
    : appSessionStore().setArchived(ref, false))
})

handleTrusted('agent:listArchivedSessions', () => appSessionStore().listArchivedProjects())

handleTrusted('agent:deleteArchivedSessions', async (): Promise<DeleteArchivedSessionsResult> => {
  let targets: Array<{ request: SessionDeletionRequest; preview: string }>
  try {
    targets = appSessionStore()
      .load()
      .filter((session) => session.archivedAt)
      .map((session) => ({
        request: {
          providerId: session.providerId ?? 'legacy_unknown',
          agentProfileId: session.agentProfileId,
          cwd: session.cwd,
          externalSessionId: session.externalSessionId ?? session.sessionId
        },
        preview: session.preview
      }))
  } catch {
    return { ok: false, reason: 'catalog_unavailable', deleted: 0, failures: [] }
  }
  if (targets.length === 0) return { ok: true, deleted: 0, failures: [] }
  const confirmOptions = {
    type: 'warning' as const,
    buttons: ['取消', `删除全部 ${targets.length} 个`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `永久删除全部 ${targets.length} 个已存档会话？`,
    detail: '将删除 Scry 的 catalog、archive、附件、SQLite 和 usage 记录。工作区 .scry/ canonical evidence 与 Provider 原生 transcript/history 会保留。'
  }
  const confirmation = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, confirmOptions)
    : await dialog.showMessageBox(confirmOptions)
  if (confirmation.response !== 1) {
    return { ok: false, cancelled: true, reason: 'user_cancelled', deleted: 0, failures: [] }
  }
  let deleted = 0
  const failures: DeleteArchivedSessionsResult['failures'] = []
  for (const target of targets) {
    const result = await deleteOneSession(target.request, { confirm: false, notifyFailure: false })
    if (result.ok) deleted += 1
    else failures.push({ preview: target.preview, reason: result.reason ?? 'partial_failure' })
  }
  if (failures.length > 0) {
    const failureOptions = {
      type: 'error' as const,
      message: `${failures.length} 个已存档会话未删除，catalog 已保留供重试`,
      detail: failures.map((failure) => `${failure.preview || '(无预览)'}: ${failure.reason}`).join('\n')
    }
    if (win && !win.isDestroyed()) await dialog.showMessageBox(win, failureOptions)
    else await dialog.showMessageBox(failureOptions)
  }
  return { ok: failures.length === 0, reason: failures.length > 0 ? 'partial_failure' : undefined, deleted, failures }
})

interface RunControl {
  runId: string
  providerId: ProviderId
  interrupt: () => void
  forceKill: () => void
  stopBackgroundTask: (taskId: string) => Promise<BackgroundTaskStopResult>
  steer: (input: AgentSteerInput) => Promise<AgentSteerResult>
  /**
   * 硬杀当下的真实作用范围，直接来自 Provider handle。handle 还没创建时返回 undefined：
   * 没有可调用对象就不能声称已经发出 run-scoped 强制终止。
   */
  forceKillScope: () => AgentForceKillScope | undefined
  cwd?: string
  resume?: string
  getExternalSessionId: () => string | undefined
  getProviderTurnId: () => string | undefined
  canonicalLifecycle: boolean
  runtimeProvider: RuntimeProvider
  runState: ActiveRun
  adoptSession: () => void
  cleanupProvisional: () => void
  finalizeTurnDiff: () => Promise<void>
  cancelTurnDiff: () => Promise<void>
  settled: Promise<void>
}

// 每个 run 独立持有 Provider handle、问题与 diff 生命周期；focused 只表示当前 UI 正在看谁。
const runs = new RunRegistry<ActiveRun, RunControl>()
const llmNetworkConfiguration = new LlmNetworkConfigurationCache()
// 停止是一个生命周期而不是一次调用：它把真实进度（已请求/已强杀/未确认终止）发给 renderer，
// 并把同一份快照挂在 ActiveRun 上，让重挂的 renderer 也能拿到诚实状态。
const runStopLifecycle = new RunStopLifecycle({
  publish: (state) => {
    const run = runs.get(state.runId)?.state
    if (run) run.stopState = state
    if (!rendererCanReceive()) return
    flushTraceSend()
    win?.webContents.send('agent:stopState', state)
  },
  warn: (message, runId, error) => console.warn(`[scry] ${message}:`, runId, error)
})
// One pending-question projection for the run state, dock and renderer. Shared by
// the Mac broker and device-started runs, whose questions live on the remote
// broker but are mirrored here so the Mac can answer them too.
function publishQuestionOpened(request: AgentQuestionRequest): void {
  const run = runs.get(request.runId)?.state
  if (run) {
    run.pendingQuestions = [
      ...(run.pendingQuestions ?? []).filter((item) => item.questionId !== request.questionId),
      request
    ]
    const sessionKey = activeRunSessionKey(run)
    if (sessionKey) dockBadge.markAttention(sessionKey, {
      windowFocused: Boolean(win?.isFocused()),
      sessionViewed: runs.isViewed(run.runId),
      needsAttention: true
    })
  }
  win?.webContents.send('agent:questionAttention', {
    runId: request.runId,
    pendingCount: run?.pendingQuestions?.length ?? 1
  })
  if (runs.isFocused(request.runId)) win?.webContents.send('agent:userQuestion', request)
}
// `intervention` is absent for device-started runs: remote-run-binding records
// their intervention trace event itself.
function publishQuestionClosed(runId: string, questionId: string, intervention?: AgentIntervention): void {
  const run = runs.get(runId)?.state
  if (run) {
    run.pendingQuestions = (run.pendingQuestions ?? []).filter((item) => item.questionId !== questionId)
    if (intervention) {
      const event: TraceEvent = {
        id: mainEventId('intervention', runId),
        ts: intervention.closedAt,
        runId,
        kind: 'human',
        stage: 'intervention',
        toolUseId: questionId,
        providerId: intervention.request.providerId,
        agentId: intervention.request.agentId,
        durationMs: intervention.durationMs,
        intervention
      }
      appendCoalescedTrace(run.items, event)
      if (runs.isFocused(runId)) queueTrace(event)
    }
  }
  win?.webContents.send('agent:questionAttention', {
    runId,
    pendingCount: run?.pendingQuestions?.length ?? 0
  })
  if (runs.isFocused(runId)) {
    win?.webContents.send('agent:userQuestionClosed', { kind: 'closed', runId, questionId, ...(intervention ? { intervention } : {}) })
  }
}
const userQuestionBroker = new UserQuestionBroker((change: UserQuestionChange) => {
  if (change.kind === 'open') publishQuestionOpened(change.request)
  else publishQuestionClosed(change.runId, change.questionId, change.intervention)
})
// 性能：把 onTrace 逐条 IPC 合批——流式期每 token 一条 IPC（每秒上百）→ 缓冲一批数组发。
// 保序（FIFO buffer）、不丢（done/error 前 flushTraceSend 强制清空全部）。
// 有界与背压由 TraceOutputBridge 承担：单批受事件/字节上限约束，在途字节到 high-water
// 就等 renderer ACK；过载时只停止镜像最新事件并如实上报缺口，权威证据仍在 runState 与归档。
const traceOutput = new TraceOutputBridge({
  canSend: rendererCanReceive,
  // 贴近一帧合批：仍把高频 token 合成数组，但把首字/工具状态额外等待从 50ms
  // 降到约一帧。renderer 还会在 requestAnimationFrame 内统一提交 React state。
  flushMs: 16,
  send: (payload) => win?.webContents.send('agent:trace', payload),
  publishHealth: (state) => {
    if (!rendererCanReceive()) return
    win?.webContents.send('agent:traceHealth', state)
  },
  warn: (message, state) => console.warn(`[scry] ${message}:`, state)
})
function flushTraceSend(): void {
  traceOutput.flushAll()
}
function queueTrace(ev: TraceEvent): void {
  traceOutput.push(ev)
}

const LIVE_TOOL_CONTENT_POLICY = {
  toolOutput: 'full' as const,
  toolContentFieldBytes: 8 * 1024,
  toolContentTurnBytes: 128 * 1024
}

function boundedLiveRun(run: ActiveRun): ActiveRun {
  return { ...run, items: sanitizeToolEvents(run.items, LIVE_TOOL_CONTENT_POLICY, 'live_renderer') }
}

interface AppRunStartOptions {
  origin?: 'local' | 'remote'
  runId?: string
  stopSignal?: AbortSignal
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
  permissionModeOverride?: AgentPermissionMode
  providerPrompt?: string
  onTraceEvent?: (event: TraceEvent) => void
  onSession?: (externalSessionId: string) => void
  ledgerRunId?: string
  managedConversation?: ManagedConversationStart
}

async function startAppRun(payload: AgentStartRequest, options: AppRunStartOptions = {}): Promise<{ runId: string } | RemoteRunCompletion> {
  const isRemoteRun = options.origin === 'remote'
  const request = normalizeAgentStartRequest(payload)
  const providerId = request.providerId
  const agentProfileId = request.agentProfileId
  const startPerf = new PerformanceTrace('agent.start', { provider: providerId })
  const firstTracePerf = new PerformanceTrace('agent.first_provider_trace', { provider: providerId })
  const firstTextPerf = new PerformanceTrace('agent.first_text', { provider: providerId })
  const adapter = providerRegistry.get(providerId)
  const runtimeProvider = adapter.runtimeProvider
  if (isShuttingDown) {
    throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      nextAction: '重新打开 Scry 后再启动'
    })
  }
  // Start one bounded acquisition for this explicit send. Discovery does not retry a
  // broken shell; the next send may recover without restarting Scry.
  const shellEnvReady = warmShellEnv({ retryFailed: true })
  const cwd = request.cwd
    ? (isRemoteRun ? resolveRemoteProjectDirectory(request.cwd) : resolveKnownProjectDirectory(request.cwd))
    : currentCwd
  if (!isRemoteRun && request.cwd && currentCwd && cwd !== canonicalExistingDirectory(currentCwd)) {
    throw new AgentRuntimeError('发送请求的工作目录与当前授权目录不一致', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '重新选择目标项目后再发送'
    })
  }
  const catalogCwd = cwd ?? ''
  const assertSessionNotArchived = (sessionIds: readonly (string | null | undefined)[]): void => {
    if (sessionIds.some((sessionId) => sessionId && appSessionStore().isArchived({
      providerId, agentProfileId, cwd: catalogCwd, externalSessionId: sessionId
    }))) throw new AgentRuntimeError('这个会话已归档，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '先撤销归档，再继续该会话；待发送消息不会自动恢复'
    })
  }
  assertSessionNotArchived([request.expectedExternalSessionId])
  if (request.backend !== 'local') {
    throw new AgentRuntimeError(`backend=${request.backend} 尚未实现`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '切回 Local CLI；BYOK/API transport 尚未接入 Provider adapter'
    })
  }
  if (request.runtimeProvider && request.runtimeProvider !== runtimeProvider) {
    throw new AgentRuntimeError(`provider=${providerId} 与 runtimeProvider=${request.runtimeProvider} 不匹配`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '不要手工覆盖 runtimeProvider；由 Provider adapter descriptor 选择原生 transport'
    })
  }
  const lifecycleKey = providerOperationKey(providerId, agentProfileId)
  const startLease = isRemoteRun ? undefined : providerOperationGate.acquireOperation(lifecycleKey)
  if (startLease && !startLease.ok) {
    throw new AgentRuntimeError('当前 Provider 正在认证 MCP，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待浏览器认证完成或超时后再发送'
    })
  }
  const admissionKey = providerContextKey(providerId, cwd ?? '', agentProfileId)
  const managedConversation = options.managedConversation
  const admissionKeys = managedConversation
    ? [admissionKey, `conversation:${managedConversation.conversationId}`]
    : [admissionKey]
  let remoteResult: Promise<RemoteRunCompletion> | undefined
  try {
    const started = await contextAdmission.runMany(admissionKeys, async () => {
    // Wait before freezing trust/MCP environments as well as before spawning the
    // Provider. Otherwise a cold send can retain fallback even after capture succeeds.
    await Promise.all([startupManagedRecovery, shellEnvReady])
    startPerf.mark('startup_recovery_ready')
    if (isShuttingDown) throw new AgentRuntimeError('Scry 正在退出，已取消待启动轮次', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      nextAction: '重新打开 Scry 后再启动'
    })
    const contextKey = providerContextKey(providerId, cwd ?? '', agentProfileId)
    const scopedSessionKey = (sessionId: string): string =>
      providerSessionKey(providerId, catalogCwd, sessionId, agentProfileId)
    const expectedSessionId = isRemoteRun ? (request.expectedExternalSessionId ?? null) : request.expectedExternalSessionId
    // expectedExternalSessionId=null 是 renderer 对“必须新建会话”的显式要求。
    // 即使较早的 agent:newSession IPC 仍在路上，这里也先原子清空 main 的旧上下文，
    // 再捕获 revision/resume，避免把新提示词误判为要投递到旧会话。
    if (!managedConversation && !isRemoteRun && expectedSessionId === null && !request.forkLastTurn && !request.restartLastTurn) {
      resetSessionContext(contextKey)
    }
    let contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
    let resume = managedConversation
      ? (managedConversation.resumeSessionId ?? undefined)
      : isRemoteRun ? request.expectedExternalSessionId ?? undefined : sessionByContext.get(contextKey)
    const forkSourceSessionId = !isRemoteRun && request.forkLastTurn ? resume : undefined
    const restartSourceSessionId = !isRemoteRun && request.restartLastTurn && typeof expectedSessionId === 'string'
      ? expectedSessionId
      : undefined
    const editSourceSessionId = forkSourceSessionId ?? restartSourceSessionId
    const contextRuns = runs.unsettledStates().filter((run) =>
      run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
    )
    if (managedConversation && contextRuns.length > 0) {
      throw new AgentRuntimeError('Provider 工作区仍有未收口轮次，已拒绝统一对话启动', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '等待现有轮次完成后重新预览并发送'
      })
    }
    const catalogAliases = (): Array<{ runId: string; externalSessionId?: string; sessionId?: string }> => {
      const liveAliases = [...(sessionAliasesByContext.get(contextKey) ?? [])].map(([runId, externalSessionId]) => ({
        runId,
        externalSessionId
      }))
      try {
        return [...liveAliases, ...appSessionStore().load()
          .filter((session) => session.providerId === providerId && session.agentProfileId === agentProfileId &&
            session.cwd === catalogCwd && Boolean(session.runId))
          .map((session) => ({
            runId: session.runId!,
            ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : {}),
            sessionId: session.sessionId
          }))]
      } catch {
        return liveAliases
      }
    }
    const contextChangedError = (): AgentRuntimeError => new AgentRuntimeError(
      '发送前会话上下文已变化，已拒绝把提示词投递到其他会话',
      {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '草稿已保留；确认当前会话后重新发送'
      }
    )
    if (!managedConversation && !isRemoteRun && (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
      !expectedSessionMatches(expectedSessionId, resume, () => [...contextRuns, ...catalogAliases()]))) {
      throw contextChangedError()
    }
    if (cwd && resume && deletingSessions.has(scopedSessionKey(resume))) {
      throw new AgentRuntimeError('这个会话正在删除，已拒绝启动新一轮', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '等待删除完成后新建会话或重新选择历史会话'
      })
    }
    const conflictingRuns = contextRuns.filter((run) => runConflictsWithSession(run, resume, expectedSessionId))
    const conflictingEntries = conflictingRuns.flatMap((run) => {
      const entry = runs.get(run.runId)
      return entry ? [{ done: run.done, settled: entry.control.settled }] : []
    })
    if (!(await waitForCompletedRuns(conflictingEntries))) {
      throw new AgentRuntimeError('同一会话已有一轮正在运行', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '等待当前轮完成，或新建独立会话后并行运行'
      })
    }
    // Renderer 会在 turnDone 后立即投递队列下一条；此时 Provider 已结束，但 diff/archive
    // 仍可能在收口。等待真实 settled 后再继续，避免稳定拒绝并破坏 FIFO。
    contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
    if (!managedConversation && !isRemoteRun) resume = sessionByContext.get(contextKey)
    const latestContextRuns = runs.unsettledStates().filter((run) =>
      run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
    )
    if (!managedConversation && !isRemoteRun && (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
      !expectedSessionMatches(expectedSessionId, resume, () => [...contextRuns, ...latestContextRuns, ...catalogAliases()]))) {
      throw contextChangedError()
    }
    if (cwd && resume && deletingSessions.has(scopedSessionKey(resume))) {
      throw new AgentRuntimeError('这个会话正在删除，已拒绝启动新一轮', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '等待删除完成后新建会话或重新选择历史会话'
      })
    }
    if (latestContextRuns.some((run) => runConflictsWithSession(run, resume, expectedSessionId))) {
      throw new AgentRuntimeError('会话切换后目标会话仍有一轮正在收口', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '等待目标会话完成后重试；草稿已保留'
      })
    }
  if (managedConversation) {
    await conversationStore().assertManagedWriteAllowed({
      conversationId: managedConversation.conversationId,
      cwd: catalogCwd,
      target: managedConversation.target,
      nativeSessionId: resume,
      runId: managedConversation.runId
    })
  } else await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: resume })
  // Still-owned runs finish on their original execution chain, not through crash recovery.
  const isLiveManagedRun = (candidate: string | undefined, nativeIdentity?: {
    provider: ProviderId; sessionId: string; providerTurnId?: string
  }): boolean => {
    if (candidate) return runs.unsettledStates().some((run) => run.runId === candidate)
    // Codex's native hook has no Scry run id. Only an exact live native turn
    // match may exclude its open record from crash recovery; session alone is
    // insufficient because an older unresolved turn can share that session.
    return Boolean(nativeIdentity?.providerTurnId && runs.unsettledControls().some((control) =>
      control.cwd === cwd && control.providerId === nativeIdentity.provider &&
      control.runState.externalSessionId === nativeIdentity.sessionId &&
      control.getProviderTurnId() === nativeIdentity.providerTurnId))
  }
  const traceProgressRecovery = cwd
    ? await recoverTraceTurnProgress(app.getPath('userData'), {
        cwd,
        providerId,
        ...(resume ? { sessionId: resume } : {}),
        isLiveManagedRun
      })
    : { recovered: 0, pending: 0, errors: [] }
  startPerf.mark('trace_progress_recovery_ready', { recovered: traceProgressRecovery.recovered })
  if (traceProgressRecovery.pending > 0) {
    throw new AgentRuntimeError(`Scry trace 仍有 ${traceProgressRecovery.pending} 轮待恢复`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '保留 Scry userData/trace-turn-progress，修复 archive 写入后重试'
    })
  }
  let managedRecorderEnabled = false
  let managedRecorderEnablement: Awaited<ReturnType<typeof resolveRecorderEnablement>> | undefined
  let managedCommitHookEnv: NodeJS.ProcessEnv | undefined
  let recoveredManagedTurns = traceProgressRecovery.recovered
  if (isManagedRecorderProvider(providerId) && cwd) {
    const recorderMode = await managedRecorderMode(cwd)
    managedRecorderEnabled = recorderMode.status === 'enabled'
    managedRecorderEnablement = recorderMode.status === 'enabled' ? recorderMode.enablement : undefined
    managedCommitHookEnv = managedRecorderEnabled
      ? await resolveManagedCommitHookEnv(cwd, managedRecorderEnablement)
      : undefined
    const journalRecovery = await recoverManagedTraceTurns(app.getPath('userData'), {
      cwd,
      providerId,
      ...(resume ? { sessionId: resume } : {}),
      waitMs: 250,
      commitHookEnv: managedCommitHookEnv,
      isLiveManagedRun
    })
    const progressRecovery = await recoverManagedTraceProgress(app.getPath('userData'), {
      cwd,
      providerId,
      ...(resume ? { sessionId: resume } : {}),
      waitMs: 250,
      commitHookEnv: managedCommitHookEnv,
      isLiveManagedRun
    })
    // 本进程知道哪些 run 还活着，所以可以安全地弃掉“没有 Provider 证据且主已不在”的 provisional 轮次，
    // 不再把这个工作区永久卡在“仍有 N 轮待恢复”。真有证据的轮次仍然 fail closed。
    const abandonProvisionalOptions = {
      provider: providerId,
      // A pending canonical journal may still need its provisional lifecycle. Never discard that
      // identity merely because the originating in-memory run ended; recovery must get first use.
      abandonProvisional: journalRecovery.pending === 0 && progressRecovery.pending === 0,
      // 发送前的恢复检查不能同步排仓库回调积压，否则会卡在“正在启动”。
      commitNotifications: 'detach' as const,
      isLiveManagedRun
    }
    const recorderRecovery = resume
      ? await recoverManagedRecorderTurns(cwd, managedCommitHookEnv, { ...abandonProvisionalOptions, sessionId: resume })
      : await recoverManagedRecorderTurns(cwd, managedCommitHookEnv, abandonProvisionalOptions)
    // 同一轮可能同时留下 progress、journal 与 recorder open；三层计数不能相加，
    // 否则会把一个待恢复 turn 报成三轮。这里只需要 fail closed。
    const pending = Math.max(progressRecovery.pending, journalRecovery.pending, recorderRecovery.pending)
    recoveredManagedTurns += progressRecovery.recovered + journalRecovery.recovered + recorderRecovery.recovered
    startPerf.mark('managed_recording_recovery_ready', { recovered: recoveredManagedTurns })
    if (pending > 0) {
      throw new AgentRuntimeError(`Scry 精确记录仍有 ${pending} 轮待恢复`, {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '保留当前工作区与 Scry Test 数据目录，先运行 scry doctor 并修复 pending canonical journal'
      })
    }
  }
  const recordingKey = resume ? scopedSessionKey(resume) : undefined
  if (recordingKey && recoveredManagedTurns > 0) recordingBlockedSessions.delete(recordingKey)
  const recordingFailure = recordingKey ? recordingBlockedSessions.get(recordingKey) : undefined
  if (recordingFailure) {
    throw new AgentRuntimeError('上一轮精确记录尚未安全落盘，已拒绝继续', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: recordingFailure
    })
  }
  const canonicalLifecycle = providerId === 'codex' || managedRecorderEnabled
  const codexHookTrust = providerId === 'codex' && cwd
    ? await resolveCodexHookTrust(cwd)
    : []
  const openCodePluginTrust = providerId === 'opencode' && cwd
    ? await resolveOpenCodePluginTrust(cwd)
    : undefined
  const mcpExecutionSnapshot = providerId === 'pi'
    ? null
    : await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
  startPerf.mark('execution_trust_ready')
  if (isShuttingDown) {
    throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '重新打开 Scry 后再启动'
    })
  }
  if (request.forkLastTurn) {
    if (!forkSourceSessionId || forkSourceSessionId !== expectedSessionId) throw contextChangedError()
    const archive = await readTraceArchiveAsync({
      cwd: catalogCwd,
      sessionId: forkSourceSessionId,
      providerId,
      userDataDir: app.getPath('userData')
    })
    const head = archive?.turns.at(-1)
    if (!archive || head?.runId !== request.forkLastTurn.replaceRunId ||
      head.providerTurnId !== request.forkLastTurn.replaceProviderTurnId ||
      (head.forkTurnId ?? head.providerTurnId) !== request.forkLastTurn.replaceForkTurnId) {
      throw new AgentRuntimeError('最后一条消息已变化，已拒绝从过期边界建立分支', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '重新打开当前会话后再编辑最后一条消息'
      })
    }
    if (request.forkLastTurn.previousProviderTurnId && request.forkLastTurn.previousForkTurnId) {
      const previous = archive?.turns.at(-2)
      if (previous?.providerTurnId !== request.forkLastTurn.previousProviderTurnId ||
        (previous.forkTurnId ?? previous.providerTurnId) !== request.forkLastTurn.previousForkTurnId) {
        throw new AgentRuntimeError('上一轮边界与当前会话不一致', {
          provider: runtimeProvider,
          stage: 'frontdoor',
          cwd,
          nextAction: '重新打开当前会话后再编辑最后一条消息'
        })
      }
      if (!adapter.forkLastTurn) {
        throw new AgentRuntimeError('当前 Provider 不支持从历史边界建立分支', {
          provider: runtimeProvider,
          stage: 'capability',
          cwd,
          nextAction: '升级 Provider CLI/SDK 后重试'
        })
      }
      const forked = await adapter.forkLastTurn.fork({
        ...request.forkLastTurn,
        sourceSessionId: forkSourceSessionId,
        originalPrompt: head.userText,
        cwd,
        agentProfileId,
        model: request.model,
        permissionMode: request.permissionMode,
        codexHookTrust,
        openCodePluginTrust,
        mcpExecution: authorizedMcpExecution(mcpExecutionSnapshot)
      })
      if (!forked.externalSessionId) throw new Error('Provider 未返回分支会话 ID')
      cloneForkArchiveTurns({
        turns: archive.turns.slice(0, -1),
        targetSessionId: forked.externalSessionId,
        providerId,
        runtimeProvider,
        cwd: catalogCwd
      })
      resume = forked.externalSessionId
      sessionByContext.set(contextKey, resume)
    } else {
      if (archive.turns.length !== 1) {
        throw new AgentRuntimeError('缺少上一轮边界，已拒绝把多轮会话当成首轮重新开始', {
          provider: runtimeProvider,
          stage: 'frontdoor',
          cwd,
          nextAction: '加载完整会话后再编辑最后一条消息'
        })
      }
      // 编辑首轮不需要复制空历史；直接创建一个新的 Provider 会话。
      resume = undefined
      sessionByContext.delete(contextKey)
    }
    sessionAliasesByContext.delete(contextKey)
  } else if (request.restartLastTurn) {
    if (!restartSourceSessionId) throw contextChangedError()
    const archive = await readTraceArchiveAsync({
      cwd: catalogCwd,
      sessionId: restartSourceSessionId,
      providerId,
      userDataDir: app.getPath('userData')
    })
    if (!canRestartInterruptedLocalOnlySession(archive, request.restartLastTurn.replaceRunId)) {
      throw new AgentRuntimeError('停止轮次已变化或已形成 Provider 边界，已拒绝重新开始', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '重新打开当前会话；只有全部轮次都已停止且未形成原生边界时才能直接编辑重发'
      })
    }
    resume = undefined
    sessionByContext.delete(contextKey)
    sessionAliasesByContext.delete(contextKey)
  }
  const committedResume = managedConversation ? resume : isRemoteRun ? resume : sessionByContext.get(contextKey)
  const committedRevision = sessionRevisionByContext.get(contextKey) ?? 0
  const committedRuns = runs.unsettledStates().filter((run) =>
    run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
  )
  const committedExpectedSessionId = request.forkLastTurn || request.restartLastTurn ? resume ?? null : expectedSessionId
  if (!managedConversation && !isRemoteRun && (
    committedResume !== resume || committedRevision !== contextRevision ||
    !expectedSessionMatches(committedExpectedSessionId, committedResume, () => [...committedRuns, ...catalogAliases()])
  )) throw contextChangedError()
  if (cwd && committedResume && deletingSessions.has(scopedSessionKey(committedResume))) {
    throw new AgentRuntimeError('这个会话正在删除，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待删除完成后新建会话或重新选择历史会话'
    })
  }
  if (committedRuns.some((run) => runConflictsWithSession(run, committedResume, committedExpectedSessionId))) {
    throw new AgentRuntimeError('同一会话在发送前进入运行态，已拒绝重复启动', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待当前轮完成；草稿已保留'
    })
  }
  const runId = managedConversation?.runId ?? options.runId ?? `run-${Date.now().toString(36)}-${runSeq++}`
  if (managedConversation) {
    if (options.runId !== undefined && options.runId !== managedConversation.runId) {
      throw new AgentRuntimeError('统一对话 runId 与 runner 选项不一致', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '丢弃本次启动并重新发送；不会自动重试'
      })
    }
    const actualRequestHash = createHash('sha256').update(JSON.stringify({
      scope: 'plain-text-local-managed-v1',
      payloadHash: managedConversation.payloadHash,
      historyHash: managedConversation.historicalContext?.contentHash ?? null
    })).digest('hex')
    if (actualRequestHash !== managedConversation.requestHash) {
      throw new AgentRuntimeError('统一对话请求指纹在 runner 边界发生变化', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '保留 durable intent 并阻止原生投递'
      })
    }
  }
  let diffContextKey = resume ? sessionBaselineKey(contextKey, resume) : JSON.stringify([contextKey, 'run', runId])
  const finishTurnWallTiming = createTurnWallTimer(runId)
  const llmPerformance = new LlmPerformanceObserver(request.networkLabel)
  // Start collection without delaying Provider startup. Freeze this run's configuration evidence.
  let runNetworkConfiguration: LlmNetworkConfiguration | undefined
  const networkConfiguration = llmNetworkConfiguration.read().then(config => {
    runNetworkConfiguration = config
    return config
  })
  const hookConfig =
    providerId === 'claude' && cwd
      ? loadClaudeHookConfig(cwd, homeDir)
      : providerId === 'codex' && cwd
        ? loadCodexHookConfig(cwd, homeDir)
        : null
  const unavailableCapture = (): GitTurnDiffCapture => {
    const beforeAt = new Date().toISOString()
    return { beforeAt, captureMs: 0, status: 'unavailable', reason: 'not_git' }
  }
  const turnChangeJournal = cwd ? new TurnChangeJournal(cwd) : null
  let attachments: PreparedAttachment[] = []
  let managedInputTextHash = managedConversation?.inputTextHash
  const displayPrompt = request.prompt
  let runtimePrompt = options.providerPrompt ?? displayPrompt
  let observedSessionId = resume
  const runState: ActiveRun = {
    runId,
    providerId,
    agentProfileId,
    cwd,
    externalSessionId: resume,
    sessionId: resume,
    userText: displayPrompt,
    attachments,
    items: [],
    done: false,
    providerSettled: false
  }
  const persistRunData = (sessionId?: string): void => {
    const result = [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')
    if (!recordTurn({
      runId,
      sessionId,
      cwd,
      userText: displayPrompt,
      items: runState.items,
      providerId,
      runtimeProvider,
      billingProvider: result?.billingProvider
    })) return
    win?.webContents.send('agent:dataUpdated', { runId, kind: 'turn_recorded' })
  }
  const cleanupProvisional = (): void => {
    if (resume || runState.externalSessionId) return
    const ref = { providerId, agentProfileId, cwd: catalogCwd, externalSessionId: runId }
    if (!appSessionStore().isArchived(ref)) appSessionStore().remove(ref)
  }
  // emit 早于 diffPreviewer 构造，这里留一个前向钩子；构造完成后接上真正的预览刷新。
  let notifyDiffChange: () => void = () => {}
  // App trace capture does not require a workspace recorder. Keep raw evidence until its
  // durable body exists; then release it from run state and send only the bounded projection.
  const ingestionEnablement = managedRecorderEnablement?.enabled ? managedRecorderEnablement : undefined
  const ingestionRecorderRoot = managedRecorderEnabled && ingestionEnablement?.config.capture.toolOutput === 'full'
    ? ingestionEnablement.dataRoot : undefined
  const ingestion = new LiveTraceIngestion({
    provider: providerId,
    publish: (event) => { if (runs.isViewed(runId)) queueTrace(event) },
    persist: async (event) => {
      const [persisted] = await persistTraceToolEvents(app.getPath('userData'), catalogCwd, [event], ingestionRecorderRoot)
      return persisted
    },
    onPersisted: (event) => {
      const index = runState.items.findIndex((item) => item.id === event.id)
      if (index >= 0) runState.items[index] = event
    },
    onError: (error) => console.warn('[scry] trace content persistence failed; retaining raw evidence:', error)
  })
  // 结构化 write/edit 的 start → tool_result 关联器：预览只跟着「已落盘」的结果走。
  const writeCompletions = new WriteCompletionTracker()
  const emit = (rawEvent: TraceEvent): void => {
    const decorated = hookConfig ? attachConfiguredHookCommands(rawEvent, hookConfig) : rawEvent
    const ev = !decorated.agentId && !decorated.parentToolUseId
      ? { ...decorated, llmPerformance: { ...llmPerformance.observe(decorated, runState.items), networkConfiguration: runNetworkConfiguration } }
      : decorated
    turnChangeJournal?.record(ev)
    if (ev.llmPerformance) runState.llmPerformance = ev.llmPerformance
    if (ev.kind === 'harness' && ev.stage === 'result') {
      appendUsage(
        app.getPath('userData'),
        { providerId, agentProfileId, runtimeProvider, cwd, externalSessionId: observedSessionId, runId, source: ev.usageSource },
        ev
      )
    }
    const liveEvent = sanitizeToolEvents([ev], LIVE_TOOL_CONTENT_POLICY, 'live_renderer')[0]
    appendCoalescedTrace(runState.items, ev)
    ingestion.enqueue(ev, liveEvent)
    if (ev.backgroundWork && rendererCanReceive()) win?.webContents.send('agent:backgroundWork', { runId, work: ev.backgroundWork })
    // 结构化写入的 tool_result 到达 = 那次写入已经结束（成功或失败都可能已落盘）→ 刷新运行中 Diff
    // 预览。绝不在 tool start 上刷：那时文件通常还没写盘，预览会读到写前状态。
    if (writeCompletions.observe(ev)) notifyDiffChange()
    if (isRemoteRun) options.onTraceEvent?.(ev)
  }
  let performanceRecorded = false
  const persistLlmPerformance = async (failed: boolean, externalSessionId: string): Promise<void> => {
    if (performanceRecorded) return
    performanceRecorded = true
    const performance = [...runState.items].reverse().find(event => event.stage === 'runtime:turn_wall')?.llmPerformance
    const result = [...runState.items].reverse().find(event => event.kind === 'harness' && event.stage === 'result')
    if (!performance) return
    const model = result?.modelUsage?.length === 1 ? result.modelUsage[0].model
      : result?.modelUsage?.length ? '多模型'
        : result?.contextModel ?? (request.model ? `所选：${request.model.id}` : '未知模型')
    try {
      await appendLlmPerformance(app.getPath('userData'), { cwd: catalogCwd, externalSessionId }, {
        runId, ts: performance.observedAt, providerId, agentProfileId,
        model,
        upstreamProvider: result?.modelUsage?.length === 1 ? result.modelUsage[0].upstreamProvider : result?.upstreamProvider,
        networkLabel: request.networkLabel ?? '', failed: failed || result?.isError === true,
        performance: { ...performance, networkConfiguration: await networkConfiguration }
      })
    } catch (error) {
      console.warn('[scry] LLM performance history write failed:', error)
    }
  }
  emit({
    id: mainEventId('controls', runId),
    ts: new Date().toISOString(),
    runId,
    kind: 'harness',
    stage: 'runtime:controls',
    input: {
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode,
      ...(options.permissionModeOverride ? { effectivePermissionMode: options.permissionModeOverride } : {})
    }
  })
  try {
    if (resume) {
      // 续接同一原生 session 时也要把侧栏元数据的 runId 更新为本轮，否则切走再点回会拿到上一轮的 stale runId。
      appSessionStore().record({
        providerId,
        agentProfileId,
        runtimeProvider,
        runId,
        externalSessionId: resume,
        cwd: catalogCwd,
        prompt: displayPrompt
      })
    } else {
      // Ownership is durable before attachment bytes are created. A crash can no longer
      // leave a new-session attachment directory with no catalog runId to delete.
      appSessionStore().recordPending({
        providerId,
        agentProfileId,
        runtimeProvider,
        runId,
        cwd: catalogCwd,
        prompt: displayPrompt
      })
    }
    attachments = prepareRunAttachments(
      app.getPath('userData'),
      runId,
      request.attachments,
      cwd ? { providerId, cwd, ...(resume ? { sessionId: resume } : {}) } : undefined
    )
    runState.attachments = attachments
    if (managedConversation) {
      const prepared = managedConversation.prepareInput(attachments)
      runtimePrompt = prepared.prompt
      managedInputTextHash = prepared.inputTextHash
    } else runtimePrompt = providerAttachmentPrompt(providerId, runtimePrompt, attachments)
    if (resume) {
      win?.webContents.send('agent:session', {
        runId,
        sessionId: resume,
        ...(editSourceSessionId ? { previousSessionId: editSourceSessionId } : {}),
        externalSessionId: resume,
        providerId,
        agentProfileId
      })
    } else {
      win?.webContents.send('agent:session', {
        runId,
        sessionId: runId,
        ...(editSourceSessionId ? { previousSessionId: editSourceSessionId } : {}),
        providerId,
        agentProfileId,
        pending: true
      })
    }
  } catch (error) {
    try { cleanupProvisional() } catch { /* preserve the frontdoor error */ }
    deleteRunAttachments(app.getPath('userData'), runId)
    throw error
  }
  // Git 快照与非 managed Provider 的 recorder 配置读取彼此独立；并行启动，避免把
  // 两段本地预检串到 Provider 启动前。managed 路径直接复用上面已验证的配置快照。
  const initialDiffCapture = cwd ? beginGitTurnDiff(cwd) : Promise.resolve(unavailableCapture())
  let turnDiffCapture = initialDiffCapture
  let patchExcludeBasenames: string[] = []
  if (cwd) {
    const recorderEnablement = managedRecorderEnablement ?? (
      isManagedRecorderProvider(providerId) ? undefined : await resolveRecorderEnablement(cwd)
    )
    if (recorderEnablement?.enabled) {
      patchExcludeBasenames = recorderEnablement.config.capture.patchExcludeBasenames ?? []
    }
  }
  // 会话级 baseline 必须在本轮任何文件改动前就位。ensure() 命中同 revision + 同 session 的既有基线时
  // 复用「会话第一轮开始前」的原始快照（resume/续接不重锚，否则会把前几轮误当成会话前脏改动）；
  // 恢复/选择会话/应用重启后进程内没有基线时当场重锚并标 origin=resumed，照实说明只覆盖「自重锚以来」。
  let sessionBaselineReady: Promise<unknown> = Promise.resolve()
  let sessionBaselineOrigin: TurnDiffBaselineOrigin | undefined
  let sessionBaselineCapture: Promise<GitTurnDiffCapture> | null = null
  let releaseSessionBaseline: (() => void) | undefined
  if (cwd && contextKey) {
    const baseline = sessionDiffBaselines.ensure({
      key: diffContextKey,
      revision: 0,
      cwd,
      ...(resume ? { sessionId: resume } : {}),
      initialCapture: initialDiffCapture
    })
    releaseSessionBaseline = sessionDiffBaselines.retain(baseline)
    sessionBaselineOrigin = baseline.origin
    sessionBaselineCapture = baseline.capture
    sessionBaselineReady = baseline.capture.catch(() => undefined)
    if (baseline.capture === initialDiffCapture) {
      // 新建/恢复重锚时，turn 与 session 需要同一时刻的基线，但必须有独立清理周期。
      // 创建轻量 scratch 并只读共享 baseline objects；clone 失败则回退完整采集，不牺牲证据。
      turnDiffCapture = initialDiffCapture
        .then((capture) => cloneGitTurnDiffCapture(capture))
        .catch((error) => {
          console.warn('[scry] Git baseline clone failed; falling back to a second capture:', runId, error)
          return beginGitTurnDiff(cwd)
        })
    }
  }
  // 运行中预览：用本轮 capture 与会话基线做非消费式重算，让长轮次里 Files / 会话改动行数 / Diff
  // 三处都有真实 Git 数据可看，并被明确标成临时快照。终态一发布即封口，预览不会覆盖或倒退终态。
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
  notifyDiffChange = () => void diffPreviewer.notifyChange()
  let pairedSessionDiff: { capture: GitTurnDiffCapture; snapshot: Promise<TurnDiffSnapshot> } | undefined
  let turnDiffPromise: Promise<void> | null = null
  const finalizeTurnDiff = (): Promise<void> => {
    // 终态第一次进入收口就把所有 scope 封口，再等全局 idle：idle 等的是全部在途预览链，
    // 只封 turn 的话 session 链还能继续续 trailing，收口要么白等，要么让迟到的预览
    // 落到终态之后。封口后算完的预览一律丢弃——终态覆盖预览，不倒退。
    diffPreviewer.sealAll()
    turnDiffPromise ??= diffPreviewer.idle()
      .then(() => turnDiffCapture)
      .then(async (capture) => {
        const options = { ...turnChangeJournal?.snapshot(), patchExcludeBasenames }
        const entry = cwd && contextKey
          ? sessionDiffBaselines.get(diffContextKey, 0, observedSessionId ?? resume)
          : undefined
        if (!entry) return finishGitTurnDiff(capture, undefined, options)
        let baseline: GitTurnDiffCapture
        try { baseline = await entry.capture } catch {
          // Session finalization retains its existing no_baseline reporting; turn evidence is independent.
          return finishGitTurnDiff(capture, undefined, options)
        }
        if (baseline.status !== 'ready') return finishGitTurnDiff(capture, undefined, options)
        const pair = finishGitTurnAndSessionDiff(capture, baseline, undefined, options, { patchExcludeBasenames })
        pairedSessionDiff = { capture: baseline, snapshot: pair.session }
        void pair.session.catch(error => console.warn('[scry] paired session diff failed:', runId, error))
        return pair.turn
      })
      .then((turnDiff) => {
        const event: TraceEvent = {
          id: mainEventId('turn-diff', runId),
          ts: new Date().toISOString(),
          runId,
          kind: 'harness',
          stage: 'turn_diff',
          providerId,
          runtimeProvider,
          turnDiff
        }
        appendCoalescedTrace(runState.items, event)
        // 终态在 done=true 之后才算完，isFocused 此刻已是 false；用 isViewed 判定
        // 「renderer 是否还在看这个 run」，否则归档里有 diff 而当前 UI 永远收不到。
        if (runs.isViewed(runId)) queueTrace(event)
        if (turnDiff.status === 'failed' || turnDiff.status === 'timeout') {
          console.warn('[scry] turn diff capture degraded:', runId, turnDiff.reason, turnDiff.captureMs)
        }
        if (turnDiff.collection?.strategy === 'full_fallback' && turnDiff.collection.fallbackReason !== 'forced') {
          console.warn(
            '[scry] turn diff used full fallback:',
            runId,
            turnDiff.collection.fallbackReason,
            turnDiff.collection.candidatePathCount,
            turnDiff.collection.discoveryMs,
            turnDiff.collection.targetedMs
          )
        }
        const patchUnavailable = turnDiff.files.filter((file) => file.patchStatus === 'unavailable')
        if (patchUnavailable.length > 0) {
          console.warn(
            '[scry] turn diff patch partially unavailable:',
            runId,
            patchUnavailable.length,
            [...new Set(patchUnavailable.map((file) => file.patchReason))]
          )
        }
      })
      .catch(async (error) => {
        try {
          const capture = await turnDiffCapture
          await cancelGitTurnDiff(capture)
        } catch {
          // Capture may itself have failed before allocating a snapshot.
        }
        console.warn('[scry] turn diff finalization failed:', runId, error)
      })
    return turnDiffPromise
  }
  const cancelTurnDiff = (): Promise<void> => {
    diffPreviewer.sealAll()
    turnDiffPromise ??= diffPreviewer.idle()
      .then(() => turnDiffCapture)
      .then((capture) => cancelGitTurnDiff(capture))
      .catch((error) => console.warn('[scry] turn diff cancellation failed:', runId, error))
    return turnDiffPromise
  }
  // 会话级净 diff：在逐轮 turnDone 后，用贯穿会话的 baseline 对当前工作树重算「基线 → 此刻」，
  // 落一条 harness/session_diff。它是右栏会话 diff 与对话末尾会话摘要的权威来源。
  //
  // 每一轮都必须落一条，失败也要落 unavailable + reason：renderer 的会话快照选取是「从最近一轮
  // 往前找第一条带快照的轮次并停下」，静默跳过会让它越过本轮回退到上一轮的旧快照，把过期数字
  // 当成当前会话净改动展示（实测：只有首轮落过 session_diff，后续轮次一直显示首轮的文件与行数）。
  // 非消费式，baseline 继续供后续轮复用。
  let sessionDiffPromise: Promise<void> | null = null
  const finalizeSessionDiff = (): Promise<void> => {
    if (!cwd || !contextKey) return Promise.resolve()
    // 同 finalizeTurnDiff：终态收口先全封口，再等全局 idle，不给任何 scope 留续 trailing 的机会。
    diffPreviewer.sealAll()
    sessionDiffPromise ??= (async () => {
      await diffPreviewer.idle()
      const publishSessionDiff = (snapshot: TurnDiffSnapshot, origin?: TurnDiffBaselineOrigin): void => {
        const event: TraceEvent = {
          id: mainEventId('session-diff', runId),
          ts: new Date().toISOString(),
          runId,
          kind: 'harness',
          stage: 'session_diff',
          providerId,
          runtimeProvider,
          turnDiff: origin ? { ...snapshot, baseline: origin } : snapshot
        }
        appendCoalescedTrace(runState.items, event)
        if (runs.isViewed(runId)) queueTrace(event)
      }
      const unavailableSnapshot = (reason: TurnDiffReason): TurnDiffSnapshot => {
        const at = new Date().toISOString()
        return { version: 1, status: 'unavailable', reason, files: [], beforeAt: at, afterAt: at, captureMs: 0, cleanup: 'ok' }
      }
      const entry = sessionDiffBaselines.get(diffContextKey, 0, observedSessionId ?? resume)
      if (!entry) {
        console.warn('[scry] session diff baseline not found:', runId, {
          contextRevision,
          sessionId: observedSessionId ?? resume
        })
        publishSessionDiff(unavailableSnapshot('no_baseline'))
        return
      }
      let baseline: GitTurnDiffCapture
      try {
        baseline = await entry.capture
      } catch (error) {
        console.warn('[scry] session diff baseline capture rejected:', runId, error)
        publishSessionDiff(unavailableSnapshot('no_baseline'), entry.origin)
        return
      }
      if (baseline.status !== 'ready') {
        console.warn('[scry] session diff baseline not ready:', runId, baseline.status, baseline.reason)
        publishSessionDiff(
          { ...unavailableSnapshot(baseline.reason ?? 'no_baseline'), status: baseline.status },
          entry.origin
        )
        return
      }
      let snapshot: TurnDiffSnapshot
      try {
        snapshot = await (pairedSessionDiff?.capture === baseline
          ? pairedSessionDiff.snapshot
          : snapshotSessionNetDiff(baseline, undefined, { patchExcludeBasenames }))
      } catch (error) {
        console.warn('[scry] session diff capture failed:', runId, error)
        publishSessionDiff(unavailableSnapshot('git_error'), entry.origin)
        return
      }
      publishSessionDiff(snapshot, entry.origin)
    })().catch((error) => console.warn('[scry] session diff finalization failed:', runId, error))
    return sessionDiffPromise
  }
  let notifiedSessionId = resume
  const publishSessionId = (sessionId: string | undefined): void => {
    if (!sessionId) return
    observedSessionId = sessionId
    if (isRemoteRun) options.onSession?.(sessionId)
    diffContextKey = sessionDiffBaselines.promote(diffContextKey, sessionBaselineKey(contextKey, sessionId), sessionId)
    if (!managedConversation && !isRemoteRun && (sessionRevisionByContext.get(contextKey) ?? 0) === contextRevision) {
      sessionByContext.set(contextKey, sessionId)
      sessionAliasesByContext.set(contextKey, new Map([[runId, sessionId]]))
    }
    const previousSessionKey = scopedSessionKey(runState.externalSessionId ?? runState.sessionId ?? runId)
    runState.sessionId = sessionId
    runState.externalSessionId = sessionId
    dockBadge.rekey(previousSessionKey, scopedSessionKey(sessionId))
    if (cwd) {
      try { updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId }) } catch (error) {
        console.warn('[scry] attachment ownership update deferred:', runId, error)
      }
    }
    try {
      appSessionStore().record({
        providerId,
        agentProfileId,
        runtimeProvider,
        runId,
        externalSessionId: sessionId,
        cwd: catalogCwd,
        prompt: displayPrompt
      })
    } catch (error) {
      console.warn('[scry] native session catalog update deferred:', runId, error)
    }
    if (runs.isViewed(runId)) {
      dockBadge.view(scopedSessionKey(sessionId), Boolean(win?.isFocused()))
    }
    if (notifiedSessionId === sessionId) return
    notifiedSessionId = sessionId
    try {
      win?.webContents.send('agent:session', {
        runId,
        sessionId,
        previousSessionId: editSourceSessionId ?? runId,
        externalSessionId: sessionId,
        providerId,
        agentProfileId
      })
    } catch (error) {
      console.warn('[scry] native session renderer notification failed:', runId, error)
    }
  }
  let h: ProviderRunHandle | null = null
  const steering = new RunSteering(
    runState,
    () => h?.steer,
    (input) => prepareRunAttachments(app.getPath('userData'), runId, input.attachments,
      cwd ? { providerId, cwd, sessionId: runState.externalSessionId } : undefined, input.messageId),
    emit
  )
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
  const runProvider = async (): Promise<{
    externalSessionId?: string
    providerTurnId?: string
    forkTurnId?: string
    stopped?: boolean
    status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    recordingFailure?: { message: string }
  }> => {
    if (interrupted) return { stopped: true }
    observedProviderStartedAt = new Date().toISOString()
    firstTracePerf.mark('provider_launch')
    firstTextPerf.mark('provider_launch')
    // Re-hash executable bytes at the actual Provider launch boundary, after all
    // attachment/recorder/diff preparation that may have yielded to the event loop.
    if (managedConversation) {
      await conversationStore().assertManagedWriteAllowed({
        conversationId: managedConversation.conversationId,
        cwd: catalogCwd,
        target: managedConversation.target,
        nativeSessionId: resume,
        runId: managedConversation.runId
      })
      const identity = await providerRegistry.continuationKey({ providerId, cwd: catalogCwd, agentProfileId })
      if (identity !== managedConversation.target.continuationKey) throw new Error('Provider 接续身份在启动准备期间变化，未发送；请重新预览')
    } else await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: resume })
    const mcpExecution = authorizedMcpExecution(mcpExecutionSnapshot)
    if (managedConversation && runId !== managedConversation.runId) {
      throw new Error('统一对话 runId 与 Provider 投递 runId 不一致')
    }
    managedConversation?.onProviderDispatchAttempt?.()
    h = providerRegistry.run(providerId, {
      runId,
      prompt: runtimePrompt,
      ...(managedConversation?.historicalContext ? { historicalContext: managedConversation.historicalContext } : {}),
      ...(managedConversation?.historyReader ? { historyReader: managedConversation.historyReader } : {}),
      ...(managedConversation ? {
        expectedContinuationKey: managedConversation.target.continuationKey,
        expectedInputTextHash: managedInputTextHash,
        historyBudget: managedConversation.historyBudget
      } : {}),
      // First / same-provider turns need receipts too. Native slash commands retain
      // their existing dispatch; a successful control command is not model-input evidence.
      trackInputReceipt: adapter.historicalContext && !runtimePrompt.trimStart().startsWith('/') ? true : undefined,
      cwd,
      agentProfileId,
      resume,
      attachments,
      model: request.model,
      effort: request.effort,
      permissionMode: options.permissionModeOverride ?? request.permissionMode,
      codexHookTrust,
      openCodePluginTrust,
      managedRecorder: managedRecorderEnabled,
      ...(managedRecorderEnabled && (providerId === 'claude' || providerId === 'qoder' || providerId === 'opencode' || providerId === 'pi') ? {
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(displayPrompt).digest('hex')
        }
      } : {}),
      mcpExecution,
      recordNative: eventLog && ((type, payload) => eventLog.record('native', type, payload)),
      emit: (event) => {
        eventLog?.record('canonical', `${event.kind}/${event.stage}`, event)
        // The input-attempt diagnostic precedes the native call, not a Provider response.
        if (event.stage !== 'runtime:input_receipt' && event.stage !== 'runtime:historical_input') {
          firstTracePerf.finish({ bufferedEvents: runState.items.length })
        }
        if (event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta') &&
          typeof event.text === 'string' && event.text.length > 0) {
          // This is the first provider text event, not a renderer paint or a UI display time.
          firstTextPerf.finish({ bufferedEvents: runState.items.length })
        }
        emit(event)
      },
      onExternalSessionId: publishSessionId,
      requestUserInput: async (question, signal) => {
        if (!isRemoteRun) return userQuestionBroker.request({ ...question, providerId }, signal)
        if (!options.requestUserInput) throw new Error('remote_interactive_input_unsupported')
        const openedAtMs = Date.now()
        const remoteQuestion = { ...question, providerId, runId }
        publishQuestionOpened(remoteQuestion)
        const questionAbort = new AbortController()
        const relayAbort = (): void => questionAbort.abort()
        const questionSources = [signal, stopLatch.signal, options.stopSignal].filter((source): source is AbortSignal => Boolean(source))
        for (const source of questionSources) {
          if (source.aborted) questionAbort.abort()
          else source.addEventListener('abort', relayAbort, { once: true })
        }
        let response: AgentQuestionResponse
        try {
          response = await options.requestUserInput(remoteQuestion, questionAbort.signal)
        } finally {
          for (const source of questionSources) source.removeEventListener('abort', relayAbort)
          publishQuestionClosed(runId, question.questionId)
        }
        const closedAtMs = Date.now()
        emit({
          id: `remote-intervention-${question.questionId}`,
          ts: new Date(closedAtMs).toISOString(), runId, kind: 'human', stage: 'intervention',
          toolUseId: question.questionId, providerId, agentId: question.agentId,
          durationMs: Math.max(0, closedAtMs - openedAtMs),
          intervention: {
            kind: question.questionKind ?? 'clarification', source: question.source ?? 'unknown',
            resolution: response.behavior === 'answered' ? 'answered' : signal.aborted ? 'provider_cancelled' : 'user_cancelled',
            request: { ...question, providerId }, response,
            openedAt: new Date(openedAtMs).toISOString(), closedAt: new Date(closedAtMs).toISOString(),
            durationMs: Math.max(0, closedAtMs - openedAtMs)
          }
        })
        return response
      }
    })
    if (options.stopSignal?.aborted) requestStop()
    if (!h.steer) emit({
      id: mainEventId('steer-capability', runId), ts: new Date().toISOString(), runId,
      kind: 'harness', stage: 'runtime:steer_capability',
      steerCapability: { status: 'unavailable', reason: `${providerId} 当前接入未提供已验证的原生 Steer；消息仍按队列发送。` }
    })
    if (interrupted) h.interrupt()
    let result: Awaited<typeof h.promise>
    try {
      try { result = await h.promise } finally {
        steering.close()
        await steering.idle()
      }
    } catch (error) {
      emit({
        id: mainEventId('provider-ended', runId),
        ts: new Date().toISOString(),
        runId,
        kind: 'harness',
        stage: 'runtime:provider_ended',
        providerId,
        runtimeProvider,
        runtimeMetadata: { status: 'failed' }
      })
      await ingestion.idle()
      throw error
    }
    emit({
      id: mainEventId('provider-ended', runId),
      ts: new Date().toISOString(),
      runId,
      kind: 'harness',
      stage: 'runtime:provider_ended',
      providerId,
      runtimeProvider,
      runtimeMetadata: { status: result.status ?? (result.stopped ? 'interrupted' : 'completed') }
    })
    await ingestion.idle()
    if (result.status === 'failed') {
      const providerMessage = [...runState.items].reverse().find(
        (event) => event.kind === 'harness' && event.stage === 'result' && event.isError
      )?.text ?? [...runState.items].reverse().find((event) => event.stage === 'runtime:background_unresolved')?.text
      throw new AgentRuntimeError(providerMessage || `${providerId} Provider 返回失败终态`, {
        provider: runtimeProvider,
        stage: 'runtime',
        cwd,
        nextAction: '检查该轮 Provider 结果与日志后重试'
      })
    }
    return result
  }
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
    steer: (input) => managedConversation
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
      contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
      // Adoption changes only Mac selection. This run keeps its own baseline.
      if (observedSessionId) sessionByContext.set(contextKey, observedSessionId)
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
      runs.register(runState, control, isRemoteRun || managedConversation ? { focus: false } : undefined)
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
  if (!isRemoteRun && !managedConversation) dockBadge.view(scopedSessionKey(resume ?? runId), Boolean(win?.isFocused()))
  // `agent:start` can also be invoked through the preload bridge (for example by
  // the regression runner), so publish the authoritative focused snapshot after
  // registration and before the Provider can emit trace or questions.
  if (!isRemoteRun && !managedConversation) {
    try {
      win?.webContents.send('agent:focusedRun', boundedLiveRun(runState))
    } catch (error) {
      console.warn('[scry] focused run renderer notification failed:', runId, error)
    }
  }
  let terminalArchiveArgs: ArchiveTraceTurnArgs | undefined
  let terminalArchiveCommitted = false
  let managedSettlementAttempted = false
  let terminalStatus: 'completed' | 'failed' | 'cancelled' | 'interrupted' | undefined
  let remoteRecordingFailed = false
  const settleManagedConversation = async (status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): Promise<void> => {
    if (!managedConversation || managedSettlementAttempted) return
    managedSettlementAttempted = true
    const receipt = h?.getInputReceipt?.()
    try {
      if (terminalArchiveCommitted && terminalArchiveArgs?.sessionId && cwd) {
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
            sessionId: terminalArchiveArgs.sessionId,
            ...(terminalArchiveArgs.providerTurnId ? { providerTurnId: terminalArchiveArgs.providerTurnId } : {})
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
  remoteResult = isRemoteRun
    ? new Promise<RemoteRunCompletion>((resolve) => { resolveRemoteCompletion = resolve })
    : undefined
  const finishRemote = (status: RemoteRunCompletion['status'], error?: string): void => {
    if (!isRemoteRun || remoteCompletion) return
    remoteCompletion = {
      status,
      recording: remoteRecordingFailed ? 'failed' : 'committed',
      ...(observedSessionId ? { externalSessionId: observedSessionId } : {}),
      ...(terminalArchiveArgs?.providerTurnId ? { providerTurnId: terminalArchiveArgs.providerTurnId } : {}),
      ...(terminalArchiveArgs?.forkTurnId ? { forkTurnId: terminalArchiveArgs.forkTurnId } : {}),
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
  const runtimePromise = Promise.all([turnDiffCapture, sessionBaselineReady]).then(() => {
    firstTextPerf.mark('git_baseline_ready')
    return runProvider()
  })
  runtimePromise
    .then(async (r) => {
      const terminalPerf = new PerformanceTrace('agent.terminal_finalize', { provider: providerId })
      terminalPerf.mark('provider_terminal')
      emit(finishTurnWallTiming())
      const turnDiffDone = finalizeTurnDiff()
      const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
      const nativeSessionId = r.externalSessionId ?? observedSessionId ?? resume
      const storageSessionId = nativeSessionId ?? runId
      const completionStatus = r.status ?? (r.stopped ? 'interrupted' : 'completed')
      terminalStatus = completionStatus
      await persistLlmPerformance(completionStatus !== 'completed', storageSessionId)
      const completionNeedsAttention = completionStatus === 'completed' || completionStatus === 'failed'
      const completionArchiveArgs: ArchiveTraceTurnArgs = {
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
      // Diff 是附加观测数据：立即开始采集，但不能阻塞用户看到 turnDone。
      // 归档仍等待它完成，保证历史回放最终包含 turn_diff。
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
        win?.webContents.send('agent:error', {
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
        if (isRemoteRun) remoteRecordingFailed = true
        const { message, category } = recordingPolicy.rendererError
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        if (recordingPolicy.blockSession) {
          recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        }
        win?.webContents.send('agent:error', {
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
      terminalArchiveArgs = completionArchiveArgs
      try {
        // Provider 已完成时先落一份 durable canonical snapshot。若 App 在等待 Git diff
        // 期间崩溃，下一次启动仍能用同一用户输入、模型输出、调用与权威 result timing
        // 恢复 archive/CLI；diff 会明确记为 unavailable，而不是伪造零值。
        await persistTerminalProgress(completionArchiveArgs)
      } catch (error) {
        if (isRemoteRun) remoteRecordingFailed = true
        const message = `${terminalOutcomeLabel(completionStatus)}，但 Scry 精确记录快照失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        win?.webContents.send('agent:error', {
          runId,
          message,
          category: 'recording',
          hint: runState.errorHint
        })
      }
      if (!canonicalLifecycle && !alreadyDone) {
        win?.webContents.send('agent:turnDone', {
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
        terminalArchiveCommitted = true
        recordingBlockedSessions.delete(scopedSessionKey(storageSessionId))
        terminalPerf.mark('archive_committed')
        await settleManagedConversation(completionStatus)
      } catch (error) {
        if (isRemoteRun) remoteRecordingFailed = true
        const message = `${terminalOutcomeLabel(completionStatus)}，但 Scry 精确记录提交失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        win?.webContents.send('agent:error', {
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
      // B2：把这一轮的 turn + tool_calls 结构化落 sqlite（runState 已缓冲全部事件）
      persistRunData(storageSessionId)
      terminalPerf.mark('database_projected')
      if (canonicalLifecycle && !alreadyDone) {
        win?.webContents.send('agent:turnDone', {
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
    }, async (err) => {
      emit(finishTurnWallTiming())
      const turnDiffDone = finalizeTurnDiff()
      const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
      const alreadyDone = runState.done
      const stopped = interrupted
      terminalStatus = stopped ? 'interrupted' : 'failed'
      let nativeSessionId = observedSessionId ?? resume
      try {
        nativeSessionId = h?.getExternalSessionId() ?? nativeSessionId
      } catch (error) {
        console.warn('[scry] Provider session getter failed at terminal boundary:', runId, error)
      }
      const storageSessionId = nativeSessionId ?? runId
      await persistLlmPerformance(true, storageSessionId)
      const runtimeErr = err instanceof AgentRuntimeError ? err : null
      const message = String(err?.message ?? err)
      const terminalReason = [...runState.items].reverse().find(
        (event) => event.kind === 'harness' && event.stage === 'result' && event.terminationReason
      )?.terminationReason
      const classified = terminalReason
        ? { category: terminalReason, hint: runTerminationHint(terminalReason) }
        : runtimeErr
          ? { category: runtimeErr.brief.stage, hint: runtimeErr.brief.nextAction }
          : classifyError(message)
      const { category, hint } = classified
      let providerTurnId: string | undefined
      try {
        providerTurnId = h?.getProviderTurnId?.()
      } catch (error) {
        console.warn('[scry] Provider turn getter failed at terminal boundary:', runId, error)
      }
      let forkTurnId = providerTurnId
      try {
        forkTurnId = h?.getForkTurnId?.() ?? forkTurnId
      } catch (error) {
        console.warn('[scry] Provider fork turn getter failed at terminal boundary:', runId, error)
      }
      let providerRecordingFailure: { message: string } | undefined
      try {
        providerRecordingFailure = h?.getRecordingFailure?.()
      } catch (error) {
        console.warn('[scry] Provider recording failure getter failed at terminal boundary:', runId, error)
      }
      terminalArchiveArgs = {
        providerId,
        runtimeProvider,
        cwd,
        sessionId: archiveSessionId(managedRecorderEnabled, nativeSessionId, storageSessionId),
        providerTurnId,
        forkTurnId,
        runId,
        userText: displayPrompt,
        attachments,
        items: runState.items,
        done: true,
        status: stopped ? 'interrupted' : 'failed',
        observedTiming,
        commitHookEnv: managedCommitHookEnv,
        managedRecorderEnabled,
        beforePersist: () => ingestion.idle(),
        ...(stopped ? {} : { error: message, errorHint: hint })
      }
      if (cwd) {
        try { updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId: storageSessionId }) } catch (error) {
          console.warn('[scry] terminal attachment ownership update failed:', runId, error)
        }
      }
      if (!runState.done) {
        if (!stopped) {
          const failure = ensureFailedTerminalResult(runState.items, {
            runId,
            message,
            providerId,
            runtimeProvider,
            cwd,
            hint,
            brief: runtimeErr?.brief,
            id: mainEventId('result', runId),
            ts: new Date().toISOString()
          })
          if (runs.isFocused(runId)) {
            for (const correction of failure.corrections) queueTrace({ ...correction })
          }
          if (failure.created) {
            appendUsage(
              app.getPath('userData'),
              {
                providerId,
                agentProfileId,
                runtimeProvider,
                cwd,
                externalSessionId: storageSessionId,
                runId,
                source: failure.terminal.usageSource
              },
              failure.terminal
            )
          }
        }
        runState.done = true
        if (!stopped) {
          runState.error = message
          runState.errorHint = hint
        }
      }
      try {
        appSessionStore().record({
          providerId,
          agentProfileId,
          runtimeProvider,
          runId,
          externalSessionId: storageSessionId,
          cwd: catalogCwd,
          prompt: displayPrompt,
          lastRunOutcome: stopped ? 'interrupted' : 'failed'
        })
      } catch (catalogError) {
        win?.webContents.send('agent:error', {
          runId,
          message: `Provider 已失败，且会话 catalog 更新失败：${String((catalogError as Error).message)}`,
          category: 'catalog',
          hint: '保留 userData/app-sessions.json、archive 与 attachments 后重试恢复'
        })
      }
      void mirrorSessionTranscript(providerId, cwd, nativeSessionId)
      await ingestion.liveIdle()
      const recordingPolicy = providerRecordingPolicy(stopped ? 'interrupted' : 'failed', providerRecordingFailure)
      if (!recordingPolicy.allowCanonicalCommit) {
        if (isRemoteRun) remoteRecordingFailed = true
        const { message: recordingMessage, category } = recordingPolicy.rendererError
        runState.error = recordingMessage
        runState.errorHint = recordingRecoveryHint
        if (recordingPolicy.blockSession) {
          recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        }
        terminalArchiveArgs = undefined
        flushTraceSend()
        win?.webContents.send('agent:error', {
          runId,
          message: recordingMessage,
          category,
          hint: runState.errorHint
        })
        markTerminalAttention(storageSessionId, !stopped)
        await turnDiffDone
        persistRunData(storageSessionId)
        finishRemote(stopped ? 'interrupted' : 'failed', recordingMessage)
        return
      }
      try {
        await persistTerminalProgress(terminalArchiveArgs)
      } catch (progressError) {
        if (isRemoteRun) remoteRecordingFailed = true
        const recordingMessage = `Provider 已结束，但 Scry 精确记录快照失败：${String((progressError as Error).message)}`
        runState.error = recordingMessage
        runState.errorHint = recordingRecoveryHint
        recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        flushTraceSend()
        win?.webContents.send('agent:error', {
          runId,
          message: recordingMessage,
          category: 'recording',
          hint: runState.errorHint
        })
      }
      flushTraceSend()
      if (stopped && !canonicalLifecycle) {
        if (!alreadyDone) win?.webContents.send('agent:turnDone', {
          runId,
          stopped: true,
          providerId,
          agentProfileId,
          sessionId: storageSessionId,
          ...(providerTurnId ? { providerTurnId } : {}),
          ...(forkTurnId ? { forkTurnId } : {})
        })
      } else {
        win?.webContents.send('agent:error', { runId, message, category, hint })
        markTerminalAttention(storageSessionId, true)
      }
      await turnDiffDone
      await finalizeSessionDiff()
      let exactRecorded = true
      try {
        await archiveTraceTurn(terminalArchiveArgs)
        terminalArchiveCommitted = true
        recordingBlockedSessions.delete(scopedSessionKey(storageSessionId))
        await settleManagedConversation(stopped ? 'interrupted' : 'failed')
      } catch (archiveError) {
        if (isRemoteRun) remoteRecordingFailed = true
        exactRecorded = false
        recordingBlockedSessions.set(
          scopedSessionKey(storageSessionId),
          recordingRecoveryHint
        )
        console.error('[scry] exact turn archive failed:', archiveError)
        // Provider 本身已失败且没有 native turn identity 时，recorder 报错是次生错误；
        // 保留前面已经发送给 renderer 的真实 Provider 根因，不能再用 identity 错误覆盖它。
        if (canonicalLifecycle && providerTurnId) {
          const recordingMessage = `Scry 精确记录提交失败：${String((archiveError as Error).message)}`
          win?.webContents.send('agent:error', {
            runId,
            message: recordingMessage,
            category: 'recording',
            hint: recordingRecoveryHint
          })
        }
      }
      persistRunData(storageSessionId)
      if (stopped && canonicalLifecycle && !alreadyDone && exactRecorded) {
        win?.webContents.send('agent:turnDone', {
          runId,
          stopped: true,
          providerId,
          agentProfileId,
          sessionId: storageSessionId,
          ...(providerTurnId ? { providerTurnId } : {}),
          ...(forkTurnId ? { forkTurnId } : {})
        })
      }
      finishRemote(stopped ? 'interrupted' : 'failed', stopped ? undefined : message)
    })
    .catch(async (error) => {
      console.error('[scry] run completion handler failed:', error)
      await finalizeTurnDiff()
      if (terminalArchiveArgs && !terminalArchiveCommitted) {
        try {
          await archiveTraceTurn(terminalArchiveArgs)
          terminalArchiveCommitted = true
          if (terminalArchiveArgs.sessionId) {
            recordingBlockedSessions.delete(scopedSessionKey(terminalArchiveArgs.sessionId))
          }
        } catch (archiveError) {
          if (terminalArchiveArgs.sessionId) recordingBlockedSessions.set(
            scopedSessionKey(terminalArchiveArgs.sessionId),
            recordingRecoveryHint
          )
          console.error('[scry] fallback terminal archive failed:', archiveError)
        }
      }
      if (!runState.done) runState.done = true
      flushTraceSend()
      win?.webContents.send('agent:error', {
        runId,
        message: `Scry 处理 Provider 终态失败：${String((error as Error).message)}`,
        category: 'recording',
        hint: '保留 userData 与 workspace/.scry 后重启 Scry 检查归档'
      })
      if (isRemoteRun) remoteRecordingFailed = true
      markTerminalAttention(
        terminalArchiveArgs?.sessionId ?? observedSessionId ?? resume ?? runId,
        !interrupted
      )
      finishRemote(interrupted ? 'interrupted' : 'failed', String((error as Error).message ?? error))
    })
    .catch((error) => {
      // Terminal enrichment must never strand a remote executor. The first
      // rejection handler normally records the Provider failure; this guard
      // covers failures inside that handler itself (including diff/archive).
      if (isRemoteRun && !remoteCompletion) {
        remoteRecordingFailed = true
        finishRemote(interrupted ? 'interrupted' : 'failed', String((error as Error).message ?? error))
      }
    })
    .finally(async () => {
      try {
        await settleManagedConversation(terminalStatus ?? (interrupted ? 'interrupted' : 'failed'))
        options.stopSignal?.removeEventListener('abort', requestRemoteStop)
        runState.providerSettled = true
        firstTracePerf.finish(undefined, interrupted ? 'cancelled' : 'unavailable')
        firstTextPerf.finish(undefined, interrupted ? 'cancelled' : 'unavailable')
        // settle 是唯一的终止证据来源；它同时取消所有未触发的升级定时器。
        runStopLifecycle.settle(runId)
        userQuestionBroker.cancelRun(runId)
        runs.remove(runId)
        releaseSessionBaseline?.()
        resolveSettled?.()
        void eventLog?.close()
      } finally {
        if (isRemoteRun) {
          if (!remoteCompletion) {
            remoteRecordingFailed = true
            finishRemote('failed', 'remote_run_terminal_outcome_unknown')
          }
          remoteRunIds.delete(runId)
          remoteRunLedgerIds.delete(runId)
          if (remoteCompletion) resolveRemoteCompletion?.(remoteCompletion)
        }
      }
    })
      startPerf.finish({ attachments: attachments.length })
      return { runId }
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

/**
 * 带 commandId 的启动命令是幂等的：重投（连按发送、renderer 重放、远端重试）拿回
 * 第一次的 runId，而不是起第二轮，也不是收到「同一会话已在运行」的误导性错误。
 */
const agentStartReceipts = new CommandReceipts<{ runId: string } | RemoteRunCompletion>()
/** 远端分发的收据台账；键是 ledger 的 runId，与本地 IPC 的命令标识互不干扰。 */
const remoteStartReceipts = new CommandReceipts<RemoteRunCompletion>()
handleTrusted('agent:start', async (_e, payload: AgentStartRequest) => {
  const receipt = await agentStartReceipts.submit(payload?.commandId?.trim() || undefined, () => startAppRun(payload))
  return { ...receipt.result, commandStatus: receipt.status, commandSequence: receipt.sequence }
})

// Renderer 重挂时拉回当前焦点或全部在途 run；焦点只影响显示，不影响后台生命周期。
handleTrusted('agent:activeRun', (): ActiveRun | null => {
  const state = runs.focusedState()
  return state ? boundedLiveRun(state) : null
})
handleTrusted('agent:unreadSessions', () => dockBadge.snapshot())
// live trace 降级恢复专用：忽略 done，只要 registry 里还有这个 run 就给出权威事件序列。
// activeRun 会因为 done=true 返回 null，那样终态被跳过的事件永远补不回来。
handleTrusted('agent:focusedRunSnapshot', (): ActiveRun | null => {
  const state = runs.focusedSnapshot()
  return state ? boundedLiveRun(state) : null
})
handleTrusted('agent:activeRuns', (): ActiveRun[] => runs.activeStates().map(boundedLiveRun))
handleTrusted('agent:focusRun', (_event, runId: string | null): boolean => {
  const focused = runs.focus(runId)
  if (!focused || !runId) return focused
  const sessionKey = activeRunSessionKey(runs.get(runId)!.state)
  if (sessionKey) dockBadge.view(sessionKey, Boolean(win?.isFocused()))
  return true
})
handleTrusted('agent:adoptActiveRun', (_event, runId: string): ActiveRun | null => {
  const entry = runs.get(runId)
  if (!entry || entry.state.done) return null
  entry.control.adoptSession()
  runs.focus(runId)
  const sessionKey = activeRunSessionKey(entry.state)
  if (sessionKey) dockBadge.view(sessionKey, Boolean(win?.isFocused()))
  return boundedLiveRun(entry.state)
})
handleTrusted('agent:answerQuestion', (event, response: unknown) => {
  if (!win || event.sender.id !== win.webContents.id) return false
  const runId = (response as { runId?: unknown } | null)?.runId
  const ledgerRunId = typeof runId === 'string' ? remoteRunLedgerIds.get(runId) : undefined
  // A device-started run's question lives on the remote broker; answering it
  // here settles the same question the device sees, exactly once.
  if (ledgerRunId) return remoteHostService?.controller.answerOwnerQuestion(ledgerRunId, response as AgentQuestionResponse) ?? false
  return userQuestionBroker.answer(response)
})

// B2：sqlite 跨会话分析（工具频率 / 按目录花费），纯文件做不到的结构化查询
handleTrusted('agent:stats', () => statsQuery())
handleTrusted('agent:llmPerformanceHistory', () => readLlmPerformanceHistory(app.getPath('userData')))
handleTrusted('agent:llmPerformanceSummary', () => summarizeRunningLlmSessions(runs.activeStates()))

handleTrusted('agent:usageAnalytics', (_event, rangeDays: unknown) => {
  if (rangeDays !== 7 && rangeDays !== 30 && rangeDays !== 90) throw new Error('分析时间范围无效')
  return usageAnalyticsWithCreditsQuery(rangeDays as UsageAnalyticsRangeDays)
})
handleTrusted('agent:billingState', async () => {
  await warmShellEnv()
  return billingStateQuery()
})
handleTrusted('agent:syncBillingAdmin', async () => {
  await warmShellEnv()
  return syncBillingAdmin()
})
handleTrusted('agent:importBillingFixture', async () => {
  await warmShellEnv()
  return importBillingFixture()
})

// P2 Files & Diff：cwd 的最终 git diff（vs HEAD 增删），与工具足迹对照
registerGitDiffIpc(handleTrusted, resolveKnownProjectDirectory)
handleTrusted('agent:recorderContentPage', async (_event, request: unknown) => {
  const cwd = currentCwd ?? ''
  if (request && typeof request === 'object' && 'source' in request) {
    if (request.source !== 'app-trace') throw new Error('invalid_content_source')
    const page = await readAppTraceContentPage(app.getPath('userData'), cwd, request)
    if ((currentCwd ?? '') !== cwd) throw new Error('recorder_workspace_changed')
    return page
  }
  if (!cwd) throw new Error('recorder_workspace_unavailable')
  // Reading is authorized by the selected workspace's validated recorder location and record
  // references, not by the current enablement flag. Existing evidence remains inspectable when
  // capture is disabled or a sentinel is present; no path supplied by the renderer is opened.
  const location = await resolveRecorderLocation(cwd)
  if (currentCwd !== cwd) throw new Error('recorder_workspace_changed')
  if (!location.valid) throw new Error(`recorder_unavailable:${location.reason}`)
  return readAuthorizedRecorderContentPage(location.dataRoot, request)
})

// trace live 镜像的消费确认：renderer 完成批量 state commit 后归还精确批次额度。
// generation + batchId 防止窗口重挂后的迟到/重复 ACK 释放新 renderer 的额度。
handleTrusted('agent:traceAck', (_event, request: TraceBatchReceipt) => traceOutput.ack(request))
// renderer 已经用权威快照（activeRun）对齐 live 视图，降级标记可以清除。
handleTrusted('agent:traceResynchronized', () => {
  traceOutput.resynchronized()
  return true as const
})

handleTrusted('agent:stopBackgroundTask', (_event, payload: unknown) => stopObservedBackgroundTask(payload, (runId) => runs.get(runId)))

handleTrusted('agent:stop', (_event, runId: string) => requestRunStop(runId))
handleTrusted('agent:steer', (_event, payload: unknown) => steerObservedRun(payload, (runId) => runs.get(runId)))

// Shared by the Mac stop button and a paired device stopping a Mac run.
function requestRunStop(runId: string): boolean {
  const entry = runs.get(runId)
  if (!entry || entry.state.done) return false
  const stopping = entry.control
  // 有界升级取代旧的「2s 后假装这一轮已结束」：先协作取消，窗口到点升级 forceKill，
  // 再到点只诚实报告 Provider 未确认终止。终态仍然只能由真实 settle 产生。
  runStopLifecycle.request({
    runId: stopping.runId,
    providerId: stopping.providerId,
    agentProfileId: stopping.runState.agentProfileId,
    runtimeProvider: stopping.runtimeProvider,
    interrupt: stopping.interrupt,
    forceKill: stopping.forceKill,
    forceKillScope: stopping.forceKillScope
  })
  userQuestionBroker.cancelRun(stopping.runId)
  return true
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
let desktopRemoteClient: DesktopRemoteClient | null = null
function requireDesktopSecureStorage(): typeof safeStorage {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存远程设备凭据')
  return safeStorage
}
function requireDesktopRemoteClient(): DesktopRemoteClient {
  // An empty saved-host list must not initialize/unlock Keychain during startup.
  // Existing credentials and every persisted write still require secure storage.
  desktopRemoteClient ??= new DesktopRemoteClient({
    directory: join(app.getPath('userData'), 'desktop-connections'),
    encrypt: (value) => requireDesktopSecureStorage().encryptString(value),
    decrypt: (value) => requireDesktopSecureStorage().decryptString(value)
  })
  return desktopRemoteClient
}
registerDesktopClientIpc(handleTrusted, requireDesktopRemoteClient)
// Explicit relay wiring remains available for private deployments. Without an
// override, packaged builds use the official public WSS relay with a generated
// per-host room credential; no app-wide bearer is embedded in the artifact.
type RemoteRelayResolution = Pick<RemoteHostServiceDependencies, 'createTransport' | 'relayAdvertisement'>
function createRemoteWssResolution(endpoint: URL, token: string, enroll: boolean): RemoteRelayResolution {
  const url = endpoint.origin
  const createTransport: RemoteHostServiceDependencies['createTransport'] = (ctx) => {
    const { connect, readyEvent } = createRelayConnectWS({ url, hostId: ctx.hostId, token, enroll, mode: ctx.mode })
    // A paired phone keeps up to four persistent run lanes (control, live watch,
    // live-run status, bulk history), so keep four warm run legs; recycle idle legs every 55 s.
    return new ReverseTunnelTransport({ connect, readyEvent, poolSize: ctx.mode === 'run' ? 4 : 2, idleLegMs: 55_000 })
  }
  return {
    createTransport,
    relayAdvertisement: {
      host: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'wss:' ? 443 : 80,
      tls: endpoint.protocol === 'wss:' ? 'system' : 'plaintext'
    }
  }
}

async function resolveRemoteRelay(stateDirectory: string): Promise<RemoteRelayResolution> {
  // An SSH-only host need not dial any public relay. This never disables the
  // inner device authentication or changes the existing packaged default.
  if (process.env.SCRY_REMOTE_RELAY_ENABLED === '0') return {}
  // An explicit Cloudflare-compatible relay takes precedence.
  //   SCRY_REMOTE_RELAY_WS = { "url": "wss://relay.example", "token": "..." }
  const wsRaw = process.env.SCRY_REMOTE_RELAY_WS
  if (wsRaw) {
    let wsCfg: { url?: unknown; token?: unknown }
    try { wsCfg = JSON.parse(wsRaw) } catch { console.warn('[scry] SCRY_REMOTE_RELAY_WS is not valid JSON; remote relay disabled'); return {} }
    if (typeof wsCfg.url !== 'string' || typeof wsCfg.token !== 'string' || wsCfg.token.length === 0) {
      console.warn('[scry] SCRY_REMOTE_RELAY_WS missing url/token; remote relay disabled')
      return {}
    }
    let endpoint: URL
    try { endpoint = new URL(wsCfg.url) } catch { console.warn('[scry] SCRY_REMOTE_RELAY_WS url is invalid; remote relay disabled'); return {} }
    if (!['wss:', 'ws:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      console.warn('[scry] SCRY_REMOTE_RELAY_WS url must be a root ws/wss origin without credentials; remote relay disabled')
      return {}
    }
    return createRemoteWssResolution(endpoint, wsCfg.token, false)
  }

  // Legacy raw TCP remains explicit-only because it has no device-facing WSS
  // advertisement. A malformed explicit override fails closed instead of
  // silently falling back to Scry's public infrastructure.
  const raw = process.env.SCRY_REMOTE_RELAY
  if (raw) {
    let cfg: { host?: unknown; port?: unknown; token?: unknown; tls?: unknown; caPath?: unknown }
    try { cfg = JSON.parse(raw) } catch { console.warn('[scry] SCRY_REMOTE_RELAY is not valid JSON; remote relay disabled'); return {} }
    if (typeof cfg.host !== 'string' || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
      console.warn('[scry] SCRY_REMOTE_RELAY missing host/port/token; remote relay disabled')
      return {}
    }
    const host = cfg.host, port = cfg.port, token = cfg.token
    const tls = cfg.tls === true
      ? { ca: typeof cfg.caPath === 'string' ? readFileSync(cfg.caPath, 'utf8') : undefined, servername: host }
      : undefined
    return {
      createTransport: (ctx) => {
        const { connect, readyEvent } = createRelayConnect({ host, port, hostId: ctx.hostId, token, mode: ctx.mode, tls })
        return new ReverseTunnelTransport({ connect, readyEvent })
      }
    }
  }

  const endpoint = new URL(DEFAULT_PUBLIC_RELAY_WS)
  const identity = await ensureHostIdentity(join(stateDirectory, 'identity'))
  const token = ensureRelayCredential(join(stateDirectory, 'relay'), identity.hostId)
  return createRemoteWssResolution(endpoint, token, true)
}
// Cached snapshot of the host's Providers for the device new-session picker.
// providerRegistry.describe() is async but the device op reads synchronously, so
// we keep a periodically-refreshed snapshot (id/label/available). Availability
// mirrors the real describe() result; nothing is fabricated, and the run path
// still validates the chosen providerId on submit.
let remoteProviderSnapshot: RemoteProviderRef[] = []
let remoteProviderRefresh: ReturnType<typeof setInterval> | undefined

function configuredRemotePermissionMode(): AgentPermissionMode | undefined {
  const raw = process.env.SCRY_REMOTE_PERMISSION_MODE
  return isAgentPermissionMode(raw) ? raw : undefined
}

async function loadRemoteProviderSnapshot(): Promise<void> {
  try {
    const descriptors = await providerRegistry.describe()
    const contexts = await Promise.all(descriptors.map(async (descriptor) => {
      if (!descriptor.available) return [remoteProviderMetadata({ descriptor })]
      const profiles = descriptor.id === 'pi' ? await listPiProfiles() : []
      const targets = profiles.length > 0 ? profiles.map((profile) => ({ id: profile.id, label: profile.label })) : [undefined]
      return targets.map((profile) => remoteProviderMetadata({ descriptor, ...(profile ? { profile } : {}) }))
    }))
    remoteProviderSnapshot = contexts.flat()
  } catch { /* keep the last good snapshot rather than fabricate */ }
}

const remoteProviderControlReads = createInFlightDeduper<RemoteProviderRef>()
async function loadSelectedRemoteProvider(query: { providerId: string; cwd: string; agentProfileId?: string }): Promise<RemoteProviderRef> {
  const canonical = resolveRemoteProjectDirectory(query.cwd)
  const descriptors = await providerRegistry.describe()
  const descriptor = descriptors.find((entry) => entry.id === query.providerId)
  if (!descriptor || !descriptor.available) throw new Error('invalid_provider_context')
  let profile: PiAgentProfile | undefined
  if (query.providerId === 'pi') {
    profile = await resolvePiProfile(query.agentProfileId ?? 'pi:default')
    if (!profile || (query.agentProfileId && profile.id !== query.agentProfileId)) throw new Error('invalid_provider_context')
  } else if (query.agentProfileId) {
    throw new Error('invalid_provider_context')
  }
  const key = JSON.stringify([query.providerId, profile?.id ?? '', canonical])
  return remoteProviderControlReads.load(key, async () => {
    try {
      const controls = await withProviderOperation(query.providerId as ProviderId, () => providerRegistry.runControls({
        providerId: descriptor.id,
        cwd: canonical,
        ...(profile ? { agentProfileId: profile.id } : {})
      }), profile?.id)
      return remoteProviderEntry({
        descriptor,
        ...(profile ? { profile } : {}),
        controls,
        previous: [],
        permissionOverride: configuredRemotePermissionMode()
      })
    } catch {
      return { ...remoteProviderMetadata({ descriptor, ...(profile ? { profile } : {}) }), available: false }
    }
  })
}

async function loadLegacyRemoteProviders(): Promise<RemoteProviderRef[]> {
  const descriptors = await providerRegistry.describe()
  const contexts = await Promise.all(descriptors.map(async (descriptor) => {
    if (!descriptor.available) return [remoteProviderMetadata({ descriptor })]
    const controlsCwd = remoteProjectRoots()[0]
    if (!controlsCwd) return [remoteProviderMetadata({ descriptor })]
    const profiles = descriptor.id === 'pi' ? await listPiProfiles() : []
    const targets = profiles.length > 0 ? profiles.map((profile) => ({ id: profile.id, label: profile.label })) : [undefined]
    return Promise.all(targets.map((profile) => loadSelectedRemoteProvider({
      providerId: descriptor.id,
      cwd: controlsCwd,
      ...(profile ? { agentProfileId: profile.id } : {})
    })))
  }))
  return contexts.flat()
}
// A slow Provider control probe may exceed the timer interval. Coalesce those ticks and keep the
// last successful picker snapshot for one minute instead of probing every Provider every 15 seconds.
const remoteProviderSnapshotRefresh = createCachedAsyncLoader(loadRemoteProviderSnapshot, { ttlMs: 60_000 })
const refreshRemoteProviderSnapshot = (): Promise<void> => remoteProviderSnapshotRefresh.load()

async function startRemoteHostIfEnabled(): Promise<void> {
  if (remoteHostService || !remoteHostEnabled(process.env.SCRY_REMOTE_HOST, app.isPackaged)) return
  try {
    const stateDirectory = join(app.getPath('userData'), 'remote')
    const relay = await resolveRemoteRelay(stateDirectory)
    await refreshRemoteProviderSnapshot()
    if (!remoteProviderRefresh) remoteProviderRefresh = setInterval(() => { void refreshRemoteProviderSnapshot() }, 15_000)
    // Owner-explicit permission mode for remote runs. Default remote behaviour is
    // unchanged (interactive approval fails closed in remote-run-binding). Only
    // when the Mac owner sets SCRY_REMOTE_PERMISSION_MODE to a known mode do
    // routed device runs adopt it — e.g. 'full_access' so the owner's chosen
    // Provider runs without blocking on an approval the remote path cannot route.
    // This is an explicit owner opt-in on their own machine, not a silent escalation.
    const remotePermissionRaw = process.env.SCRY_REMOTE_PERMISSION_MODE
    const remotePermissionMode = configuredRemotePermissionMode()
    if (remotePermissionRaw && !remotePermissionMode) console.warn(`[scry] ignoring invalid SCRY_REMOTE_PERMISSION_MODE=${remotePermissionRaw}`)
    else if (remotePermissionMode) console.warn(`[scry] remote runs use owner-set permissionMode=${remotePermissionMode}`)
    remoteHostService = await RemoteHostService.create({
      stateDirectory,
      desktopWorkbench: createDesktopWorkbench({
        directory: join(app.getPath('userData'), 'desktop-terminal-recordings'),
        authorizeWorkspace: resolveRemoteProjectDirectory,
        sourceControl, environment: warmShellEnv, openPath: openLocalPath,
        trashItem: (path) => shell.trashItem(path)
      }),
      readDesktop: createDesktopHostReader({
        userDataDir: app.getPath('userData'),
        hostId: () => requireRemoteHost().hostId,
        authorizeWorkspace: (cwd) => resolveRemoteProjectDirectory(cwd),
        getRun: (runId) => {
          const state = runs.get(runId)?.state
          return state ? boundedLiveRun(state) : null
        }
      }),
      // Maintainer-approved: a paired owner may explicitly select any readable
      // host directory. Browsing grants nothing; selection uses the local picker
      // authority. Submit still revalidates the grant and repository trust.
      desktopDirectories: {
        list: listDesktopDirectories,
        select: (path) => selectDesktopDirectory(path, rememberProject)
      },
      // Fail closed: only directories selected through a local or authenticated
      // desktop picker (or descendants) may enter the run lifecycle.
      authorizeWorkspace: (cwd) => resolveRemoteProjectDirectory(cwd),
      gate: providerOperationGate,
      createTransport: relay.createTransport,
      relayAdvertisement: relay.relayAdvertisement,
      // Remote execution enters the same full lifecycle as agent:start. The
      // binding only adapts the authenticated device intent and output stream;
      // trust, attachments, diff, recorder, archive and DB settlement stay here.
      startRun: createRemoteRunBinding({
        permissionModeOverride: remotePermissionMode,
        // 中继可能重投同一条已登记的 intent。收据按 ledgerRunId 去重：重投等待/返回
        // 第一次的完成结果，不会在同一会话里起第二轮。
        startAppRun: (input) => remoteStartReceipts.submit(`remote-${input.ledgerRunId}`, () => startAppRun({
          ...input.request,
          backend: 'local',
          runtimeProvider: undefined
        }, {
          origin: 'remote',
          runId: input.runId,
          stopSignal: input.stopSignal,
          requestUserInput: input.requestUserInput,
          ledgerRunId: input.ledgerRunId,
          permissionModeOverride: input.permissionModeOverride,
          providerPrompt: input.providerPrompt,
          onTraceEvent: input.onTraceEvent,
          onSession: input.onSession
        }) as Promise<RemoteRunCompletion>).then((receipt) => receipt.result)
      }),
      // The phone's new-session picker chooses only among the host's already
      // directory-picker-authorized project dirs; it can never authorize a new
      // one. Snapshot per call so a locally-removed directory stops being
      // offered immediately, filter to still-existing dirs, and label by
      // basename. The workspace authorizer re-checks the cwd on submit anyway.
      listProjects: () => remoteProjectRoots().map((path) => ({ path, label: basename(path) || path })),
      // The paired phone may choose a narrower cwd, but cannot navigate to or
      // submit a parent/sibling outside the Mac's existing canonical grants.
      listDirectories: (path) => listRemoteDirectories(path, knownProjectDirectories()),
      // Metadata is a cheap picker snapshot; Provider controls are loaded only
      // after the device selects a Provider/profile and authorized cwd.
      listProviders: () => remoteProviderSnapshot,
      listProviderControls: (query) => loadSelectedRemoteProvider(query),
      // Compatibility for clients that explicitly omit the discovery detail.
      // This is on-demand and therefore cannot gate metadata or selected reads.
      listProvidersFull: () => loadLegacyRemoteProviders(),
      // Resolve the same native Provider command catalog used by the desktop
      // composer. The cwd is re-authorized before project-local commands/skills
      // are inspected; unsupported Providers return an honest reason.
      listCommands: async ({ providerId, cwd, agentProfileId }) => {
        if (!['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(providerId)) {
          return { commands: [], reason: 'unsupported_provider' }
        }
        const canonical = resolveRemoteProjectDirectory(cwd)
        const context: ProviderContext = {
          providerId: providerId as ProviderId,
          cwd: canonical,
          ...(agentProfileId ? { agentProfileId } : {})
        }
        const result = await withProviderOperation(
          context.providerId,
          () => providerRegistry.listCommands(context),
          context.agentProfileId
        )
        return {
          commands: result.data ?? [],
          ...(result.reason ? { reason: result.reason } : {})
        }
      },
      // Session metadata is always changed in the host catalog. The workspace
      // and exact Provider/profile/session identity are rechecked by the host
      // controller and the shared legacy-write fence before this callback runs.
      sessionAction: async (context: DesktopRemoteContext, action: DesktopRemoteSessionAction, authorize: () => void) => {
        const ref = sessionRefFromRequest(context)
        if (!ref) throw new Error('无效的远程会话操作请求')
        return changeLegacySessionMetadata(ref, () => {
          // Recovery/adoption checks await IO; revocation must win before writing.
          authorize()
          if (action.kind === 'rename') return appSessionStore().rename(ref, action.title)
          if (action.kind === 'pin') return appSessionStore().setPinned(ref, action.pinned)
          return action.archived
            ? archiveSessionAndStop(appSessionStore(), ref, runs.activeStates(), requestRunStop)
            : appSessionStore().setArchived(ref, false)
        })
      },
      // The host session catalog the device may browse, so the phone shows the
      // SAME conversations the Mac lists. Filtered to device-visible authorized
      // projects (a session whose cwd is not an authorized project dir is not
      // offered), most-recent-first. Archived metadata remains visible so a
      // client can restore it; opening content is re-authorized separately.
      sessionCatalogRevision: () => createHash('sha256').update(JSON.stringify(canonicalRemoteProjectRoots(knownProjectDirectories()))).digest('hex'),
      listSessions: () => {
        const roots = canonicalRemoteProjectRoots(knownProjectDirectories())
        const activeRuns = runs.activeStates()
        const out: { sessionId: string; externalSessionId?: string; providerId: string; agentProfileId?: string; cwd: string; label: string; ts: number; pinnedAt?: number; archivedAt?: number; isActive?: boolean }[] = []
        for (const s of appSessionStore().load()) {
          if (!s.cwd) continue
          let canonical: string
          try { canonical = resolveCanonicalRemoteProjectDirectory(s.cwd, roots) } catch { continue }
          const isActive = activeRuns.some((run) =>
            run.providerId === s.providerId && run.cwd === canonical &&
            (run.runId === s.runId || Boolean(s.externalSessionId && run.externalSessionId === s.externalSessionId)))
          out.push({
            sessionId: s.sessionId,
            ...(s.externalSessionId ? { externalSessionId: s.externalSessionId } : {}),
            providerId: s.providerId ?? 'legacy_unknown',
            ...(s.agentProfileId ? { agentProfileId: s.agentProfileId } : {}),
            cwd: canonical,
            label: (s.title ?? s.preview ?? '').slice(0, 256),
            ts: s.ts,
            ...(s.pinnedAt ? { pinnedAt: s.pinnedAt } : {}),
            ...(s.archivedAt ? { archivedAt: s.archivedAt } : {}),
            ...(isActive ? { isActive: true } : {})
          })
        }
        out.sort((a, b) => b.ts - a.ts)
        return out
      },
      readSessionStatus: (query) => observeSessionStatus(query, runs.activeStates()),
      // Mac UI runs, re-authorized by cwd inside the controller. A device answer
      // goes through the same broker as the Mac dialog, so whichever side answers
      // first settles the question exactly once.
      macRuns: {
        list: () => runs.activeStates().flatMap((run) => run.providerId && run.cwd && !remoteRunIds.has(run.runId) ? [{
          runId: run.runId,
          providerId: run.providerId,
          ...(run.agentProfileId ? { agentProfileId: run.agentProfileId } : {}),
          cwd: run.cwd,
          ...(run.externalSessionId ? { externalSessionId: run.externalSessionId } : {}),
          prompt: run.userText,
          questions: run.pendingQuestions ?? [],
          stopping: Boolean(run.stopState)
        }] : []),
        stop: (runId) => requestRunStop(runId),
        answer: (response) => userQuestionBroker.answer(response)
      },
      // First-screen evidence avoids the complete-history reader. Indexed
      // archives read only two turns; legacy/index-rebuild paths can still
      // materialize older data, and their provenance stays explicit.
      readHistoryVersion: async ({ providerId, cwd, externalSessionId }) => {
        const canonical = resolveRemoteProjectDirectory(cwd)
        return readRemoteHistoryVersion({
          cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
          userDataDir: app.getPath('userData')
        }, () => runs.activeStates().find((run) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
      },
      readHistoryTurnsPage: async ({ providerId, cwd, externalSessionId, before, limit = 3, snapshot }) => {
        const canonical = resolveRemoteProjectDirectory(cwd)
        return readRemoteHistoryTurnsPage({
          cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
          userDataDir: app.getPath('userData')
        }, { before, limit, snapshot }, () => runs.activeStates().find((run) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
      },
      readHistoryPreview: async ({ providerId, cwd, externalSessionId }) => {
        if (!providerId || !externalSessionId) return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
        let canonical: string
        try { canonical = cwd ? resolveRemoteProjectDirectory(cwd) : '' } catch { return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const } }
        const activeRun = runs.activeStates().find((run) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId))
        if (activeRun) {
          const projection = previewTraceItems(activeRun.items)
          return { status: 'available' as const, source: 'active_memory' as const, turns: [{
            userText: activeRun.userText,
            userTextTruncated: false,
            items: projection.items,
            truncated: projection.truncated
          }], partial: true as const, truncated: projection.truncated, bytes: 0 }
        }
        if (!canonical) return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
        try {
          const page = await readTraceArchivePageAsync({ cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId, userDataDir: app.getPath('userData') }, { limit: 2 })
          if (!page.archive || page.archive.turns.length === 0) return { status: 'unavailable' as const, reason: 'session_not_found' as const }
          const source = page.readMode === 'indexed' ? 'indexed_archive' as const : page.readMode
          const turns = page.archive.turns.map((turn) => {
            const projection = previewTraceItems(turn.items)
            return { userText: turn.userText, userTextTruncated: false, items: projection.items, truncated: projection.truncated }
          })
          return { status: 'available' as const, source, turns, partial: true as const, truncated: page.hasOlder || turns.some((turn) => turn.truncated), bytes: 0 }
        } catch {
          return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
        }
      },
      // Read one session's REAL conversation content so the phone can OPEN it,
      // not just list it. Side-effect-free (no dock badge / cwd / baseline like
      // agent:loadSession): resolve+authorize the cwd to a device-visible project,
      // read the SAME trace archive (+ claude transcript) a local load uses, merge,
      // and flatten each turn to the device content shape. Unknown/unauthorized/
      // unreadable => empty (honest: no content, never a fabricated transcript).
      readHistory: async ({ providerId, cwd, externalSessionId }) => {
        if (!providerId || !externalSessionId) return []
        let canonical: string
        try { canonical = cwd ? resolveRemoteProjectDirectory(cwd) : '' } catch { return [] }
        const userDataDir = app.getPath('userData')
        const archived = await readTraceArchiveAsync({ cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId, userDataDir })
        let turns: ParsedTurn[] = []
        if (providerId === 'claude' && canonical) {
          const fp = resolveTranscriptPath({ cwd: canonical, sessionId: externalSessionId, userDataDir })
          if (fp) {
            try {
              if (isShuttingDown) throw new Error('transcript parser disposed')
              const parsed = await readCachedTranscript({ path: fp, runId: externalSessionId,
                contextKey: providerContextKey('claude', canonical) })
              turns = parsed.turns
            } catch { /* transcript unreadable; fall back to archive */ }
          }
        }
        const activeRun = runs.activeStates().find((run) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId))
        if (turns.length === 0 && !archived && !activeRun) return []
        const merged = mergeSessionTurns(turns, archived, { userDataDir })
        const history = merged.map((turn) => ({ userText: turn.userText, items: flattenTraceItems(turn.items) }))
        // Terminal turns are read from the durable archive above. While the Mac
        // is still executing, append the in-memory authoritative trace so the
        // phone can follow the same reasoning/tool/output progress in real time.
        if (activeRun) {
          const bounded = boundedLiveRun(activeRun)
          history.push({ userText: bounded.userText, items: flattenTraceItems(bounded.items) })
        }
        return history
      }
    })
    await remoteHostService.start()
    console.warn(`[scry] remote host subsystem started (${relay.createTransport ? 'relay transport configured' : 'dormant: no relay transport configured'})`)
  } catch (error) {
    console.warn('[scry] remote host subsystem failed to start:', error)
    try { await remoteHostService?.dispose() } catch (cleanupError) {
      console.warn('[scry] failed remote host cleanup:', cleanupError)
    }
    remoteHostService = null
  }
}

function requireRemoteHost(): RemoteHostService {
  if (!remoteHostService) throw new Error('远程访问未启用')
  return remoteHostService
}

// Trusted-LOCAL pairing surface. These are only ever driven by the Mac's own
// renderer (assertTrustedIpcEvent), never by a device; a device reaches only the
// prove/status transport path, never confirm/cancel/revoke.
handleTrusted('remote:status', (): RemoteStatus => remoteHostService ? remoteHostService.status() : { enabled: false })
handleTrusted('remote:desktop:status', () => remoteHostService?.desktopStatus() ?? { enabled: false })
handleTrusted('remote:desktop:invite', () => requireRemoteHost().beginDesktopPairing())
handleTrusted('remote:desktop:disable', () => requireRemoteHost().disableDesktop())
handleTrusted('remote:pairing:begin', () => requireRemoteHost().beginPairing())
handleTrusted('remote:pairing:confirm', (_event, pairingId: unknown, expectedPublicKeySHA256: unknown) => {
  if (typeof pairingId !== 'string' || typeof expectedPublicKeySHA256 !== 'string') throw new Error('无效的配对确认参数')
  return requireRemoteHost().confirmPairing(pairingId, expectedPublicKeySHA256)
})
handleTrusted('remote:pairing:cancel', (_event, pairingId: unknown) => {
  if (typeof pairingId !== 'string') throw new Error('无效的配对标识')
  return requireRemoteHost().cancelPairing(pairingId)
})
handleTrusted('remote:device:revoke', (_event, deviceId: unknown) => {
  if (typeof deviceId !== 'string') throw new Error('无效的设备标识')
  return requireRemoteHost().revokeDevice(deviceId)
})

let performanceResourceMonitor: PerformanceResourceMonitor | null = null

app.whenReady().then(async () => {
  if (!primaryInstance) return
  const startupPerf = new PerformanceTrace('app.startup', { platform: process.platform }, recordStartupPerformance)
  await startPerformanceRecording(app.getPath('userData'), app.getVersion(), app.isPackaged, useDevelopmentRenderer)
  startupPerf.mark('performance_recording_ready')
  // 双流事件日志按环境变量装配；未设置时 openProviderEventWriter() 返回 undefined。
  configureProviderEventLog(process.env, app.getPath('userData'))
  dockBadge.sync()
  void warmShellEnv()
  // SQLite 是 turn 分析事实的写入前置条件；在 renderer 可发送前完成初始化，
  // 避免快速完成的首轮落过 archive 却永久缺少 spans/usage/intervention。
  initDb()
  startupPerf.mark('database_ready')
  createWindow()
  performanceResourceMonitor = startPerformanceResourceMonitor({
    enabled: performanceRecordingEnabled(),
    intervalMs: 5_000,
    sink: recordResourcePerformance,
    getAppMetrics: () => app.getAppMetrics(),
    counters: () => {
      const trace = traceOutput.snapshot()
      return {
        traceBufferedEvents: trace.bufferedEvents,
        traceBufferedBytes: trace.bufferedBytes,
        traceInFlightBytes: trace.inFlightBytes,
        traceSkippedEvents: trace.skippedEvents,
        activeRuns: runs.activeStates().length,
        ...performanceRecordingHealth()
      }
    }
  })
  startupPerf.mark('window_created')
  void startRemoteHostIfEnabled()
  startupManagedRecovery = (async () => {
    // Let the first window render before touching historical recovery trees.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await replayDatabaseTurnOutbox()
    startupPerf.mark('recovery_outbox_replayed')
    cleanupAppStoreAtomicTemps(app.getPath('userData'))
    cleanupUsageAtomicTemps(app.getPath('userData'))
    cleanupManagedTurnTemps(app.getPath('userData'))
    cleanupTraceTurnProgressTemps(app.getPath('userData'))
    await cleanupTraceArchiveTemps(app.getPath('userData'))
    startupPerf.mark('recovery_temps_cleaned')
    try {
      await conversationStore().recoverAll(new Set(runs.unsettledStates().map((run) => run.runId)))
    } catch (error) {
      // Do not discard corrupt ownership. Every legacy write still checks the store
      // and rejects unreadable/conflicting ledgers or pending/unknown ownership.
      console.warn('[scry] conversation startup recovery failed:', error)
    }
    try {
      const traceProgress = await recoverTraceTurnProgress(app.getPath('userData'), {
        isLiveManagedRun: (runId) => runs.unsettledStates().some((run) => run.runId === runId)
      })
      if (traceProgress.pending > 0) console.warn('[scry] trace turn progress recovery pending:', traceProgress)
      for (const scope of await managedRecoveryScopes(app.getPath('userData'))) {
        const commitHookEnv = await resolveGrantedManagedCommitHookEnv(scope.cwd)
        const journals = await recoverManagedTraceTurns(app.getPath('userData'), { ...scope, commitHookEnv })
        if (journals.pending > 0) console.warn('[scry] managed turn recovery pending:', scope, journals)
        const progress = await recoverManagedTraceProgress(app.getPath('userData'), { ...scope, commitHookEnv })
        if (progress.pending > 0) console.warn('[scry] managed turn progress recovery pending:', scope, progress)
      }
    } catch (error) {
      console.warn('[scry] managed turn startup recovery failed:', error)
    }
    startupPerf.mark('recovery_trace_and_managed_turns')
    try {
      const recorderCli = packagedRecorderCliPath() ?? process.env.SCRY_CLI_PATH
      const redelivery = await redeliverGrantedCommitHooksAtStartup(app.getPath('userData'), {
        env: withoutCommitHookCapability(),
        extendCapabilityEnv: () => ({
          ...(recorderCli ? { SCRY_CLI_PATH: recorderCli } : {}),
          SCRY_RECORDER_MANAGED: '1'
        })
      })
      if (redelivery.errors.length > 0) {
        console.warn('[scry] recorder commit hook startup redelivery failed:', redelivery.errors)
      }
    } catch (error) {
      console.warn('[scry] recorder commit hook startup redelivery failed:', error)
    }
    startupPerf.mark('recovery_commit_hooks_complete')
    startupPerf.mark('recovery_complete')
    startupPerf.finish()
  })()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitCleanupStarted = false
let quitCleanupFinished = false
app.on('before-quit', (event) => {
  if (!primaryInstance || quitCleanupFinished) return
  event.preventDefault()
  if (quitCleanupStarted) return
  isShuttingDown = true
  quitCleanupStarted = true
  // Release the remote subsystem's durable leases; a restart re-acquires and
  // replays any recorded-but-undispatched intents.
  const remoteCleanup = Promise.all([remoteHostService?.dispose(), desktopRemoteClient?.dispose()]).then(() => undefined)
  terminalOutput.close()
  const terminalCleanup = terminalManager?.shutdown().catch((error) => {
    console.warn('[scry] terminal shutdown failed:', (error as Error)?.message)
  }) ?? Promise.resolve()
  runStopLifecycle.close()
  traceOutput.close()
  performanceResourceMonitor?.stop()
  performanceResourceMonitor = null
  sessionDiffBaselines.disposeAll()
  const controls = runs.unsettledControls()
  const runCleanup = settleRunsForShutdown(controls, {
    cancelQuestion: (runId) => userQuestionBroker.cancelRun(runId),
    mirror: (run, externalSessionId) => mirrorSessionTranscript(run.providerId, run.cwd, externalSessionId),
    disposeProviders: () => providerRegistry.dispose()
  })
  const cleanup = Promise.all([runCleanup, terminalCleanup, remoteCleanup, disposeTranscriptParser(), sourceControl.dispose()]).then(() => stopPerformanceRecording())
  void enforceShutdownDeadline(cleanup, controls, () => providerRegistry.dispose()).finally(() => {
    quitCleanupFinished = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
