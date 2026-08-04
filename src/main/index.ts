import { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, shell, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { getClaudeVersion } from './agent-runner'
import { detectAgents, detectAgentsFast, shellEnv, warmShellEnv } from './claude-locate'
import { AgentRuntimeError } from './cli-runtime'
import { parseTranscriptToTurns, type ParsedTurn } from './normalize'
import { classifyError } from './error-classify'
import { billingStateQuery, deleteSessionData, importBillingFixture, initDb, recordTurn, resolveSessionRunIds, setBillingEnvProvider, statsQuery, syncBillingAdmin } from './db'
import { beginGitTurnDiff, cancelGitTurnDiff, finishGitTurnDiff, gitNumstat, type GitTurnDiffCapture } from './git'
import {
  deleteTranscriptCopies,
  cleanupTraceArchiveTemps,
  inferLegacyTraceArchiveProvider,
  mirrorTranscript,
  readTraceArchive,
  resolveTranscriptPath,
  traceArchiveRunIds,
  upsertTraceArchiveTurn,
  type TraceArchiveTurn
} from './transcript-archive'
import { mergeSessionTurns } from './session-history'
import { appSessionCanResume, cleanupAppStoreAtomicTemps, createAppSessionStore, createRecentFoldersStore } from './app-store'
import { scanMcp } from '../cli/mcpguard-core'
import { isMcpGuardReport } from '../shared/mcpguard-report'
import { appendUsage, cleanupUsageAtomicTemps, deleteUsageSessionRows, readUsageStats, usageSessionRunIds } from './usage-jsonl'
import { migrateLegacyUserData } from './user-data-migration'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import {
  normalizeAgentStartRequest,
  type AgentInputAttachment,
  type AgentStartRequest,
  type RuntimeProvider
} from '../shared/runtime'
import { capabilityUnavailable, type DeleteSessionResult, type ProviderContext, type ProviderId, type SessionProviderId } from '../shared/provider'
import { parseDisabledProviders, ProviderRegistry } from './providers/registry'
import type { AuthorizedMcpExecution } from './providers/types'
import { createBuiltInProviderAdapters } from './providers'
import { appendCoalescedTrace } from './live-trace'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import {
  isManagedRecorderProvider,
  managedRecorderMode,
  recoverManagedRecorderTurns,
  type ManagedTurnTiming
} from '../core/turn-recorder/managed'
import { TurnChangeJournal } from '../core/turn-recorder/change-journal'
import { attachConfiguredHookCommands, loadClaudeHookConfig, loadCodexHookConfig } from './hook-config'
import { UserQuestionBroker, type UserQuestionChange } from './user-question'
import { RunRegistry } from './run-registry'
import {
  codexHookFingerprint,
  createCodexHookGrantStore,
  hooksRequiringBypass,
  type CodexHookInspection,
  type CodexHookTrustGrant
} from './codex-hook-trust'
import {
  createWorkspaceEntry,
  listWorkspace,
  moveWorkspaceEntry,
  readWorkspaceFile,
  renameWorkspaceEntry,
  trashWorkspaceEntry,
  writeWorkspaceFile
} from './workspace-files'
import type {
  WorkspaceCreateRequest,
  WorkspaceListRequest,
  WorkspaceMoveRequest,
  WorkspacePathRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest
} from '../shared/workspace'
import { editContextMenuTemplate, shouldShowEditContextMenu } from './edit-context-menu'
import {
  canonicalOrObservedTurnTiming,
  commitManagedTraceTurn,
  persistManagedTraceProgress,
  recoverManagedTraceProgress,
  recoverManagedTraceTurns,
  cleanupManagedTurnTemps,
  deleteManagedTurnArtifacts,
  managedSessionRunIds
} from './managed-turn-commit'
import {
  denyRendererPermissions,
  isAllowedRendererRequest,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  resolveRendererEntryUrl,
  rendererContentSecurityPolicy
} from './renderer-security'
import {
  buildMcpExecutionSnapshot,
  confirmMcpExecutionAuthorization,
  McpExecutionTrust,
  mcpExecutionAuthorizationPrompt,
  type McpExecutionOperation,
  type McpExecutionSnapshot
} from './mcp-execution-trust'
import {
  attachmentSessionRunIds,
  deleteRunAttachments,
  prepareRunAttachments,
  storeAttachmentReference,
  updateRunAttachmentOwner,
  type PreparedAttachment
} from './attachment-store'
import { deleteOwnedSessionData } from './session-deletion'
import { ensureFailedTerminalResult } from './run-outcome'
import { settleRunsForShutdown } from './shutdown'
import { ContextAdmission, expectedSessionMatches, waitForCompletedRuns } from './context-admission'
import {
  cleanupTraceTurnProgressTemps,
  deleteTraceTurnProgress,
  deleteTraceTurnProgressArtifacts,
  persistTraceTurnProgress,
  recoverTraceTurnProgress,
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
let evSeq = 0
let isShuttingDown = false
let startupManagedRecovery: Promise<void> = Promise.resolve()
const primaryInstance = app.requestSingleInstanceLock()
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

function attachmentPrompt(prompt: string, attachments: PreparedAttachment[]): string {
  const text = prompt.trim()
  if (attachments.length === 0) return text
  const lines = attachments.map((attachment, index) => {
    const size = attachment.size ? `, ${Math.round(attachment.size / 1024)} KB` : ''
    return `${index + 1}. ${attachment.name} (${attachment.mimeType}${size}) local copy: ${attachment.path}`
  })
  return [text, `Scry pasted image attachments:\n${lines.join('\n')}`].filter(Boolean).join('\n\n')
}

// 每个 cwd 维护各自的会话（换目录 = 换会话）
const sessionByContext = new Map<string, string>()
const sessionRevisionByContext = new Map<string, number>()
const contextAdmission = new ContextAdmission()
const recordingBlockedSessions = new Map<string, string>()
const recordingRecoveryHint = '不要开始下一轮；保留 userData/trace-turn-progress、managed-turn-progress、managed-turn-commits 与 workspace/.scry 后重试恢复'
const deletingSessions = new Set<string>()
let currentCwd: string | undefined

const homeDir = homedir()
const recentStore = () => createRecentFoldersStore(app.getPath('userData'))
const appSessionStore = () =>
  createAppSessionStore(app.getPath('userData'), ({ cwd, externalSessionId }) => {
    const archive = readTraceArchive({ cwd, sessionId: externalSessionId, userDataDir: app.getPath('userData') })
    return archive ? inferLegacyTraceArchiveProvider(archive) : undefined
  })
const codexSessionIds = () => {
  try {
    return appSessionStore().load()
      .filter((session) => session.providerId === 'codex' && session.externalSessionId)
      .map((session) => session.externalSessionId as string)
  } catch {
    return []
  }
}
const providerRegistry = new ProviderRegistry(
  createBuiltInProviderAdapters(
    homeDir,
    process.env.SCRY_PROVIDER_TRANSPORTS,
    join(app.getPath('userData'), 'codex-home-v1'),
    codexSessionIds
  ),
  {
    disabledProviders: parseDisabledProviders(process.env.SCRY_DISABLED_PROVIDERS),
    runControlsEnabled: process.env.SCRY_RUN_CONTROLS?.trim() !== '0'
  }
)
const codexHookGrantStore = () => createCodexHookGrantStore(app.getPath('userData'))
const mcpExecutionTrust = new McpExecutionTrust()

const providerContextKey = (providerId: ProviderId, cwd: string): string => `${providerId}\0${cwd}`
const providerSessionKey = (providerId: ProviderId, cwd: string, sessionId: string): string =>
  `${providerContextKey(providerId, cwd)}\0${sessionId}`

function codexHookInspectionError(cwd: string, message: string, nextAction: string): AgentRuntimeError {
  return new AgentRuntimeError(message, {
    provider: 'codex_cli',
    stage: 'capability',
    cwd,
    nextAction
  })
}

function codexHookSourceSummary(inspection: CodexHookInspection): string {
  const counts = new Map<string, number>()
  for (const hook of inspection.hooks.filter((item) => item.enabled)) {
    const source = hook.source === 'project' ? '项目级' : hook.source === 'user' ? '用户级' : hook.source
    counts.set(source, (counts.get(source) ?? 0) + 1)
  }
  return [...counts.entries()].map(([source, count]) => `${source} ${count}`).join('，')
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
  if (process.env.SCRY_CODEX_BYPASS_HOOK_TRUST?.trim() === '1') return trust

  const fingerprint = codexHookFingerprint(inspection.hooks)
  const store = codexHookGrantStore()
  if (store.isGranted(cwd, fingerprint)) return trust

  const enabledCount = inspection.hooks.filter((hook) => hook.enabled).length
  const detail = [
    `仓库：${cwd}`,
    `启用 Hook：${enabledCount} 个（${codexHookSourceSummary(inspection)}）`,
    `其中未信任或已修改：${pending.length} 个`,
    '',
    '允许后，Scry 仅把这组 Hook 的精确 key/hash 注入本次 Codex app-server 进程。',
    '以后同一组 Hook 自动放行；任何 Hook 增删或内容 hash 变化都会重新询问。',
    '这是 Scry 的本地授权，不会修改 Codex 自身的 Hook 信任库。',
    ...(inspection.warnings.length > 0 ? ['', `Codex 警告：${inspection.warnings.join('；')}`] : [])
  ].join('\n')
  const options = {
    type: 'warning' as const,
    title: '授权当前仓库的 Codex Hook',
    message: `Codex 已发现 ${pending.length} 个未信任或已修改的 Hook`,
    detail,
    buttons: ['允许当前 Hook 并启动', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const result = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (result.response !== 0) {
    throw codexHookInspectionError(
      cwd,
      '已取消 Codex Hook 授权',
      '如需执行当前仓库 Hook，请再次发送任务并在授权对话框中选择允许'
    )
  }
  try {
    store.grant(cwd, fingerprint, enabledCount)
  } catch (error) {
    throw codexHookInspectionError(
      cwd,
      `Codex Hook 授权保存失败：${String((error as Error).message)}`,
      '检查 Scry userData 目录写权限后重试'
    )
  }
  return trust
}

async function ensureMcpExecutionAuthorized(
  context: ProviderContext,
  operation: McpExecutionOperation,
  targetId?: string
): Promise<McpExecutionSnapshot | null> {
  if (context.providerId !== 'claude') return null
  const build = (): McpExecutionSnapshot => buildMcpExecutionSnapshot({
    cwd: context.cwd,
    homeDir,
    settingSources: process.env.SCRY_CLAUDE_SETTING_SOURCES,
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

  if (!mcpExecutionTrust.isGranted(operation, snapshot)) {
    const prompt = mcpExecutionAuthorizationPrompt(snapshot, operation, selected)
    const confirmed = await confirmMcpExecutionAuthorization(prompt, (options) =>
      win && !win.isDestroyed()
        ? dialog.showMessageBox(win, options)
        : dialog.showMessageBox(options)
    )
    if (!confirmed) throw new Error('已取消 MCP 执行授权')
  }

  const verified = build()
  if (verified.errors.length > 0 || verified.fingerprint !== snapshot.fingerprint) {
    throw new Error('MCP 配置在授权后发生变化，已拒绝执行')
  }
  mcpExecutionTrust.grant(operation, verified)
  return verified
}

function authorizedMcpExecution(snapshot: McpExecutionSnapshot | null): AuthorizedMcpExecution | undefined {
  if (!snapshot) return undefined
  return {
    cwd: snapshot.cwd,
    targets: snapshot.targets.map(({ targetId, name, enabled, config }) => ({ targetId, name, enabled, config })),
    env: { ...snapshot.executionEnv }
  }
}

function bumpSessionRevision(key: string): void {
  sessionRevisionByContext.set(key, (sessionRevisionByContext.get(key) ?? 0) + 1)
}

function setCurrentCwd(dir: string): void {
  if (dir !== currentCwd) {
    // Provider adapters 自己按 cwd 管理原生 transport/cache；这里只更新当前工作目录。
  }
  currentCwd = dir
}

function mirrorSessionTranscript(providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined): void {
  if (providerId !== 'claude' || !cwd || !sessionId) return
  const ok = mirrorTranscript({ cwd, sessionId, userDataDir: app.getPath('userData') })
  if (!ok) console.warn('[scry] transcript mirror skipped:', cwd, sessionId)
}

interface ArchiveTraceTurnArgs {
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd: string | undefined
  sessionId: string | undefined
  providerTurnId?: string
  runId: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done: boolean
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  error?: string
  errorHint?: string
  observedTiming?: ManagedTurnTiming
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
  const persistedItems = args.items.map((event) => {
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
  if (!args.cwd || !args.sessionId) return
  const { turn, timing } = buildTraceArchiveTurn(args)
  if (isManagedRecorderProvider(args.providerId) && (await managedRecorderMode(args.cwd)).status === 'enabled') {
    if (!args.providerTurnId) throw new Error('managed recorder requires an authoritative Provider turn id')
    if (!timing) throw new Error('managed recorder requires canonical Provider or observed interruption timing')
    await persistManagedTraceProgress({
      cwd: args.cwd,
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
    cwd: args.cwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    runtimeProvider: args.runtimeProvider,
    turn
  })
}

async function archiveTraceTurn(args: ArchiveTraceTurnArgs): Promise<void> {
  if (!args.cwd) return
  if (!args.sessionId) {
    if (isManagedRecorderProvider(args.providerId) && (await managedRecorderMode(args.cwd)).status === 'enabled') {
      throw new Error('managed recorder requires an authoritative Provider session id')
    }
    return
  }
  const { turn, timing } = buildTraceArchiveTurn(args)
  if (isManagedRecorderProvider(args.providerId)) {
    const mode = await managedRecorderMode(args.cwd)
    if (mode.status === 'enabled' && !timing) {
      throw new Error('managed recorder requires canonical Provider or observed interruption timing')
    }
    if (mode.status === 'enabled' && !args.providerTurnId) {
      throw new Error('managed recorder requires an authoritative Provider turn id')
    }
    if (mode.status === 'enabled' && timing) {
      await commitManagedTraceTurn({
        cwd: args.cwd,
        sessionId: args.sessionId,
        providerTurnId: args.providerTurnId ?? '',
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        userDataDir: app.getPath('userData'),
        turn,
        timing,
        status: args.status
      })
      return
    }
  }
  const ok = upsertTraceArchiveTurn({
    cwd: args.cwd,
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
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[scry] preload failed: ${preloadPath}`, error)
  })
  const rendererSession = win.webContents.session
  denyRendererPermissions(rendererSession)
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
    if (channel === 'app:rendererReady' && win && isTrustedRendererUrl(win.webContents.getURL(), rendererEntryUrl)) showWindow()
  }
  const showWindow = (): void => {
    if (windowShown || !win || win.isDestroyed()) return
    windowShown = true
    win.webContents.removeListener('ipc-message', onIpcMessage)
    win.show()
  }
  // ready-to-show 只代表第一帧能画，React 还没恢复 workspace/active run；此时 show 会先闪欢迎页。
  // Renderer 在关键快照稳定后主动发 app:rendererReady。保留超时兜底，避免 renderer 异常时窗口永久不可见。
  win.webContents.on('ipc-message', onIpcMessage)
  win.webContents.on('context-menu', (_event, params) => {
    if (!shouldShowEditContextMenu(params) || !win) return
    Menu.buildFromTemplate(editContextMenuTemplate(params)).popup({ window: win })
  })
  setTimeout(showWindow, 2500)
  if (useDevelopmentRenderer) {
    win.loadURL(rendererEntryUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function assertTrustedIpcEvent(event: IpcMainInvokeEvent): void {
  if (
    !win ||
    win.isDestroyed() ||
    event.sender !== win.webContents ||
    event.senderFrame !== win.webContents.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, rendererEntryUrl)
  ) {
    throw new Error('拒绝来自非可信 renderer 的 IPC 调用')
  }
}

function handleTrusted<TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcEvent(event)
    return listener(event, ...(args as TArgs))
  })
}

handleTrusted('agent:detectFast', () => {
  const supported = new Set(['claude', 'codex', 'qoder', 'opencode'])
  return detectAgentsFast().filter((agent) => supported.has(agent.id))
})

handleTrusted('agent:detect', async () => {
  // 先异步完成 PATH/版本探测，让 descriptor 的同步 fallback 命中已知路径，避免阻塞主进程。
  const detected = await detectAgents()
  const descriptors = await providerRegistry.describe()
  const found = new Map(detected.map((agent) => [agent.id, agent]))
  return descriptors
    .map((descriptor) => {
      const agent = found.get(descriptor.id)
      const path = agent?.path ?? descriptor.path
      return path && descriptor.available
        ? {
            id: descriptor.id,
            name: descriptor.label,
            bin: agent?.bin ?? descriptor.id,
            path,
            version: agent?.version ?? descriptor.version,
            runtimeProvider: descriptor.runtimeProvider,
            transport: descriptor.transport,
            capabilities: descriptor.capabilities,
            health: descriptor.health
          }
        : null
    })
    .filter((agent) => agent !== null)
})

handleTrusted('agent:providerDescriptors', () => providerRegistry.describe())

handleTrusted('agent:recentFolders', () => recentStore().load())
handleTrusted('agent:removeRecentFolder', (_event, dir: string) => recentStore().remove(dir))

handleTrusted('agent:chooseFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || r.filePaths.length === 0) return null
  const dir = r.filePaths[0]
  recentStore().push(dir)
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

function assertWorkspaceSender(senderId: number): void {
  if (!win || win.isDestroyed() || senderId !== win.webContents.id) throw new Error('无权访问工作区文件')
}

handleTrusted('workspace:list', (event, request: WorkspaceListRequest) => {
  assertWorkspaceSender(event.sender.id)
  return listWorkspace(request)
})
handleTrusted('workspace:read', (event, request: WorkspacePathRequest) => {
  assertWorkspaceSender(event.sender.id)
  return readWorkspaceFile(request)
})
handleTrusted('workspace:write', (event, request: WorkspaceWriteRequest) => {
  assertWorkspaceSender(event.sender.id)
  return writeWorkspaceFile(request)
})
handleTrusted('workspace:create', (event, request: WorkspaceCreateRequest) => {
  assertWorkspaceSender(event.sender.id)
  return createWorkspaceEntry(request)
})
handleTrusted('workspace:rename', (event, request: WorkspaceRenameRequest) => {
  assertWorkspaceSender(event.sender.id)
  return renameWorkspaceEntry(request)
})
handleTrusted('workspace:move', (event, request: WorkspaceMoveRequest) => {
  assertWorkspaceSender(event.sender.id)
  return moveWorkspaceEntry(request)
})
handleTrusted('workspace:trash', (event, request: WorkspacePathRequest) => {
  assertWorkspaceSender(event.sender.id)
  return trashWorkspaceEntry(request, (path) => shell.trashItem(path))
})

handleTrusted('agent:setCwd', (_e, dir: string) => {
  setCurrentCwd(dir)
  recentStore().push(dir)
  return dir
})

handleTrusted('agent:newSession', (_event, context: ProviderContext) => {
  const cwd = context?.cwd ?? currentCwd
  if (context?.providerId && cwd) {
    const key = providerContextKey(context.providerId, cwd)
    bumpSessionRevision(key)
    sessionByContext.delete(key)
  }
  return true
})

handleTrusted('agent:listSkills', (_e, context: ProviderContext) => providerRegistry.listSkills(context))
handleTrusted('agent:toggleSkill', (_e, p: { context: ProviderContext; name: string; enabled: boolean }) =>
  providerRegistry.setSkillEnabled(p.context, p.name, p.enabled)
)
handleTrusted('agent:mcpSnapshot', async (_e, p: { context: ProviderContext; refresh?: boolean }) => {
  const snapshot = p.refresh ? await ensureMcpExecutionAuthorized(p.context, 'live') : null
  return providerRegistry.mcpSnapshot(p.context, p.refresh, authorizedMcpExecution(snapshot))
})
handleTrusted('agent:testMcp', async (_e, p: { context: ProviderContext; targetId: string }) => {
  const snapshot = await ensureMcpExecutionAuthorized(p.context, `test:${p.targetId}`, p.targetId)
  return providerRegistry.testMcp(p.context, p.targetId, authorizedMcpExecution(snapshot))
})
handleTrusted('agent:toggleMcp', (_e, p: { context: ProviderContext; name: string; enabled: boolean }) =>
  providerRegistry.setMcpEnabled(p.context, p.name, p.enabled)
)
handleTrusted('agent:mcpGuardScan', (_e, context: ProviderContext) => {
  if (providerRegistry.isDisabled(context.providerId)) {
    return capabilityUnavailable(context, 'unsupported', '该 Provider 已通过 SCRY_DISABLED_PROVIDERS 禁用')
  }
  if (context.providerId !== 'claude') {
    return capabilityUnavailable(context, 'unsupported', 'MCP Guard 当前只扫描 Claude Code 配置；其他 Provider 不复用 Claude 路径')
  }
  const report = scanMcp({ cwd: context.cwd, home: homeDir })
  if (!isMcpGuardReport(report)) throw new Error('mcpguard 生成了不一致的扫描报告')
  return { ...context, mode: 'read', state: 'ready', data: report, observedAt: Date.now() }
})
handleTrusted('agent:listCommands', (_e, context: ProviderContext) => providerRegistry.listCommands(context))
handleTrusted('agent:runControls', (_e, context: ProviderContext) => providerRegistry.runControls(context))
handleTrusted('agent:providerAccount', (_e, context: ProviderContext) => providerRegistry.account(context))

// 单目录会话列表（当前工作目录）：只列 app 自己起过的会话
handleTrusted('agent:listSessions', (_e, context: ProviderContext) => {
  return appSessionStore().listSessions(context.cwd ?? '', context.providerId)
})

// 左侧栏 Projects 分组：只从 app 会话记录按 cwd 分组（不扫 ~/.claude/projects，不采集 terminal 会话）
handleTrusted('agent:listProjects', () => appSessionStore().listProjects())
handleTrusted('agent:catalogHealth', () => appSessionStore().health())

// 加载一个历史会话：解析 transcript 成对话轮次，并把它设为当前会话（后续对话会 resume）
handleTrusted('agent:loadSession', (_e, payload: ProviderContext) => {
  if (!payload.cwd || !payload.externalSessionId) return null
  const archived = readTraceArchive({
    cwd: payload.cwd,
    sessionId: payload.externalSessionId,
    providerId: payload.providerId,
    userDataDir: app.getPath('userData')
  })
  const fp =
    payload.providerId === 'claude'
      ? resolveTranscriptPath({ cwd: payload.cwd, sessionId: payload.externalSessionId, userDataDir: app.getPath('userData') })
      : null
  let turns: ParsedTurn[] = []
  if (fp) {
    try {
      const content = readFileSync(fp, 'utf8')
      turns = parseTranscriptToTurns(content, {
        runId: payload.externalSessionId,
        newId: () => `h-${evSeq++}`,
        now: () => new Date().toISOString()
      })
    } catch {
      if (!archived) return null
    }
  }
  if (!fp && !archived) return null
  setCurrentCwd(payload.cwd)
  const key = providerContextKey(payload.providerId, payload.cwd)
  bumpSessionRevision(key)
  const catalogSession = appSessionStore().load().find((session) =>
    session.providerId === payload.providerId && session.cwd === payload.cwd &&
    (session.sessionId === payload.externalSessionId || session.externalSessionId === payload.externalSessionId)
  )
  if (!catalogSession || appSessionCanResume(catalogSession)) sessionByContext.set(key, payload.externalSessionId)
  else sessionByContext.delete(key)
  recentStore().push(payload.cwd)
  const merged = mergeSessionTurns(turns, archived, { userDataDir: app.getPath('userData') })
  const hookConfig =
    payload.providerId === 'claude'
      ? loadClaudeHookConfig(payload.cwd, homeDir)
      : payload.providerId === 'codex'
        ? loadCodexHookConfig(payload.cwd, homeDir)
        : null
  if (!hookConfig) return merged
  return merged.map((turn) => ({
    ...turn,
    items: turn.items.map((event) => attachConfiguredHookCommands(event, hookConfig))
  }))
})

// 删除一个历史会话。工作区 .scry/ 是独立 canonical evidence，明确保留。
handleTrusted(
  'agent:deleteSession',
  async (_e, p: Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }): Promise<DeleteSessionResult> => {
    const empty = (): Pick<DeleteSessionResult, 'deleted' | 'retained' | 'failed'> => ({
      deleted: [],
      retained: ['workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history'],
      failed: []
    })
    if (!p.cwd || !p.externalSessionId || p.providerId === 'legacy_unknown') {
      return { ok: false, reason: 'invalid_request', ...empty() }
    }
    const cwd = p.cwd
    const externalSessionId = p.externalSessionId
    const providerId = p.providerId as ProviderId
    const admissionKey = providerContextKey(providerId, cwd)
    const deletionKey = providerSessionKey(providerId, cwd, externalSessionId)
    const hasActiveSession = (): boolean => runs.unsettledStates().some((run) => {
      const sessionId = run.externalSessionId ?? run.sessionId
      return run.providerId === providerId && run.cwd === cwd &&
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
          session.providerId === providerId && session.cwd === cwd &&
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
      for (const runId of usageSessionRunIds({ userDataDir, providerId, cwd, externalSessionId })) {
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
      const result = await deleteOwnedSessionData(initialRunIds, {
        resolveRunIds: (runIds) => resolveSessionRunIds({ providerId, cwd, externalSessionId, runIds }),
        deleteDatabase: (runIds) => deleteSessionData({ providerId, cwd, externalSessionId, runIds }),
        deleteUsage: (runIds) => deleteUsageSessionRows({ userDataDir, providerId, cwd, externalSessionId, runIds }),
        deleteManaged: async (runIds) => {
          const traceProgress = deleteTraceTurnProgressArtifacts(userDataDir, runIds)
          if (traceProgress.failed.length > 0) return traceProgress
          return deleteManagedTurnArtifacts(userDataDir, runIds)
        },
        deleteAttachments: (runId) => deleteRunAttachments(userDataDir, runId),
        deleteTranscripts: () => deleteTranscriptCopies({ cwd, sessionId: externalSessionId, providerId, userDataDir }),
        deleteCatalog: () => sessionStore.remove({ providerId, cwd, externalSessionId })
      })
      if (!result.ok) {
        const failureOptions = {
          type: 'error' as const,
          message: '会话未完整删除，catalog 已保留供重试',
          detail: result.failed.map((failure) => `${failure.store}: ${failure.error}`).join('\n')
        }
        if (win && !win.isDestroyed()) await dialog.showMessageBox(win, failureOptions)
        else await dialog.showMessageBox(failureOptions)
        return result
      }
      const key = providerContextKey(providerId, cwd)
      if (sessionByContext.get(key) === externalSessionId) sessionByContext.delete(key)
      recordingBlockedSessions.delete(deletionKey)
        return result
      })
    } finally {
      deletingSessions.delete(deletionKey)
    }
  }
)

interface RunControl {
  runId: string
  providerId: ProviderId
  interrupt: () => void
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
const userQuestionBroker = new UserQuestionBroker((change: UserQuestionChange) => {
  if (change.kind === 'open') {
    const run = runs.get(change.request.runId)?.state
    if (run) {
      run.pendingQuestions = [
        ...(run.pendingQuestions ?? []).filter((item) => item.questionId !== change.request.questionId),
        change.request
      ]
    }
    if (runs.isFocused(change.request.runId)) win?.webContents.send('agent:userQuestion', change.request)
    return
  }
  const run = runs.get(change.runId)?.state
  if (run) {
    run.pendingQuestions = (run.pendingQuestions ?? []).filter((item) => item.questionId !== change.questionId)
  }
  if (runs.isFocused(change.runId)) win?.webContents.send('agent:userQuestionClosed', change)
})
// 性能：把 onTrace 逐条 IPC 合批——流式期每 token 一条 IPC（每秒上百）→ 缓冲 ~16ms 一批数组发。
// 保序（FIFO buffer）、不丢（done/error 前 flushTraceSend 强制清空）。
let traceSendBuf: TraceEvent[] = []
let traceSendTimer: ReturnType<typeof setTimeout> | null = null
function flushTraceSend(): void {
  if (traceSendTimer) {
    clearTimeout(traceSendTimer)
    traceSendTimer = null
  }
  if (traceSendBuf.length === 0) return
  const batch = traceSendBuf
  traceSendBuf = []
  win?.webContents.send('agent:trace', batch)
}
function queueTrace(ev: TraceEvent): void {
  traceSendBuf.push(ev)
  if (!traceSendTimer) traceSendTimer = setTimeout(flushTraceSend, 16)
}

handleTrusted('agent:start', async (_e, payload: AgentStartRequest) => {
  const request = normalizeAgentStartRequest(payload)
  const providerId = request.providerId
  const adapter = providerRegistry.get(providerId)
  const runtimeProvider = adapter.runtimeProvider
  if (isShuttingDown) {
    throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      nextAction: '重新打开 Scry 后再启动'
    })
  }
  await warmShellEnv()
  const cwd = request.cwd ?? currentCwd
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
  const admissionKey = providerContextKey(providerId, cwd ?? '')
  return contextAdmission.run(admissionKey, async () => {
    await startupManagedRecovery
    const contextKey = cwd ? providerContextKey(providerId, cwd) : undefined
    let contextRevision = contextKey ? (sessionRevisionByContext.get(contextKey) ?? 0) : 0
    let resume = contextKey ? sessionByContext.get(contextKey) : undefined
    const expectedSessionId = request.expectedExternalSessionId
    const contextRuns = runs.unsettledStates().filter((run) => run.providerId === providerId && run.cwd === cwd)
    const catalogAliases = (): Array<{ runId: string; externalSessionId?: string; sessionId?: string }> => {
      if (!cwd) return []
      try {
        return appSessionStore().load()
          .filter((session) => session.providerId === providerId && session.cwd === cwd && Boolean(session.runId))
          .map((session) => ({
            runId: session.runId!,
            ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : {}),
            sessionId: session.sessionId
          }))
      } catch {
        return []
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
    if (!expectedSessionMatches(expectedSessionId, resume, [...contextRuns, ...catalogAliases()])) {
      throw contextChangedError()
    }
    if (cwd && resume && deletingSessions.has(providerSessionKey(providerId, cwd, resume))) {
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
    contextRevision = contextKey ? (sessionRevisionByContext.get(contextKey) ?? 0) : 0
    resume = contextKey ? sessionByContext.get(contextKey) : undefined
    const latestContextRuns = runs.unsettledStates().filter((run) => run.providerId === providerId && run.cwd === cwd)
    if (!expectedSessionMatches(expectedSessionId, resume, [...contextRuns, ...latestContextRuns, ...catalogAliases()])) {
      throw contextChangedError()
    }
    if (cwd && resume && deletingSessions.has(providerSessionKey(providerId, cwd, resume))) {
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
  if (traceProgressRecovery.pending > 0) {
    throw new AgentRuntimeError(`Scry trace 仍有 ${traceProgressRecovery.pending} 轮待恢复`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '保留 Scry userData/trace-turn-progress，修复 archive 写入后重试'
    })
  }
  let managedRecorderEnabled = false
  let recoveredManagedTurns = traceProgressRecovery.recovered
  if (isManagedRecorderProvider(providerId) && cwd) {
    managedRecorderEnabled = (await managedRecorderMode(cwd)).status === 'enabled'
    const journalRecovery = await recoverManagedTraceTurns(app.getPath('userData'), {
      cwd,
      providerId,
      ...(resume ? { sessionId: resume } : {}),
      waitMs: 250
    })
    const progressRecovery = await recoverManagedTraceProgress(app.getPath('userData'), {
      cwd,
      providerId,
      ...(resume ? { sessionId: resume } : {}),
      waitMs: 250
    })
    const recorderRecovery = resume
      ? await recoverManagedRecorderTurns(cwd, process.env, { sessionId: resume, provider: providerId })
      : await recoverManagedRecorderTurns(cwd, process.env, { provider: providerId })
    // 同一轮可能同时留下 progress、journal 与 recorder open；三层计数不能相加，
    // 否则会把一个待恢复 turn 报成三轮。这里只需要 fail closed。
    const pending = Math.max(progressRecovery.pending, journalRecovery.pending, recorderRecovery.pending)
    recoveredManagedTurns += progressRecovery.recovered + journalRecovery.recovered + recorderRecovery.recovered
    if (pending > 0) {
      throw new AgentRuntimeError(`Scry 精确记录仍有 ${pending} 轮待恢复`, {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '保留当前工作区与 Scry Test 数据目录，先运行 scry doctor 并修复 pending canonical journal'
      })
    }
  }
  const recordingKey = cwd && resume ? providerSessionKey(providerId, cwd, resume) : undefined
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
  const mcpExecution = providerId === 'claude'
    ? authorizedMcpExecution(await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run'))
    : undefined
  if (isShuttingDown) {
    throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '重新打开 Scry 后再启动'
    })
  }
  const committedResume = contextKey ? sessionByContext.get(contextKey) : undefined
  const committedRevision = contextKey ? (sessionRevisionByContext.get(contextKey) ?? 0) : 0
  const committedRuns = runs.unsettledStates().filter((run) => run.providerId === providerId && run.cwd === cwd)
  if (
    committedResume !== resume || committedRevision !== contextRevision ||
    !expectedSessionMatches(expectedSessionId, committedResume, [...committedRuns, ...catalogAliases()])
  ) throw contextChangedError()
  if (cwd && committedResume && deletingSessions.has(providerSessionKey(providerId, cwd, committedResume))) {
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
    cwd,
    externalSessionId: resume,
    sessionId: resume,
    userText: displayPrompt,
    attachments,
    items: [],
    done: false,
    providerSettled: false
  }
  const cleanupProvisional = (): void => {
    if (!cwd || resume || runState.externalSessionId) return
    appSessionStore().remove({ providerId, cwd, externalSessionId: runId })
  }
  const emit = (rawEvent: TraceEvent): void => {
    const ev = hookConfig ? attachConfiguredHookCommands(rawEvent, hookConfig) : rawEvent
    turnChangeJournal?.record(ev)
    if (ev.kind === 'harness' && ev.stage === 'result') {
      appendUsage(
        app.getPath('userData'),
        { providerId, runtimeProvider, cwd, externalSessionId: observedSessionId, runId, source: ev.usageSource },
        ev
      )
    }
    appendCoalescedTrace(runState.items, ev)
    if (runs.isFocused(runId)) queueTrace(ev) // 后台 run 继续归档，只把当前会话 trace 推给 UI。
  }
  emit({
    id: `c-${evSeq++}`,
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
    if (cwd && resume) {
      // 续接同一原生 session 时也要把侧栏元数据的 runId 更新为本轮，否则切走再点回会拿到上一轮的 stale runId。
      appSessionStore().record({
        providerId,
        runtimeProvider,
        runId,
        externalSessionId: resume,
        cwd,
        prompt: displayPrompt
      })
    } else if (cwd) {
      // Ownership is durable before attachment bytes are created. A crash can no longer
      // leave a new-session attachment directory with no catalog runId to delete.
      appSessionStore().recordPending({ providerId, runtimeProvider, runId, cwd, prompt: displayPrompt })
    }
    attachments = prepareRunAttachments(
      app.getPath('userData'),
      runId,
      request.attachments,
      cwd ? { providerId, cwd, ...(resume ? { sessionId: resume } : {}) } : undefined
    )
    runState.attachments = attachments
    runtimePrompt = attachmentPrompt(displayPrompt, attachments)
    if (cwd && resume) {
      win?.webContents.send('agent:session', {
        runId,
        sessionId: resume,
        externalSessionId: resume,
        providerId
      })
    } else if (cwd) {
      win?.webContents.send('agent:session', { runId, sessionId: runId, providerId, pending: true })
    }
  } catch (error) {
    try { cleanupProvisional() } catch { /* preserve the frontdoor error */ }
    deleteRunAttachments(app.getPath('userData'), runId)
    throw error
  }
  const turnDiffCapture = cwd ? beginGitTurnDiff(cwd) : Promise.resolve(unavailableCapture())
  let turnDiffPromise: Promise<void> | null = null
  const finalizeTurnDiff = (): Promise<void> => {
    turnDiffPromise ??= turnDiffCapture
      .then((capture) => finishGitTurnDiff(capture, undefined, turnChangeJournal?.snapshot()))
      .then((turnDiff) => {
        const event: TraceEvent = {
          id: `d-${evSeq++}`,
          ts: new Date().toISOString(),
          runId,
          kind: 'harness',
          stage: 'turn_diff',
          providerId,
          runtimeProvider,
          turnDiff
        }
        appendCoalescedTrace(runState.items, event)
        if (runs.isFocused(runId)) queueTrace(event)
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
    turnDiffPromise ??= turnDiffCapture
      .then((capture) => cancelGitTurnDiff(capture))
      .catch((error) => console.warn('[scry] turn diff cancellation failed:', runId, error))
    return turnDiffPromise
  }
  let notifiedSessionId = resume
  const publishSessionId = (sessionId: string | undefined): void => {
    if (!sessionId) return
    observedSessionId = sessionId
    if (contextKey && (sessionRevisionByContext.get(contextKey) ?? 0) === contextRevision) {
      sessionByContext.set(contextKey, sessionId)
    }
    runState.sessionId = sessionId
    runState.externalSessionId = sessionId
    if (cwd) {
      try { updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId }) } catch (error) {
        console.warn('[scry] attachment ownership update deferred:', runId, error)
      }
    }
    if (cwd) {
      try {
        appSessionStore().record({ providerId, runtimeProvider, runId, externalSessionId: sessionId, cwd, prompt: displayPrompt })
      } catch (error) {
        console.warn('[scry] native session catalog update deferred:', runId, error)
      }
    }
    if (notifiedSessionId === sessionId) return
    notifiedSessionId = sessionId
    try {
      win?.webContents.send('agent:session', {
        runId,
        sessionId,
        previousSessionId: runId,
        externalSessionId: sessionId,
        providerId
      })
    } catch (error) {
      console.warn('[scry] native session renderer notification failed:', runId, error)
    }
  }
  let h: {
    promise: Promise<{
      externalSessionId?: string
      providerTurnId?: string
      stopped?: boolean
      status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    }>
    interrupt: () => void
    getExternalSessionId: () => string | undefined
    getProviderTurnId?: () => string | undefined
  } | null = null
  let interrupted = false
  let observedProviderStartedAt: string | undefined
  const runProvider = async (): Promise<{
    externalSessionId?: string
    providerTurnId?: string
    stopped?: boolean
    status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  }> => {
    if (interrupted) return { stopped: true }
    observedProviderStartedAt = new Date().toISOString()
    h = providerRegistry.run(providerId, {
      runId,
      prompt: runtimePrompt,
      cwd,
      resume,
      attachments,
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode,
      codexHookTrust,
      managedRecorder: managedRecorderEnabled,
      mcpExecution,
      emit,
      onExternalSessionId: publishSessionId,
      requestUserInput: (question, signal) => userQuestionBroker.request({ ...question, providerId }, signal)
    })
    if (interrupted) h.interrupt()
    const result = await h.promise
    if (result.status === 'failed') {
      const providerMessage = [...runState.items].reverse().find(
        (event) => event.kind === 'harness' && event.stage === 'result' && event.isError
      )?.text
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
  let terminalArchiveArgs: ArchiveTraceTurnArgs | undefined
  let terminalArchiveCommitted = false
  const runtimePromise = turnDiffCapture.then(runProvider)
  runtimePromise
    .then(async (r) => {
      const turnDiffDone = finalizeTurnDiff()
      const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
      const nativeSessionId = r.externalSessionId ?? observedSessionId ?? resume
      const storageSessionId = nativeSessionId ?? runId
      const completionStatus = r.status ?? (r.stopped ? 'interrupted' : 'completed')
      const completionArchiveArgs: ArchiveTraceTurnArgs = {
        providerId,
        runtimeProvider,
        cwd,
        sessionId: storageSessionId,
        providerTurnId: r.providerTurnId,
        runId,
        userText: displayPrompt,
        attachments,
        items: runState.items,
        done: true,
        status: completionStatus,
        observedTiming
      }
      terminalArchiveArgs = completionArchiveArgs
      if (cwd) {
        try { updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId: storageSessionId }) } catch (error) {
          console.warn('[scry] terminal attachment ownership update failed:', runId, error)
        }
      }
      publishSessionId(r.externalSessionId)
      // Diff 是附加观测数据：立即开始采集，但不能阻塞用户看到 turnDone。
      // 归档仍等待它完成，保证历史回放最终包含 turn_diff。
      if (cwd) {
        try {
          appSessionStore().record({
            providerId,
            runtimeProvider,
            runId,
            externalSessionId: storageSessionId,
            cwd,
            prompt: displayPrompt
          })
        } catch (error) {
          win?.webContents.send('agent:error', {
            runId,
            message: `模型已完成，但会话 catalog 更新失败：${String((error as Error).message)}`,
            category: 'catalog',
            hint: '保留 userData/app-sessions.json 与 .bak 后重试；本轮 trace 仍会继续归档'
          })
        }
      }
      mirrorSessionTranscript(providerId, cwd, nativeSessionId)
      const alreadyDone = runState.done
      runState.done = true
      flushTraceSend() // 先把模型/工具事件发完，再发 turnDone；turn_diff 可稍后增量到达
      try {
        // Provider 已完成时先落一份 durable canonical snapshot。若 App 在等待 Git diff
        // 期间崩溃，下一次启动仍能用同一用户输入、模型输出、调用与权威 result timing
        // 恢复 archive/CLI；diff 会明确记为 unavailable，而不是伪造零值。
        await persistTerminalProgress(completionArchiveArgs)
      } catch (error) {
        const message = `模型已完成，但 Scry 精确记录快照失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        if (cwd) recordingBlockedSessions.set(providerSessionKey(providerId, cwd, storageSessionId), runState.errorHint)
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
          stopped: r.stopped
        })
      }
      await turnDiffDone
      try {
        await archiveTraceTurn(completionArchiveArgs)
        terminalArchiveCommitted = true
        if (cwd) recordingBlockedSessions.delete(providerSessionKey(providerId, cwd, storageSessionId))
      } catch (error) {
        const message = `模型已完成，但 Scry 精确记录提交失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        if (cwd) recordingBlockedSessions.set(providerSessionKey(providerId, cwd, storageSessionId), runState.errorHint)
        win?.webContents.send('agent:error', {
          runId,
          message,
          category: 'recording',
          hint: runState.errorHint
        })
        return
      }
      // B2：把这一轮的 turn + tool_calls 结构化落 sqlite（runState 已缓冲全部事件）
      recordTurn({
        runId,
        sessionId: storageSessionId,
        cwd,
        userText: displayPrompt,
        items: runState.items,
        providerId,
        runtimeProvider,
        billingProvider: [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')?.billingProvider
      })
      if (canonicalLifecycle && !alreadyDone) {
        win?.webContents.send('agent:turnDone', {
          runId,
          sessionId: storageSessionId,
          externalSessionId: storageSessionId,
          providerId,
          stopped: r.stopped
        })
      }
    }, async (err) => {
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
      const runtimeErr = err instanceof AgentRuntimeError ? err : null
      const message = String(err?.message ?? err)
      const classified = runtimeErr ? { category: runtimeErr.brief.stage, hint: runtimeErr.brief.nextAction } : classifyError(message)
      const { category, hint } = classified
      let providerTurnId: string | undefined
      try {
        providerTurnId = h?.getProviderTurnId?.()
      } catch (error) {
        console.warn('[scry] Provider turn getter failed at terminal boundary:', runId, error)
      }
      terminalArchiveArgs = {
        providerId,
        runtimeProvider,
        cwd,
        sessionId: storageSessionId,
        providerTurnId,
        runId,
        userText: displayPrompt,
        attachments,
        items: runState.items,
        done: true,
        status: stopped ? 'interrupted' : 'failed',
        observedTiming,
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
            id: `h-${evSeq++}`,
            ts: new Date().toISOString()
          })
          if (runs.isFocused(runId)) {
            for (const correction of failure.corrections) queueTrace({ ...correction })
          }
          if (failure.created) {
            appendUsage(
              app.getPath('userData'),
              { providerId, runtimeProvider, cwd, externalSessionId: storageSessionId, runId, source: failure.terminal.usageSource },
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
      if (cwd) {
        try {
          appSessionStore().record({
            providerId,
            runtimeProvider,
            runId,
            externalSessionId: storageSessionId,
            cwd,
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
      }
      mirrorSessionTranscript(providerId, cwd, nativeSessionId)
      try {
        await persistTerminalProgress(terminalArchiveArgs)
      } catch (progressError) {
        const recordingMessage = `Provider 已结束，但 Scry 精确记录快照失败：${String((progressError as Error).message)}`
        runState.error = recordingMessage
        runState.errorHint = recordingRecoveryHint
        if (cwd) recordingBlockedSessions.set(providerSessionKey(providerId, cwd, storageSessionId), runState.errorHint)
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
        if (!alreadyDone) win?.webContents.send('agent:turnDone', { runId, stopped: true, providerId })
      } else {
        win?.webContents.send('agent:error', { runId, message, category, hint })
      }
      await turnDiffDone
      let exactRecorded = true
      try {
        await archiveTraceTurn(terminalArchiveArgs)
        terminalArchiveCommitted = true
        if (cwd) recordingBlockedSessions.delete(providerSessionKey(providerId, cwd, storageSessionId))
      } catch (archiveError) {
        exactRecorded = false
        if (cwd) recordingBlockedSessions.set(
          providerSessionKey(providerId, cwd, storageSessionId),
          recordingRecoveryHint
        )
        console.error('[scry] exact turn archive failed:', archiveError)
        if (canonicalLifecycle) {
          const recordingMessage = `Scry 精确记录提交失败：${String((archiveError as Error).message)}`
          win?.webContents.send('agent:error', {
            runId,
            message: recordingMessage,
            category: 'recording',
            hint: recordingRecoveryHint
          })
        }
      }
      recordTurn({
        runId,
        sessionId: storageSessionId,
        cwd,
        userText: displayPrompt,
        items: runState.items,
        providerId,
        runtimeProvider,
        billingProvider: [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')?.billingProvider
      })
      if (stopped && canonicalLifecycle && !alreadyDone && exactRecorded) {
        win?.webContents.send('agent:turnDone', { runId, stopped: true, providerId })
      }
    })
    .catch(async (error) => {
      console.error('[scry] run completion handler failed:', error)
      await finalizeTurnDiff()
      if (terminalArchiveArgs && !terminalArchiveCommitted) {
        try {
          await archiveTraceTurn(terminalArchiveArgs)
          terminalArchiveCommitted = true
          if (cwd && terminalArchiveArgs.sessionId) {
            recordingBlockedSessions.delete(providerSessionKey(providerId, cwd, terminalArchiveArgs.sessionId))
          }
        } catch (archiveError) {
          if (cwd && terminalArchiveArgs.sessionId) recordingBlockedSessions.set(
            providerSessionKey(providerId, cwd, terminalArchiveArgs.sessionId),
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
    })
    .finally(() => {
      runState.providerSettled = true
      userQuestionBroker.cancelRun(runId)
      runs.remove(runId)
      resolveSettled?.()
    })
  return { runId }
  })
})

// Renderer 重挂时拉回当前焦点或全部在途 run；焦点只影响显示，不影响后台生命周期。
handleTrusted('agent:activeRun', (): ActiveRun | null => runs.focusedState())
handleTrusted('agent:activeRuns', (): ActiveRun[] => runs.activeStates())
handleTrusted('agent:focusRun', (_event, runId: string | null): boolean => runs.focus(runId))
handleTrusted('agent:adoptActiveRun', (_event, runId: string): ActiveRun | null => {
  const entry = runs.get(runId)
  if (!entry || entry.state.done) return null
  entry.control.adoptSession()
  runs.focus(runId)
  return entry.state
})
handleTrusted('agent:answerQuestion', (event, response: unknown) => {
  if (!win || event.sender.id !== win.webContents.id) return false
  return userQuestionBroker.answer(response)
})

// B2：sqlite 跨会话分析（工具频率 / 按目录花费），纯文件做不到的结构化查询
handleTrusted('agent:stats', () => statsQuery())
handleTrusted('agent:billingState', async () => {
  await warmShellEnv()
  return billingStateQuery()
})
handleTrusted('agent:syncBillingAdmin', async () => {
  await warmShellEnv()
  return syncBillingAdmin()
})
handleTrusted('agent:importBillingFixture', () => importBillingFixture())

// P2 Files & Diff：cwd 的最终 git diff（vs HEAD 增删），与工具足迹对照
handleTrusted('agent:gitDiff', (_e, cwd: string) => gitNumstat(cwd))

// P2 Diagnostics：claude 版本（init 报）+ SDK 声明版本 + settingSources
handleTrusted('agent:diagnostics', () => {
  let sdkVersion = 'unknown'
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    sdkVersion = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? 'unknown'
  } catch {
    /* 读不到就 unknown */
  }
  return { claudeVersion: getClaudeVersion(), sdkVersion, settingSources: '默认（SDK 加载 user/project/local）' }
})

handleTrusted('agent:stop', (_event, runId: string) => {
  const entry = runs.get(runId)
  if (!entry || entry.state.done) return false
  const stopping = entry.control
  stopping.interrupt()
  userQuestionBroker.cancelRun(stopping.runId)
  // A2：强制超时兜底——若 SDK 2s 内没结束（interrupt 卡住），强制通知 renderer 结束，防 UI 永久卡在运行态
  setTimeout(async () => {
    const current = runs.get(stopping.runId)
    if (current?.control !== stopping || current.state.done) return
    if (stopping.canonicalLifecycle) return
    // 这里只结束 UI 等待。Provider、diff 与持久化仍是 unsettled；删除、续开和退出
    // 必须继续把该 registry entry 当作在途，直到 runtime promise 真正 settle。
    if (runs.get(stopping.runId)?.control !== stopping) return
    stopping.runState.done = true
    flushTraceSend()
    win?.webContents.send('agent:turnDone', { runId: stopping.runId, stopped: true, providerId: stopping.providerId })
    // 控制器保留到 Provider promise 真正 settle，避免迟到 reject/error 找不到自身状态或误命中其他 run。
  }, 2000)
  return true
})

// B2-lite：累计用量统计（读 usage.jsonl 聚合）
handleTrusted('agent:usageStats', (_event, context?: ProviderContext) =>
  readUsageStats(app.getPath('userData'), context ? { providerId: context.providerId, cwd: context.cwd } : {})
)

app.whenReady().then(() => {
  if (!primaryInstance) return
  void warmShellEnv()
  cleanupAppStoreAtomicTemps(app.getPath('userData'))
  cleanupUsageAtomicTemps(app.getPath('userData'))
  cleanupManagedTurnTemps(app.getPath('userData'))
  cleanupTraceTurnProgressTemps(app.getPath('userData'))
  cleanupTraceArchiveTemps(app.getPath('userData'))
  try {
    migrateLegacyUserData(app.getPath('appData'), app.getPath('userData'))
  } catch (e) {
    console.warn('[scry] legacy userData migration skipped:', (e as Error)?.message)
  }
  startupManagedRecovery = recoverTraceTurnProgress(app.getPath('userData'))
    .then(async (traceProgress) => {
      if (traceProgress.pending > 0) console.warn('[scry] trace turn progress recovery pending:', traceProgress)
      const journals = await recoverManagedTraceTurns(app.getPath('userData'))
      if (journals.pending > 0) console.warn('[scry] managed turn recovery pending:', journals)
      const progress = await recoverManagedTraceProgress(app.getPath('userData'))
      if (progress.pending > 0) console.warn('[scry] managed turn progress recovery pending:', progress)
    })
    .catch((error) => console.warn('[scry] managed turn startup recovery failed:', error))
  createWindow()
  setTimeout(() => initDb(), 800)
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
  const cleanup = settleRunsForShutdown(runs.unsettledControls(), {
    cancelQuestion: (runId) => userQuestionBroker.cancelRun(runId),
    mirror: (run, externalSessionId) => mirrorSessionTranscript(run.providerId, run.cwd, externalSessionId),
    disposeProviders: () => providerRegistry.dispose()
  })
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 6_000))
  void Promise.race([cleanup, timeout]).finally(() => {
    quitCleanupFinished = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
