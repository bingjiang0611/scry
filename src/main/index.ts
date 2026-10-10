import { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
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
import { parseTranscriptToTurns, type ParsedTurn } from './normalize'
import { parseTranscriptFileInWorker, TRANSCRIPT_WORKER_THRESHOLD_BYTES } from './transcript-parser'
import { classifyError } from './error-classify'
import { billingStateQuery, deleteSessionData, deleteTurnOutboxSessionRows, importBillingFixture, initDb, recordTurn, replayDatabaseTurnOutbox, resolveSessionRunIds, setBillingEnvProvider, statsQuery, syncBillingAdmin, turnOutboxSessionRunIds, usageAnalyticsWithCreditsQuery } from './db'
import { beginGitTurnDiff, cancelGitTurnDiff, cloneGitTurnDiffCapture, finishGitTurnDiff, gitNumstat, snapshotSessionNetDiff, type GitTurnDiffCapture } from './git'
import { RunDiffPreviewer, SessionDiffBaselineRegistry, WriteCompletionTracker, sessionLoadMatchesRun } from './session-diff'
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
import {
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
import { stopObservedBackgroundTask } from './background-task-control'
import type { BackgroundTaskStopResult } from '../shared/background-work'
import { isRendererPerformanceSample } from '../shared/performance'
import { isDiffPreviewStage, type ActiveRun, type TraceEvent, type TurnDiffBaselineOrigin, type TurnDiffReason, type TurnDiffSnapshot, type UsageAnalyticsRangeDays } from '../shared/trace'
import {
  normalizeAgentForkSessionRequest,
  normalizeAgentStartRequest,
  providerIdForAgentId,
  runTerminationHint,
  type AgentForceKillScope,
  type AgentForkSessionResult,
  type AgentPermissionMode,
  type AgentInputAttachment,
  type AgentStartRequest,
  type RuntimeProvider
} from '../shared/runtime'
import { capabilityUnavailable, type DeleteArchivedSessionsResult, type DeleteSessionResult, type ProviderContext, type ProviderId, type SessionProviderId } from '../shared/provider'
import { parseDisabledProviders, ProviderRegistry } from './providers/registry'
import type { AuthorizedMcpExecution } from './providers/types'
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
import { PerformanceTrace } from './performance-timing'
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
import { createRemoteRunBinding } from './remote/remote-run-binding'
import { ReverseTunnelTransport } from './remote/relay-client'
import { createRelayConnect } from './remote/relay-connect'
import { createRelayConnectWS } from './remote/relay-connect-ws'
import { ensureHostIdentity } from './remote/host-identity'
import { ensureRelayCredential } from './remote/relay-credential'
import { DEFAULT_PUBLIC_RELAY_WS, remoteHostEnabled } from './remote/remote-defaults'
import type { RemoteStatus } from '../shared/remote'
import { DockBadgeState } from './dock-badge'
import { sessionAttentionKey } from '../shared/session-attention'
import { archiveSessionId } from './session-id'
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
import { canonicalRemoteProjectRoots, listRemoteDirectories, resolveRemoteProjectDirectory as resolveRemoteDescendant } from './remote/remote-directory-browser'
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
import { ensureFailedTerminalResult, terminalOutcomeLabel } from './run-outcome'
import { enforceShutdownDeadline, settleRunsForShutdown } from './shutdown'
import {
  ContextAdmission,
  canRestartInterruptedLocalOnlySession,
  expectedRestartSourceMatches,
  expectedSessionMatches,
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
const mainEventId = (prefix: string, runId: string): string => `${prefix}-${runId}-${randomUUID()}`
let startupManagedRecovery: Promise<void> = Promise.resolve()
const primaryInstance = isOwnedTestApp || app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
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

// 会话级净 diff 的持久 baseline registry：每个 (provider,cwd) 上下文一份贯穿会话的 Git 快照。
// revision + 原生 session id 双重锚定，绝不串会话；找不到可复用基线时当场重锚并标 origin=resumed，
// 不再像旧实现那样在 resume/loadSession 之后彻底不落 session_diff。
const sessionDiffBaselines = new SessionDiffBaselineRegistry()
const discardSessionBaseline = (key: string): void => sessionDiffBaselines.discard(key)
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
  return mergeProjectMetas(store.load(), sessionProjects)
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
const smokeProviderEnabled = process.env.SCRY_ELECTRON_SMOKE_PROVIDER === '1' &&
  process.env.ELECTRON_ENABLE_LOGGING === '1' &&
  process.argv.some((arg) => arg.startsWith('--remote-debugging-port='))
const smokeDetectedAgents = [{ id: 'codex', name: 'Codex Smoke Fixture', bin: 'codex', path: process.execPath }]
const builtInProviderAdapters = smokeProviderEnabled ? [createSmokeProviderAdapter()] : createBuiltInProviderAdapters(
  homeDir,
  join(app.getPath('userData'), 'codex-home-v1'),
  join(app.getPath('userData'), 'provider-auth', 'opencode'),
  join(app.getPath('userData'), 'provider-state', 'opencode-v1'),
  { listProfiles: listPiProfiles, resolveProfile: resolvePiProfile }
)
const providerRegistry = new ProviderRegistry(
  builtInProviderAdapters,
  {
    disabledProviders: parseDisabledProviders(process.env.SCRY_DISABLED_PROVIDERS),
    runControlsEnabled: process.env.SCRY_RUN_CONTROLS?.trim() !== '0'
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
  discardSessionBaseline(key)
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
      sandbox: true
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
  createdWindow.webContents.on('render-process-gone', () => {
    terminalOutput.detachRenderer()
    traceOutput.reset()
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
    if (windowShown || !win || win.isDestroyed()) return
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

handleTrusted('app:performanceDiagnosticsEnabled', () => process.env.SCRY_PERF_LOG === '1')
handleTrusted('app:reportRendererPerformance', (_event, sample: unknown) => {
  if (!isRendererPerformanceSample(sample)) throw new Error('无效的 renderer 性能样本')
  if (process.env.SCRY_PERF_LOG !== '1') return false
  console.info(`[scry:renderer-perf] ${JSON.stringify({
    name: 'renderer.resources',
    sampledAt: new Date().toISOString(),
    ...sample
  })}`)
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
    })
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

handleTrusted('workspace:list', (_event, request: WorkspaceListRequest) =>
  listWorkspace(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:read', (_event, request: WorkspacePathRequest) =>
  readWorkspaceFile(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:readPage', (_event, request: WorkspaceFilePageRequest) =>
  readWorkspaceFilePage(authorizedWorkspaceRequest(currentCwd, request)))
handleTrusted('workspace:readKnown', async (_event, request: WorkspacePathRequest) =>
  readWorkspaceFile(request.cwd === '~'
    ? await homeFileAccess.authorize(request)
    : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }))
handleTrusted('workspace:readPageKnown', async (_event, request: WorkspaceFilePageRequest) =>
  readWorkspaceFilePage(request.cwd === '~'
    ? await homeFileAccess.authorize(request)
    : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }))
handleTrusted('workspace:openExternal', (_event, request: WorkspacePathRequest) =>
  openWorkspaceFileExternally(
    authorizedWorkspaceRequest(currentCwd, request),
    (path) => shell.openExternal(pathToFileURL(path).href),
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
    request.cwd === '~'
      ? await homeFileAccess.authorize(request)
      : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) },
    (path) => shell.openExternal(pathToFileURL(path).href)
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
  if (fp) {
    try {
      const transcriptStat = await stat(fp)
      if (transcriptStat.size >= TRANSCRIPT_WORKER_THRESHOLD_BYTES) {
        const parsed = await parseTranscriptFileInWorker({
          path: fp,
          runId: payload.externalSessionId,
          signal
        })
        turns = parsed.turns
        transcriptBytes = parsed.bytes
      } else {
        const content = await readFile(fp, { encoding: 'utf8', signal })
        transcriptBytes = Buffer.byteLength(content)
        turns = parseTranscriptToTurns(content, {
          runId: payload.externalSessionId,
          newId: () => mainEventId('history', payload.externalSessionId!),
          now: () => new Date().toISOString()
        })
      }
    } catch (error) {
      signal.throwIfAborted()
      if (!archived) throw error
    }
  }
  for (const turn of turns) {
    turn.items = await persistTraceToolEvents(userDataDir, cwd, turn.items)
    signal.throwIfAborted()
  }
  perf.mark('transcript', { transcriptTurns: turns.length, transcriptBytes })
  // Cancellation is not evidence of an empty session. Reject it so the renderer
  // cannot replace an existing timeline with an empty successful response.
  signal.throwIfAborted()
  if (!fp && !archived) {
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
  // 真正切换到另一条历史会话时才递增 revision 并废弃旧 baseline。
  const loadingUnsettledRun = runs.unsettledStates().some((run) => sessionLoadMatchesRun(run, {
    providerId: payload.providerId,
    agentProfileId: payload.agentProfileId,
    cwd,
    externalSessionId: payload.externalSessionId
  }))
  if (!loadingUnsettledRun) {
    bumpSessionRevision(key)
    discardSessionBaseline(key)
    sessionAliasesByContext.delete(key)
  }
  if (appSessionCanResume(catalogSession)) sessionByContext.set(key, payload.externalSessionId)
  else sessionByContext.delete(key)
  if (cwd) rememberProject(cwd)
  const historyContext = { userDataDir }
  const merged = await providerRegistry.enrichSession(
    { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
    mergeSessionTurns(turns, archived, historyContext, { hydrateAttachments: false })
  )
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
    ...(archivePaged ? {
      archiveSource: archiveArgs,
      archiveSnapshotTotalTurns: archivePage?.totalTurns ?? 0
    } : {}),
    hookConfig
  }
  const unhydratedPage: SessionHistoryPage = archivePage
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
})

// 更早轮次的纯读取：不重做任何会话切换副作用（cwd / baseline / dock badge / resume）。
// revision 或 session 身份不匹配时返回 null：renderer 将它当作过期请求丢弃，而不是拼上错会话的轮次。
handleTrusted('agent:loadSessionOlder', async (_e, payload: ProviderContext, request: SessionHistoryPageRequest) => {
  if (!payload.externalSessionId) return null
  const perf = new PerformanceTrace('session_history.load_older', { provider: payload.providerId })
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
})

type SessionDeletionRequest = Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }

// 删除一个历史会话。工作区 .scry/ 是独立 canonical evidence，明确保留。
// confirm / notifyFailure 由调用方决定：单条删除各弹一次系统弹窗，批量删除只在批次首尾各弹一次。
async function deleteOneSession(
  p: SessionDeletionRequest,
  options: { confirm: boolean; notifyFailure: boolean }
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
    const hasActiveSession = (): boolean => runs.unsettledStates().some((run) => {
      const sessionId = run.externalSessionId ?? run.sessionId
      return run.providerId === providerId && run.agentProfileId === agentProfileId && (run.cwd ?? '') === cwd &&
        (run.runId === externalSessionId || sessionId === externalSessionId)
    })
    const reserved = await contextAdmission.run(admissionKey, async () => {
      await startupManagedRecovery
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
      if (sessionByContext.get(key) === externalSessionId) {
        sessionByContext.delete(key)
        discardSessionBaseline(key)
      }
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

// 名称、置顶与存档只改 catalog，不动 Provider transcript 或 turn/usage/trace 数据。
handleTrusted('agent:renameSession', (_e, p: unknown, title: unknown) => {
  const ref = sessionRefFromRequest(p)
  if (!ref || typeof (p as AppSessionRef).cwd !== 'string') throw new Error('无效的会话重命名请求')
  return appSessionStore().rename(ref, title)
})

handleTrusted('agent:setSessionPinned', (_e, p: unknown, pinned: unknown) => {
  const ref = sessionRefFromRequest(p)
  if (!ref || typeof pinned !== 'boolean') throw new Error('无效的置顶请求')
  return appSessionStore().setPinned(ref, pinned)
})

handleTrusted('agent:setSessionArchived', (_e, p: unknown, archived: unknown) => {
  const ref = sessionRefFromRequest(p)
  if (!ref || typeof archived !== 'boolean') throw new Error('无效的存档请求')
  return appSessionStore().setArchived(ref, archived)
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
  /**
   * 硬杀当下的真实作用范围，直接来自 Provider handle。handle 还没创建时返回 undefined：
   * 没有可调用对象就不能声称已经发出 run-scoped 强制终止。
   */
  forceKillScope: () => AgentForceKillScope | undefined
  cwd?: string
  resume?: string
  getExternalSessionId: () => string | undefined
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
const userQuestionBroker = new UserQuestionBroker((change: UserQuestionChange) => {
  if (change.kind === 'open') {
    const run = runs.get(change.request.runId)?.state
    if (run) {
      run.pendingQuestions = [
        ...(run.pendingQuestions ?? []).filter((item) => item.questionId !== change.request.questionId),
        change.request
      ]
      const sessionKey = activeRunSessionKey(run)
      if (sessionKey) dockBadge.markAttention(sessionKey, {
        windowFocused: Boolean(win?.isFocused()),
        sessionViewed: runs.isViewed(run.runId),
        needsAttention: true
      })
    }
    win?.webContents.send('agent:questionAttention', {
      runId: change.request.runId,
      pendingCount: run?.pendingQuestions?.length ?? 1
    })
    if (runs.isFocused(change.request.runId)) win?.webContents.send('agent:userQuestion', change.request)
    return
  }
  const run = runs.get(change.runId)?.state
  if (run) {
    run.pendingQuestions = (run.pendingQuestions ?? []).filter((item) => item.questionId !== change.questionId)
    const event: TraceEvent = {
      id: mainEventId('intervention', change.runId),
      ts: change.intervention.closedAt,
      runId: change.runId,
      kind: 'human',
      stage: 'intervention',
      toolUseId: change.questionId,
      providerId: change.intervention.request.providerId,
      agentId: change.intervention.request.agentId,
      durationMs: change.intervention.durationMs,
      intervention: change.intervention
    }
    appendCoalescedTrace(run.items, event)
    if (runs.isFocused(change.runId)) queueTrace(event)
  }
  win?.webContents.send('agent:questionAttention', {
    runId: change.runId,
    pendingCount: run?.pendingQuestions?.length ?? 0
  })
  if (runs.isFocused(change.runId)) win?.webContents.send('agent:userQuestionClosed', change)
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

handleTrusted('agent:start', async (_e, payload: AgentStartRequest) => {
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
  const cwd = request.cwd ? resolveKnownProjectDirectory(request.cwd) : currentCwd
  if (request.cwd && currentCwd && cwd !== canonicalExistingDirectory(currentCwd)) {
    throw new AgentRuntimeError('发送请求的工作目录与当前授权目录不一致', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '重新选择目标项目后再发送'
    })
  }
  const catalogCwd = cwd ?? ''
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
  const startLease = providerOperationGate.acquireOperation(lifecycleKey)
  if (!startLease.ok) {
    throw new AgentRuntimeError('当前 Provider 正在认证 MCP，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待浏览器认证完成或超时后再发送'
    })
  }
  const admissionKey = providerContextKey(providerId, cwd ?? '', agentProfileId)
  try {
    return await contextAdmission.run(admissionKey, async () => {
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
    const expectedSessionId = request.expectedExternalSessionId
    // expectedExternalSessionId=null 是 renderer 对“必须新建会话”的显式要求。
    // 即使较早的 agent:newSession IPC 仍在路上，这里也先原子清空 main 的旧上下文，
    // 再捕获 revision/resume，避免把新提示词误判为要投递到旧会话。
    if (expectedSessionId === null && !request.forkLastTurn && !request.restartLastTurn) {
      resetSessionContext(contextKey)
    }
    let contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
    let resume = sessionByContext.get(contextKey)
    const forkSourceSessionId = request.forkLastTurn ? resume : undefined
    const restartSourceSessionId = request.restartLastTurn && typeof expectedSessionId === 'string'
      ? expectedSessionId
      : undefined
    const editSourceSessionId = forkSourceSessionId ?? restartSourceSessionId
    const contextRuns = runs.unsettledStates().filter((run) =>
      run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
    )
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
    if (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
      !expectedSessionMatches(expectedSessionId, resume, [...contextRuns, ...catalogAliases()])) {
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
    const conflictingRuns = contextRuns.filter((run) => {
      const sessionId = run.externalSessionId ?? run.sessionId
      return resume ? sessionId === resume : !sessionId
    })
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
    resume = sessionByContext.get(contextKey)
    const latestContextRuns = runs.unsettledStates().filter((run) =>
      run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
    )
    if (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
      !expectedSessionMatches(expectedSessionId, resume, [...contextRuns, ...latestContextRuns, ...catalogAliases()])) {
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
    if (latestContextRuns.some((run) => {
      const sessionId = run.externalSessionId ?? run.sessionId
      return resume ? sessionId === resume : !sessionId
    })) {
      throw new AgentRuntimeError('会话切换后目标会话仍有一轮正在收口', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '等待目标会话完成后重试；草稿已保留'
      })
    }
  const traceProgressRecovery = cwd
    ? await recoverTraceTurnProgress(app.getPath('userData'), {
        cwd,
        providerId,
        ...(resume ? { sessionId: resume } : {})
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
      commitHookEnv: managedCommitHookEnv
    })
    const progressRecovery = await recoverManagedTraceProgress(app.getPath('userData'), {
      cwd,
      providerId,
      ...(resume ? { sessionId: resume } : {}),
      waitMs: 250,
      commitHookEnv: managedCommitHookEnv
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
      isLiveManagedRun: (candidate: string | undefined): boolean =>
        !!candidate && runs.unsettledStates().some((run) => run.runId === candidate)
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
  const committedResume = sessionByContext.get(contextKey)
  const committedRevision = sessionRevisionByContext.get(contextKey) ?? 0
  const committedRuns = runs.unsettledStates().filter((run) =>
    run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
  )
  const committedExpectedSessionId = request.forkLastTurn || request.restartLastTurn ? resume ?? null : expectedSessionId
  if (
    committedResume !== resume || committedRevision !== contextRevision ||
    !expectedSessionMatches(committedExpectedSessionId, committedResume, [...committedRuns, ...catalogAliases()])
  ) throw contextChangedError()
  if (cwd && committedResume && deletingSessions.has(scopedSessionKey(committedResume))) {
    throw new AgentRuntimeError('这个会话正在删除，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待删除完成后新建会话或重新选择历史会话'
    })
  }
  if (committedRuns.some((run) => {
    const sessionId = run.externalSessionId ?? run.sessionId
    return committedResume ? sessionId === committedResume : !sessionId
  })) {
    throw new AgentRuntimeError('同一会话在发送前进入运行态，已拒绝重复启动', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待当前轮完成；草稿已保留'
    })
  }
  const runId = `run-${Date.now().toString(36)}-${runSeq++}`
  const finishTurnWallTiming = createTurnWallTimer(runId)
  const llmPerformance = new LlmPerformanceObserver(request.networkLabel)
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
  const displayPrompt = request.prompt
  let runtimePrompt = displayPrompt
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
    appSessionStore().remove({ providerId, agentProfileId, cwd: catalogCwd, externalSessionId: runId })
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
      ? { ...decorated, llmPerformance: llmPerformance.observe(decorated, runState.items) }
      : decorated
    turnChangeJournal?.record(ev)
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
  }
  let performanceRecorded = false
  const persistLlmPerformance = (failed: boolean, externalSessionId: string): void => {
    if (performanceRecorded) return
    performanceRecorded = true
    const performance = [...runState.items].reverse().find(event => event.stage === 'runtime:turn_wall')?.llmPerformance
    const result = [...runState.items].reverse().find(event => event.kind === 'harness' && event.stage === 'result')
    if (!performance) return
    const model = result?.modelUsage?.length === 1 ? result.modelUsage[0].model
      : result?.modelUsage?.length ? '多模型'
        : result?.contextModel ?? (request.model ? `所选：${request.model.id}` : '未知模型')
    try {
      appendLlmPerformance(app.getPath('userData'), { cwd: catalogCwd, externalSessionId }, {
        runId, ts: performance.observedAt, providerId, agentProfileId,
        model,
        upstreamProvider: result?.modelUsage?.length === 1 ? result.modelUsage[0].upstreamProvider : result?.upstreamProvider,
        networkLabel: request.networkLabel ?? '', failed: failed || result?.isError === true,
        performance
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
      permissionMode: request.permissionMode
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
    runtimePrompt = providerAttachmentPrompt(providerId, displayPrompt, attachments)
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
  if (cwd && contextKey) {
    const baseline = sessionDiffBaselines.ensure({
      key: contextKey,
      revision: contextRevision,
      cwd,
      ...(resume ? { sessionId: resume } : {}),
      initialCapture: initialDiffCapture
    })
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
  let turnDiffPromise: Promise<void> | null = null
  const finalizeTurnDiff = (): Promise<void> => {
    // 终态第一次进入收口就把所有 scope 封口，再等全局 idle：idle 等的是全部在途预览链，
    // 只封 turn 的话 session 链还能继续续 trailing，收口要么白等，要么让迟到的预览
    // 落到终态之后。封口后算完的预览一律丢弃——终态覆盖预览，不倒退。
    diffPreviewer.sealAll()
    turnDiffPromise ??= diffPreviewer.idle()
      .then(() => turnDiffCapture)
      .then((capture) => finishGitTurnDiff(capture, undefined, {
        ...turnChangeJournal?.snapshot(),
        patchExcludeBasenames
      }))
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
      const entry = sessionDiffBaselines.get(contextKey, contextRevision, observedSessionId ?? resume)
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
        snapshot = await snapshotSessionNetDiff(baseline, undefined, { patchExcludeBasenames })
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
    if ((sessionRevisionByContext.get(contextKey) ?? 0) === contextRevision) {
      sessionByContext.set(contextKey, sessionId)
      sessionAliasesByContext.set(contextKey, new Map([[runId, sessionId]]))
      // 首轮建基线时还拿不到原生 session id；现在补上，之后别的会话认不走这份基线。
      sessionDiffBaselines.bind(contextKey, contextRevision, sessionId)
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
  let h: {
    promise: Promise<{
      externalSessionId?: string
      providerTurnId?: string
      forkTurnId?: string
      stopped?: boolean
      status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
      recordingFailure?: { message: string }
    }>
    interrupt: () => void
    forceKill: () => void
    forceKillScope: AgentForceKillScope
    stopBackgroundTask?: (taskId: string) => Promise<BackgroundTaskStopResult>
    getExternalSessionId: () => string | undefined
    getProviderTurnId?: () => string | undefined
    getForkTurnId?: () => string | undefined
    getRecordingFailure?: () => { message: string } | undefined
  } | null = null
  let interrupted = false
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
    const mcpExecution = authorizedMcpExecution(mcpExecutionSnapshot)
    h = providerRegistry.run(providerId, {
      runId,
      prompt: runtimePrompt,
      cwd,
      agentProfileId,
      resume,
      attachments,
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode,
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
      emit: (event) => {
        firstTracePerf.finish({ bufferedEvents: runState.items.length })
        if (event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta') &&
          typeof event.text === 'string' && event.text.length > 0) {
          // This is the first provider text event, not a renderer paint or a UI display time.
          firstTextPerf.finish({ bufferedEvents: runState.items.length })
        }
        emit(event)
      },
      onExternalSessionId: publishSessionId,
      requestUserInput: (question, signal) => userQuestionBroker.request({ ...question, providerId }, signal)
    })
    if (interrupted) h.interrupt()
    let result: Awaited<typeof h.promise>
    try {
      result = await h.promise
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
    interrupt: () => {
      interrupted = true
      h?.interrupt()
    },
    forceKill: () => {
      interrupted = true
      h?.forceKill()
    },
    forceKillScope: () => h?.forceKillScope,
    stopBackgroundTask: (taskId) => h?.stopBackgroundTask?.(taskId) ?? Promise.resolve({ status: 'unavailable', message: '当前 Provider 不支持单任务停止。' }),
    cwd,
    resume,
    getExternalSessionId: () => h?.getExternalSessionId(),
    canonicalLifecycle,
    runtimeProvider,
    runState,
    adoptSession: () => {
      if (!contextKey) return
      bumpSessionRevision(contextKey)
      contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
      // 基线仍描述同一份工作树，跟着新 revision/session id 走，不重锚。
      sessionDiffBaselines.rebind(contextKey, contextRevision, observedSessionId)
      if (observedSessionId) sessionByContext.set(contextKey, observedSessionId)
      else sessionByContext.delete(contextKey)
    },
    cleanupProvisional,
    finalizeTurnDiff,
    cancelTurnDiff,
    settled
  }
  try {
    runs.register(runState, control)
  } catch (error) {
    try { cleanupProvisional() } catch { /* preserve the original registration error */ }
    deleteRunAttachments(app.getPath('userData'), runId)
    try { await cancelGitTurnDiff(await turnDiffCapture) } catch { /* preserve the original registration error */ }
    throw error
  }
  startPerf.mark('run_registered')
  firstTextPerf.mark('run_registered')
  dockBadge.view(scopedSessionKey(resume ?? runId), Boolean(win?.isFocused()))
  // `agent:start` can also be invoked through the preload bridge (for example by
  // the regression runner), so publish the authoritative focused snapshot after
  // registration and before the Provider can emit trace or questions.
  try {
    win?.webContents.send('agent:focusedRun', boundedLiveRun(runState))
  } catch (error) {
    console.warn('[scry] focused run renderer notification failed:', runId, error)
  }
  let terminalArchiveArgs: ArchiveTraceTurnArgs | undefined
  let terminalArchiveCommitted = false
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
      persistLlmPerformance(completionStatus !== 'completed', storageSessionId)
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
        terminalPerf.finish({ events: runState.items.length, committed: 0 })
        return
      }
      terminalArchiveArgs = completionArchiveArgs
      try {
        // Provider 已完成时先落一份 durable canonical snapshot。若 App 在等待 Git diff
        // 期间崩溃，下一次启动仍能用同一用户输入、模型输出、调用与权威 result timing
        // 恢复 archive/CLI；diff 会明确记为 unavailable，而不是伪造零值。
        await persistTerminalProgress(completionArchiveArgs)
      } catch (error) {
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
      } catch (error) {
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
        terminalPerf.finish({ events: runState.items.length, committed: 0 })
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
    }, async (err) => {
      emit(finishTurnWallTiming())
      const turnDiffDone = finalizeTurnDiff()
      const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
      const alreadyDone = runState.done
      const stopped = interrupted
      let nativeSessionId = observedSessionId ?? resume
      try {
        nativeSessionId = h?.getExternalSessionId() ?? nativeSessionId
      } catch (error) {
        console.warn('[scry] Provider session getter failed at terminal boundary:', runId, error)
      }
      const storageSessionId = nativeSessionId ?? runId
      persistLlmPerformance(true, storageSessionId)
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
          prompt: displayPrompt
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
        return
      }
      try {
        await persistTerminalProgress(terminalArchiveArgs)
      } catch (progressError) {
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
      } catch (archiveError) {
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
      markTerminalAttention(
        terminalArchiveArgs?.sessionId ?? observedSessionId ?? resume ?? runId,
        !interrupted
      )
    })
    .finally(() => {
      runState.providerSettled = true
      // settle 是唯一的终止证据来源；它同时取消所有未触发的升级定时器。
      runStopLifecycle.settle(runId)
      userQuestionBroker.cancelRun(runId)
      runs.remove(runId)
      resolveSettled?.()
    })
      startPerf.finish({ attachments: attachments.length })
      return { runId }
    })
  } finally {
    startLease.release()
  }
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
  return userQuestionBroker.answer(response)
})

// B2：sqlite 跨会话分析（工具频率 / 按目录花费），纯文件做不到的结构化查询
handleTrusted('agent:stats', () => statsQuery())
handleTrusted('agent:llmPerformanceHistory', () => readLlmPerformanceHistory(app.getPath('userData')))

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
handleTrusted('agent:gitDiff', (_e, cwd: string) => gitNumstat(cwd))
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

handleTrusted('agent:stop', (_event, runId: string) => {
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
})

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
// Explicit relay wiring remains available for private deployments. Without an
// override, packaged builds use the official public WSS relay with a generated
// per-host room credential; no app-wide bearer is embedded in the artifact.
type RemoteRelayResolution = Pick<RemoteHostServiceDependencies, 'createTransport' | 'relayAdvertisement'>
function createRemoteWssResolution(endpoint: URL, token: string, enroll: boolean): RemoteRelayResolution {
  const url = endpoint.origin
  const createTransport: RemoteHostServiceDependencies['createTransport'] = (ctx) => {
    const { connect, readyEvent } = createRelayConnectWS({ url, hostId: ctx.hostId, token, enroll, mode: ctx.mode })
    return new ReverseTunnelTransport({ connect, readyEvent })
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
let remoteProviderSnapshot: {
  id: string
  label: string
  available: boolean
  agentProfileId?: string
  modelId?: string
  models?: { id: string; providerId?: string; label: string; description?: string; isDefault?: boolean; efforts?: { id: string; label: string; description?: string; isDefault?: boolean }[] }[]
  efforts?: { id: string; label: string; description?: string; isDefault?: boolean }[]
  permissions?: { id: string; label: string; description?: string; isDefault?: boolean }[]
}[] = []
// providerId -> runtimeProvider, so a device-initiated run can be written into
// the Mac session catalog with the correct runtime (recordSession below).
let remoteProviderRuntime = new Map<string, RuntimeProvider>()
let remoteProviderRefresh: ReturnType<typeof setInterval> | undefined

function configuredRemotePermissionMode(): AgentPermissionMode | undefined {
  const raw = process.env.SCRY_REMOTE_PERMISSION_MODE
  return raw === 'full_access' || raw === 'auto_review' || raw === 'default' ? raw : undefined
}

async function loadRemoteProviderSnapshot(): Promise<void> {
  try {
    const descriptors = await providerRegistry.describe()
    const contexts = await Promise.all(descriptors.map(async (descriptor) => {
      if (!descriptor.available) return [{ id: descriptor.id, label: descriptor.label, available: false }]
      const profiles = descriptor.id === 'pi' ? await listPiProfiles() : []
      const targets = profiles.length > 0 ? profiles.map((profile) => ({ id: profile.id, label: profile.label })) : [undefined]
      return Promise.all(targets.map(async (profile) => {
        const controlsCwd = remoteProjectRoots()[0]
        const controls = await providerRegistry.runControls({
          providerId: descriptor.id,
          ...(controlsCwd ? { cwd: controlsCwd } : {}),
          ...(profile ? { agentProfileId: profile.id } : {})
        })
        const models = controls.data?.models.map((option) => ({
          id: option.model.id,
          ...(option.model.providerId ? { providerId: option.model.providerId } : {}),
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          ...(option.isDefault ? { isDefault: true } : {}),
          ...(option.efforts.length ? { efforts: option.efforts } : {})
        })) ?? []
        const model = controls.data?.models.find((option) => option.isDefault) ?? controls.data?.models[0]
        const remotePermissionMode = configuredRemotePermissionMode()
        const advertisedPermissions = remotePermissionMode
          ? controls.data?.permissions.filter((option) => option.id === remotePermissionMode)
          : controls.data?.permissions
        return {
          id: descriptor.id,
          label: profile ? `${descriptor.label} · ${profile.label}` : descriptor.label,
          available: true,
          ...(profile ? { agentProfileId: profile.id } : {}),
          ...(model?.model.id ? { modelId: model.model.id } : {}),
          ...(models.length ? { models } : {}),
          ...(model?.efforts.length ? { efforts: model.efforts } : {}),
          ...(controls.data?.permissions.length || remotePermissionMode ? {
            // An owner-set override is authoritative. Advertise only the mode
            // that will really execute so the phone renders it as locked rather
            // than offering choices that the Mac would silently ignore.
            permissions: (advertisedPermissions?.length ? advertisedPermissions : [{
              id: remotePermissionMode ?? 'default',
              label: remotePermissionMode === 'full_access' ? '完全访问' : remotePermissionMode === 'auto_review' ? '自动审查' : '默认审批'
            }]).map((option) => ({
              ...option,
              ...(remotePermissionMode ? { isDefault: true } : option.id === 'default' ? { isDefault: true } : {})
            }))
          } : {})
        }
      }))
    }))
    remoteProviderSnapshot = contexts.flat()
    remoteProviderRuntime = new Map(descriptors.map((d) => [d.id, d.runtimeProvider]))
  } catch { /* keep the last good snapshot rather than fabricate */ }
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
      // Fail closed: a device may only target a directory already authorized
      // through Scry's own project picker.
      authorizeWorkspace: (cwd) => resolveRemoteProjectDirectory(cwd),
      gate: providerOperationGate,
      createTransport: relay.createTransport,
      relayAdvertisement: relay.relayAdvertisement,
      // LIVE run seam: a routed device intent becomes a REAL Provider run via the
      // same registry the local UI uses. Workspace authorization + provider gate
      // are already enforced upstream (RemoteRunPolicy/GatedExecutor) before this
      // runs; interactive approval is not yet wired and fails closed. Mac-side
      // RunRegistry/UI visibility, attachments, hooks and managed recorder remain
      // the interactive path's concern (see remote-run-binding.ts).
      // routing.providerId is a validated non-empty string; the registry itself
      // rejects an unknown provider, so the ProviderId narrowing is safe here.
      // onRunStarted/onRunSession make the device-initiated run VISIBLE in the
      // owner's Mac session catalog (the user's expectation: see the conversation
      // on the Mac). We record a pending AppSession at start and bind the
      // Provider's REAL externalSessionId when reported, so the owner can open and
      // resume the exact conversation on their Mac. Best-effort: a catalog write
      // never fails the run, and only real ids are recorded (nothing fabricated).
      startRun: createRemoteRunBinding({
        run: (providerId, request) => providerRegistry.run(providerId as ProviderId, remotePermissionMode ? { ...request, permissionMode: remotePermissionMode } : request),
        onRunStarted: ({ providerId, cwd, prompt, scryRunId, agentProfileId }) => {
          const runtimeProvider = remoteProviderRuntime.get(providerId)
          if (!runtimeProvider) return
          try {
            appSessionStore().recordPending({ providerId: providerId as ProviderId, agentProfileId, runtimeProvider, runId: scryRunId, cwd, prompt })
            win?.webContents.send('remote:sessionRecorded', { cwd })
          } catch { /* catalog visibility is best-effort */ }
        },
        onRunSession: ({ providerId, cwd, prompt, scryRunId, externalSessionId, agentProfileId }) => {
          const runtimeProvider = remoteProviderRuntime.get(providerId)
          if (!runtimeProvider) return
          try {
            appSessionStore().record({ providerId: providerId as ProviderId, agentProfileId, runtimeProvider, runId: scryRunId, externalSessionId, cwd, prompt })
            win?.webContents.send('remote:sessionRecorded', { cwd })
          } catch { /* catalog visibility is best-effort */ }
        },
        // Persist the run as a REAL Scry trace archive (same path a local,
        // non-managed run uses) so the owner can OPEN the transcript on the Mac,
        // not just see it listed. Managed recorder stays OFF for remote runs.
        onRunArchive: ({ providerId, cwd, prompt, scryRunId, externalSessionId, attachments, items, status }) => {
          const runtimeProvider = remoteProviderRuntime.get(providerId)
          if (!runtimeProvider) return
          void archiveTraceTurn({
            providerId: providerId as ProviderId,
            runtimeProvider,
            cwd,
            sessionId: externalSessionId,
            runId: scryRunId,
            userText: prompt,
            attachments,
            items,
            done: true,
            status,
            managedRecorderEnabled: false
          })
            .then(() => { win?.webContents.send('remote:sessionRecorded', { cwd }) })
            .catch((error) => console.warn('[scry] remote trace archive write failed:', error))
        }
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
      // The Providers the device may pick for a new session. Snapshot mirrors the
      // real registry describe() (id/label/available); the run path re-validates.
      listProviders: () => remoteProviderSnapshot,
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
      // The host session catalog the device may browse, so the phone shows the
      // SAME conversations the Mac lists. Filtered to device-visible authorized
      // projects (a session whose cwd is not an authorized project dir is not
      // offered), non-archived, most-recent-first. Display metadata only; opening
      // a session's content is re-authorized separately.
      listSessions: () => {
        const activeRuns = runs.activeStates()
        const out: { sessionId: string; externalSessionId?: string; providerId: string; agentProfileId?: string; cwd: string; label: string; ts: number; pinnedAt?: number; isActive?: boolean }[] = []
        for (const s of appSessionStore().load()) {
          if (s.archivedAt) continue
          if (!s.cwd) continue
          let canonical: string
          try { canonical = resolveRemoteProjectDirectory(s.cwd) } catch { continue }
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
            ...(isActive ? { isActive: true } : {})
          })
        }
        out.sort((a, b) => b.ts - a.ts)
        return out
      },
      readSessionStatus: (query) => observeSessionStatus(query, runs.activeStates()),
      // First-screen evidence avoids the complete-history reader. Indexed
      // archives read only two turns; legacy/index-rebuild paths can still
      // materialize older data, and their provenance stays explicit.
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
              const content = await readFile(fp, 'utf8')
              turns = parseTranscriptToTurns(content, { runId: externalSessionId, newId: () => mainEventId('history', externalSessionId), now: () => new Date().toISOString() })
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

app.whenReady().then(() => {
  if (!primaryInstance) return
  const startupPerf = new PerformanceTrace('app.startup', { platform: process.platform })
  void warmShellEnv()
  // SQLite 是 turn 分析事实的写入前置条件；在 renderer 可发送前完成初始化，
  // 避免快速完成的首轮落过 archive 却永久缺少 spans/usage/intervention。
  initDb()
  startupPerf.mark('database_ready')
  createWindow()
  performanceResourceMonitor = startPerformanceResourceMonitor({
    getAppMetrics: () => app.getAppMetrics(),
    counters: () => {
      const trace = traceOutput.snapshot()
      return {
        traceBufferedEvents: trace.bufferedEvents,
        traceBufferedBytes: trace.bufferedBytes,
        traceInFlightBytes: trace.inFlightBytes,
        traceSkippedEvents: trace.skippedEvents,
        activeRuns: runs.activeStates().length
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
      const traceProgress = await recoverTraceTurnProgress(app.getPath('userData'))
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
  void remoteHostService?.dispose()
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
  const cleanup = Promise.all([runCleanup, terminalCleanup]).then(() => undefined)
  void enforceShutdownDeadline(cleanup, controls, () => providerRegistry.dispose()).finally(() => {
    quitCleanupFinished = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
