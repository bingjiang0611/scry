import { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { getClaudeVersion } from './agent-runner'
import { detectAgents, detectAgentsFast, shellEnv, warmShellEnv } from './claude-locate'
import { AgentRuntimeError, runtimeFailureTrace } from './cli-runtime'
import { parseTranscriptToTurns, type ParsedTurn } from './normalize'
import { classifyError } from './error-classify'
import { billingStateQuery, importBillingFixture, initDb, recordTurn, setBillingEnvProvider, statsQuery, syncBillingAdmin } from './db'
import { beginGitTurnDiff, cancelGitTurnDiff, finishGitTurnDiff, gitNumstat, type GitTurnDiffCapture } from './git'
import {
  deleteTranscriptCopies,
  inferTraceArchiveProvider,
  mirrorTranscript,
  readTraceArchive,
  resolveTranscriptPath,
  upsertTraceArchiveTurn,
  type TraceArchiveTurn
} from './transcript-archive'
import { mergeSessionTurns } from './session-history'
import { createAppSessionStore, createRecentFoldersStore } from './app-store'
import { scanMcp } from '../cli/mcpguard-core'
import { appendUsage, readUsageStats } from './usage-jsonl'
import { migrateLegacyUserData } from './user-data-migration'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import {
  normalizeAgentStartRequest,
  type AgentInputAttachment,
  type AgentImageMimeType,
  type AgentStartRequest,
  type RuntimeProvider
} from '../shared/runtime'
import { capabilityUnavailable, type ProviderContext, type ProviderId, type SessionProviderId } from '../shared/provider'
import { parseDisabledProviders, ProviderRegistry } from './providers/registry'
import { createBuiltInProviderAdapters } from './providers'
import { appendCoalescedTrace } from './live-trace'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { managedRecorderMode, recoverManagedRecorderTurns } from '../core/turn-recorder/managed'
import { TurnChangeJournal } from '../core/turn-recorder/change-journal'
import { attachConfiguredHookCommands, loadClaudeHookConfig, loadCodexHookConfig } from './hook-config'
import { UserQuestionBroker, type UserQuestionChange } from './user-question'
import { RunRegistry } from './run-registry'
import {
  codexHookFingerprint,
  createCodexHookGrantStore,
  hooksRequiringBypass,
  type CodexHookInspection
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
  canonicalTurnTiming,
  commitManagedTraceTurn,
  persistManagedTraceProgress,
  recoverManagedTraceProgress,
  recoverManagedTraceTurns
} from './managed-turn-commit'

// scry 开发期可能从一个父 Claude Code 会话内启动，继承了 CLAUDECODE / CLAUDE_CODE_* /
// AI_AGENT 等环境变量，会让 SDK 驱动的 claude 子进程认证错乱（误判为嵌套会话 → Not logged in）。
// 启动时清掉这些继承来的变量，让 SDK 的 cli.js 以干净的用户级环境读本机登录态（Keychain/OAuth）。
for (const k of Object.keys(process.env)) {
  if (k === 'CLAUDECODE' || k === 'AI_AGENT' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_')) {
    delete process.env[k]
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null
let runSeq = 0
let evSeq = 0
setBillingEnvProvider(shellEnv)

type PreparedAttachment = AgentInputAttachment & { path: string }

const IMAGE_EXT: Record<AgentImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

function safeAttachmentName(name: string, mimeType: AgentImageMimeType, index: number): string {
  const ext = IMAGE_EXT[mimeType]
  const base = basename(name || `pasted-image-${index + 1}.${ext}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const withExt = extname(base) ? base : `${base || `pasted-image-${index + 1}`}.${ext}`
  return `${String(index + 1).padStart(2, '0')}-${withExt}`
}

function prepareRunAttachments(runId: string, attachments: AgentInputAttachment[]): PreparedAttachment[] {
  if (attachments.length === 0) return []
  const dir = join(app.getPath('userData'), 'attachments', runId)
  mkdirSync(dir, { recursive: true })
  return attachments.map((attachment, index) => {
    const fileName = safeAttachmentName(attachment.name, attachment.mimeType, index)
    const path = join(dir, fileName)
    const bytes = Buffer.from(attachment.dataBase64, 'base64')
    writeFileSync(path, bytes)
    return { ...attachment, name: fileName, size: bytes.byteLength, path }
  })
}

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
let currentCwd: string | undefined

const homeDir = homedir()
const recentStore = () => createRecentFoldersStore(app.getPath('userData'))
const appSessionStore = () =>
  createAppSessionStore(app.getPath('userData'), ({ cwd, externalSessionId }) => {
    const archive = readTraceArchive({ cwd, sessionId: externalSessionId, userDataDir: app.getPath('userData') })
    return archive ? inferTraceArchiveProvider(archive) : undefined
  })
const providerRegistry = new ProviderRegistry(
  createBuiltInProviderAdapters(homeDir, process.env.SCRY_PROVIDER_TRANSPORTS),
  { disabledProviders: parseDisabledProviders(process.env.SCRY_DISABLED_PROVIDERS) }
)
const codexHookGrantStore = () => createCodexHookGrantStore(app.getPath('userData'))

const providerContextKey = (providerId: ProviderId, cwd: string): string => `${providerId}\0${cwd}`

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

async function resolveCodexHookBypass(cwd: string): Promise<boolean> {
  if (process.env.SCRY_CODEX_BYPASS_HOOK_TRUST?.trim() === '1') return true

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
  if (pending.length === 0) return false

  const fingerprint = codexHookFingerprint(inspection.hooks)
  const store = codexHookGrantStore()
  if (store.isGranted(cwd, fingerprint)) return true

  const enabledCount = inspection.hooks.filter((hook) => hook.enabled).length
  const detail = [
    `仓库：${cwd}`,
    `启用 Hook：${enabledCount} 个（${codexHookSourceSummary(inspection)}）`,
    `其中未信任或已修改：${pending.length} 个`,
    '',
    '允许后，Scry 仅为这个仓库、这组 Hook 指纹启动带 --dangerously-bypass-hook-trust 的 Codex app-server。',
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
  return true
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
}

function buildTraceArchiveTurn(args: ArchiveTraceTurnArgs): {
  turn: TraceArchiveTurn
  timing: ReturnType<typeof canonicalTurnTiming>
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
  const timing = canonicalTurnTiming(persistedItems)
  return {
    timing,
    turn: {
      runId: args.runId,
      ...(args.providerTurnId ? { providerTurnId: args.providerTurnId } : {}),
      userText: args.userText,
      attachments: args.attachments,
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

async function persistManagedCompletionProgress(args: ArchiveTraceTurnArgs): Promise<void> {
  if (args.providerId !== 'codex' || !args.cwd) return
  const mode = await managedRecorderMode(args.cwd)
  if (mode.status === 'disabled') return
  if (!args.sessionId) throw new Error('managed recorder requires an authoritative Codex session id')
  if (!args.providerTurnId) throw new Error('managed recorder requires an authoritative Codex turn id')
  const { turn, timing } = buildTraceArchiveTurn(args)
  if (!timing) throw new Error('managed recorder requires authoritative Codex result timing')
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
}

async function archiveTraceTurn(args: ArchiveTraceTurnArgs): Promise<void> {
  if (!args.cwd) return
  if (!args.sessionId) {
    if (args.providerId === 'codex' && (await managedRecorderMode(args.cwd)).status === 'enabled') {
      throw new Error('managed recorder requires an authoritative Codex session id')
    }
    return
  }
  const { turn, timing } = buildTraceArchiveTurn(args)
  if (args.providerId === 'codex') {
    const mode = await managedRecorderMode(args.cwd)
    if (mode.status === 'enabled' && !timing) {
      throw new Error('managed recorder requires authoritative Codex result timing')
    }
    if (mode.status === 'enabled' && !args.providerTurnId) {
      throw new Error('managed recorder requires an authoritative Codex turn id')
    }
    if (timing) {
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
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false }
  })
  let windowShown = false
  const onIpcMessage = (_event: unknown, channel: string): void => {
    if (channel === 'app:rendererReady') showWindow()
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
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('agent:detectFast', () => {
  const supported = new Set(['claude', 'codex', 'qoder', 'opencode'])
  return detectAgentsFast().filter((agent) => supported.has(agent.id))
})

ipcMain.handle('agent:detect', async () => {
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

ipcMain.handle('agent:providerDescriptors', () => providerRegistry.describe())

ipcMain.handle('agent:recentFolders', () => recentStore().load())
ipcMain.handle('agent:removeRecentFolder', (_event, dir: string) => recentStore().remove(dir))

ipcMain.handle('agent:chooseFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || r.filePaths.length === 0) return null
  const dir = r.filePaths[0]
  recentStore().push(dir)
  setCurrentCwd(dir)
  return dir
})

ipcMain.handle('agent:clipboardImage', () => {
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

ipcMain.handle('workspace:list', (event, request: WorkspaceListRequest) => {
  assertWorkspaceSender(event.sender.id)
  return listWorkspace(request)
})
ipcMain.handle('workspace:read', (event, request: WorkspacePathRequest) => {
  assertWorkspaceSender(event.sender.id)
  return readWorkspaceFile(request)
})
ipcMain.handle('workspace:write', (event, request: WorkspaceWriteRequest) => {
  assertWorkspaceSender(event.sender.id)
  return writeWorkspaceFile(request)
})
ipcMain.handle('workspace:create', (event, request: WorkspaceCreateRequest) => {
  assertWorkspaceSender(event.sender.id)
  return createWorkspaceEntry(request)
})
ipcMain.handle('workspace:rename', (event, request: WorkspaceRenameRequest) => {
  assertWorkspaceSender(event.sender.id)
  return renameWorkspaceEntry(request)
})
ipcMain.handle('workspace:move', (event, request: WorkspaceMoveRequest) => {
  assertWorkspaceSender(event.sender.id)
  return moveWorkspaceEntry(request)
})
ipcMain.handle('workspace:trash', (event, request: WorkspacePathRequest) => {
  assertWorkspaceSender(event.sender.id)
  return trashWorkspaceEntry(request, (path) => shell.trashItem(path))
})

ipcMain.handle('agent:setCwd', (_e, dir: string) => {
  setCurrentCwd(dir)
  recentStore().push(dir)
  return dir
})

ipcMain.handle('agent:newSession', (_event, context: ProviderContext) => {
  const cwd = context?.cwd ?? currentCwd
  if (context?.providerId && cwd) {
    const key = providerContextKey(context.providerId, cwd)
    bumpSessionRevision(key)
    sessionByContext.delete(key)
  }
  return true
})

ipcMain.handle('agent:listSkills', (_e, context: ProviderContext) => providerRegistry.listSkills(context))
ipcMain.handle('agent:toggleSkill', (_e, p: { context: ProviderContext; name: string; enabled: boolean }) =>
  providerRegistry.setSkillEnabled(p.context, p.name, p.enabled)
)
ipcMain.handle('agent:mcpSnapshot', (_e, p: { context: ProviderContext; refresh?: boolean }) =>
  providerRegistry.mcpSnapshot(p.context, p.refresh)
)
ipcMain.handle('agent:testMcp', (_e, p: { context: ProviderContext; name: string }) =>
  providerRegistry.testMcp(p.context, p.name)
)
ipcMain.handle('agent:toggleMcp', (_e, p: { context: ProviderContext; name: string; enabled: boolean }) =>
  providerRegistry.setMcpEnabled(p.context, p.name, p.enabled)
)
ipcMain.handle('agent:mcpGuardScan', (_e, context: ProviderContext) => {
  if (providerRegistry.isDisabled(context.providerId)) {
    return capabilityUnavailable(context, 'unsupported', '该 Provider 已通过 SCRY_DISABLED_PROVIDERS 禁用')
  }
  if (context.providerId !== 'claude') {
    return capabilityUnavailable(context, 'unsupported', 'MCP Guard 当前只扫描 Claude Code 配置；其他 Provider 不复用 Claude 路径')
  }
  return { ...context, mode: 'read', state: 'ready', data: scanMcp({ cwd: context.cwd, home: homeDir }), observedAt: Date.now() }
})
ipcMain.handle('agent:listCommands', (_e, context: ProviderContext) => providerRegistry.listCommands(context))
ipcMain.handle('agent:providerAccount', (_e, context: ProviderContext) => providerRegistry.account(context))

// 单目录会话列表（当前工作目录）：只列 app 自己起过的会话
ipcMain.handle('agent:listSessions', (_e, context: ProviderContext) => {
  return appSessionStore().listSessions(context.cwd ?? '', context.providerId)
})

// 左侧栏 Projects 分组：只从 app 会话记录按 cwd 分组（不扫 ~/.claude/projects，不采集 terminal 会话）
ipcMain.handle('agent:listProjects', () => appSessionStore().listProjects())

// 加载一个历史会话：解析 transcript 成对话轮次，并把它设为当前会话（后续对话会 resume）
ipcMain.handle('agent:loadSession', (_e, payload: ProviderContext) => {
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
  sessionByContext.set(key, payload.externalSessionId)
  recentStore().push(payload.cwd)
  const merged = mergeSessionTurns(turns, archived)
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

// 删除一个历史会话（删 transcript 文件，不可逆）
ipcMain.handle(
  'agent:deleteSession',
  (_e, p: Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }) => {
    if (!p.cwd || !p.externalSessionId || p.providerId === 'legacy_unknown') return false
    // 从 app 会话记录移除（列表不再显示）；transcript 是 app 自己起的，一并删
    appSessionStore().remove({ providerId: p.providerId, cwd: p.cwd, externalSessionId: p.externalSessionId })
    deleteTranscriptCopies({
      cwd: p.cwd,
      sessionId: p.externalSessionId,
      providerId: p.providerId,
      userDataDir: app.getPath('userData')
    })
    const key = providerContextKey(p.providerId, p.cwd)
    if (sessionByContext.get(key) === p.externalSessionId) sessionByContext.delete(key)
    return true
  }
)

interface RunControl {
  runId: string
  providerId: ProviderId
  interrupt: () => void
  cwd?: string
  resume?: string
  getExternalSessionId: () => string | undefined
  runtimeProvider: RuntimeProvider
  runState: ActiveRun
  adoptSession: () => void
  cleanupProvisional: () => void
  finalizeTurnDiff: () => Promise<void>
  cancelTurnDiff: () => Promise<void>
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

ipcMain.handle('agent:start', async (_e, payload: AgentStartRequest) => {
  await warmShellEnv()
  const request = normalizeAgentStartRequest(payload)
  const cwd = request.cwd ?? currentCwd
  const providerId = request.providerId
  const adapter = providerRegistry.get(providerId)
  const runtimeProvider = adapter.runtimeProvider
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
  const contextKey = cwd ? providerContextKey(providerId, cwd) : undefined
  let contextRevision = contextKey ? (sessionRevisionByContext.get(contextKey) ?? 0) : 0
  const resume = contextKey ? sessionByContext.get(contextKey) : undefined
  if (
    resume &&
    runs.activeStates().some(
      (run) =>
        run.providerId === providerId &&
        run.cwd === cwd &&
        (run.externalSessionId ?? run.sessionId) === resume
    )
  ) {
    throw new AgentRuntimeError('同一会话已有一轮正在运行', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待当前轮完成，或新建独立会话后并行运行'
    })
  }
  if (providerId === 'codex' && cwd) {
    const progressRecovery = await recoverManagedTraceProgress(app.getPath('userData'), { cwd, waitMs: 250 })
    const journalRecovery = await recoverManagedTraceTurns(app.getPath('userData'), { cwd, waitMs: 250 })
    const recorderRecovery = resume
      ? await recoverManagedRecorderTurns(cwd, process.env, { sessionId: resume })
      : await recoverManagedRecorderTurns(cwd)
    // 同一轮可能同时留下 progress、journal 与 recorder open；三层计数不能相加，
    // 否则会把一个待恢复 turn 报成三轮。这里只需要 fail closed。
    const pending = Math.max(progressRecovery.pending, journalRecovery.pending, recorderRecovery.pending)
    if (pending > 0) {
      throw new AgentRuntimeError(`Scry 精确记录仍有 ${pending} 轮待恢复`, {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '保留当前工作区与 Scry Test 数据目录，先运行 scry doctor 并修复 pending canonical journal'
      })
    }
  }
  const bypassHookTrust = providerId === 'codex' && cwd
    ? await resolveCodexHookBypass(cwd)
    : false
  const runId = `run-${Date.now().toString(36)}-${runSeq++}`
  const unavailableCapture = (): GitTurnDiffCapture => {
    const beforeAt = new Date().toISOString()
    return { beforeAt, captureMs: 0, status: 'unavailable', reason: 'not_git' }
  }
  const turnDiffCapture = cwd ? beginGitTurnDiff(cwd) : Promise.resolve(unavailableCapture())
  const turnChangeJournal = cwd ? new TurnChangeJournal(cwd) : null
  const attachments = prepareRunAttachments(runId, request.attachments)
  const displayPrompt = request.prompt
  const runtimePrompt = attachmentPrompt(displayPrompt, attachments)
  const hookConfig =
    providerId === 'claude' && cwd
      ? loadClaudeHookConfig(cwd, homeDir)
      : providerId === 'codex' && cwd
        ? loadCodexHookConfig(cwd, homeDir)
        : null
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
    done: false
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
        { providerId, runtimeProvider, cwd, externalSessionId: observedSessionId, source: ev.usageSource },
        ev
      )
    }
    appendCoalescedTrace(runState.items, ev)
    if (runs.isFocused(runId)) queueTrace(ev) // 后台 run 继续归档，只把当前会话 trace 推给 UI。
  }
  if (cwd) {
    if (resume) {
      // 续接同一原生 session 时也要把侧栏元数据的 runId 更新为本轮，否则切走再点回会拿到上一轮的 stale runId。
      appSessionStore().record({
        providerId,
        runtimeProvider,
        runId,
        externalSessionId: resume,
        cwd,
        prompt: displayPrompt
      })
      win?.webContents.send('agent:session', {
        runId,
        sessionId: resume,
        externalSessionId: resume,
        providerId
      })
    } else {
      appSessionStore().recordPending({ providerId, runtimeProvider, runId, cwd, prompt: displayPrompt })
      win?.webContents.send('agent:session', { runId, sessionId: runId, providerId, pending: true })
    }
  }
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
    return turnDiffPromise
  }
  const publishSessionId = (sessionId: string | undefined): void => {
    if (!sessionId) return
    observedSessionId = sessionId
    if (contextKey && (sessionRevisionByContext.get(contextKey) ?? 0) === contextRevision) {
      sessionByContext.set(contextKey, sessionId)
    }
    if (runState.sessionId === sessionId) return
    runState.sessionId = sessionId
    runState.externalSessionId = sessionId
    if (cwd) {
      appSessionStore().record({ providerId, runtimeProvider, runId, externalSessionId: sessionId, cwd, prompt: displayPrompt })
    }
    win?.webContents.send('agent:session', {
      runId,
      sessionId,
      previousSessionId: runId,
      externalSessionId: sessionId,
      providerId
    })
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
  const runtimePromise = turnDiffCapture.then(async () => {
    if (interrupted) return { stopped: true }
    h = providerRegistry.run(providerId, {
      runId,
      prompt: runtimePrompt,
      cwd,
      resume,
      attachments,
      bypassHookTrust,
      emit,
      onExternalSessionId: publishSessionId,
      requestUserInput: (question, signal) => userQuestionBroker.request({ ...question, providerId }, signal)
    })
    if (interrupted) h.interrupt()
    return h.promise
  })
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
    cancelTurnDiff: async () => cancelGitTurnDiff(await turnDiffCapture)
  }
  runs.register(runState, control)
  runtimePromise
    .then(async (r) => {
      publishSessionId(r.externalSessionId)
      const completionStatus = r.status ?? (r.stopped ? 'interrupted' : 'completed')
      const completionArchiveArgs: ArchiveTraceTurnArgs = {
        providerId,
        runtimeProvider,
        cwd,
        sessionId: r.externalSessionId ?? resume,
        providerTurnId: r.providerTurnId,
        runId,
        userText: displayPrompt,
        attachments,
        items: runState.items,
        done: true,
        status: completionStatus
      }
      // Diff 是附加观测数据：立即开始采集，但不能阻塞用户看到 turnDone。
      // 归档仍等待它完成，保证历史回放最终包含 turn_diff。
      const turnDiffDone = finalizeTurnDiff()
      if (r.externalSessionId && cwd) {
        appSessionStore().record({
          providerId,
          runtimeProvider,
          runId,
          externalSessionId: r.externalSessionId,
          cwd,
          prompt: displayPrompt
        })
      }
      mirrorSessionTranscript(providerId, cwd, r.externalSessionId ?? resume)
      const alreadyDone = runState.done
      runState.done = true
      cleanupProvisional()
      flushTraceSend() // 先把模型/工具事件发完，再发 turnDone；turn_diff 可稍后增量到达
      try {
        // Provider 已完成时先落一份 durable canonical snapshot。若 App 在等待 Git diff
        // 期间崩溃，下一次启动仍能用同一用户输入、模型输出、调用与权威 result timing
        // 恢复 archive/CLI；diff 会明确记为 unavailable，而不是伪造零值。
        await persistManagedCompletionProgress(completionArchiveArgs)
      } catch (error) {
        const message = `模型已完成，但 Scry 精确记录快照失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = '不要开始下一轮；保留 managed-turn-progress 与 workspace/.scry 后重试恢复'
        win?.webContents.send('agent:error', {
          runId,
          message,
          category: 'recording',
          hint: runState.errorHint
        })
        return
      }
      if (providerId !== 'codex' && !alreadyDone) {
        win?.webContents.send('agent:turnDone', {
          runId,
          sessionId: r.externalSessionId,
          externalSessionId: r.externalSessionId,
          providerId,
          stopped: r.stopped
        })
      }
      await turnDiffDone
      try {
        await archiveTraceTurn(completionArchiveArgs)
      } catch (error) {
        const message = `模型已完成，但 Scry 精确记录提交失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = '不要开始下一轮；保留 managed-turn-commits 与 workspace/.scry 后重试恢复'
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
        sessionId: r.externalSessionId,
        cwd,
        userText: displayPrompt,
        items: runState.items,
        providerId,
        runtimeProvider,
        billingProvider: [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')?.billingProvider
      })
      if (providerId === 'codex' && !alreadyDone) {
        win?.webContents.send('agent:turnDone', {
          runId,
          sessionId: r.externalSessionId,
          externalSessionId: r.externalSessionId,
          providerId,
          stopped: r.stopped
        })
      }
    })
    .catch(async (err) => {
      const alreadyDone = runState.done
      const stopped = interrupted || alreadyDone
      const runtimeErr = err instanceof AgentRuntimeError ? err : null
      const message = String(err?.message ?? err)
      const classified = runtimeErr ? { category: runtimeErr.brief.stage, hint: runtimeErr.brief.nextAction } : classifyError(message)
      const { category, hint } = classified
      if (!runState.done) {
        if (!stopped && runtimeErr) {
          const result = runState.items.find((ev) => ev.kind === 'harness' && ev.stage === 'result')
          if (result) {
            result.isError = true
            result.runtimeFailureStage = runtimeErr.brief.stage
            result.runtimeMetadata = { ...(result.runtimeMetadata ?? {}), brief: runtimeErr.brief }
          } else {
            const failure = { ...runtimeFailureTrace(runId, runtimeErr), providerId, runtimeProvider }
            appendCoalescedTrace(runState.items, failure)
            if (runs.isFocused(runId)) queueTrace(failure)
          }
        }
        runState.done = true
        if (!stopped) {
          runState.error = message
          runState.errorHint = hint
        }
      }
      cleanupProvisional()
      const turnDiffDone = finalizeTurnDiff()
      mirrorSessionTranscript(providerId, cwd, h?.getExternalSessionId() ?? resume)
      flushTraceSend()
      if (stopped && providerId !== 'codex') {
        if (!alreadyDone) win?.webContents.send('agent:turnDone', { runId, stopped: true, providerId })
      } else {
        win?.webContents.send('agent:error', { runId, message, category, hint })
      }
      await turnDiffDone
      let exactRecorded = true
      try {
        await archiveTraceTurn({
          providerId,
          runtimeProvider,
          cwd,
          sessionId: h?.getExternalSessionId() ?? resume,
          providerTurnId: h?.getProviderTurnId?.(),
          runId,
          userText: displayPrompt,
          attachments,
          items: runState.items,
          done: true,
          status: stopped ? 'interrupted' : 'failed',
          ...(stopped ? {} : { error: message, errorHint: hint })
        })
      } catch (archiveError) {
        exactRecorded = false
        console.error('[scry] exact turn archive failed:', archiveError)
        if (providerId === 'codex') {
          const recordingMessage = `Scry 精确记录提交失败：${String((archiveError as Error).message)}`
          win?.webContents.send('agent:error', {
            runId,
            message: recordingMessage,
            category: 'recording',
            hint: '不要开始下一轮；保留 managed-turn-commits 与 workspace/.scry 后重试恢复'
          })
        }
      }
      recordTurn({
        runId,
        sessionId: h?.getExternalSessionId() ?? resume,
        cwd,
        userText: displayPrompt,
        items: runState.items,
        providerId,
        runtimeProvider,
        billingProvider: [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')?.billingProvider
      })
      if (stopped && providerId === 'codex' && !alreadyDone && exactRecorded) {
        win?.webContents.send('agent:turnDone', { runId, stopped: true, providerId })
      }
    })
    .finally(() => {
      userQuestionBroker.cancelRun(runId)
      runs.remove(runId)
    })
  return { runId }
})

// Renderer 重挂时拉回当前焦点或全部在途 run；焦点只影响显示，不影响后台生命周期。
ipcMain.handle('agent:activeRun', (): ActiveRun | null => runs.focusedState())
ipcMain.handle('agent:activeRuns', (): ActiveRun[] => runs.activeStates())
ipcMain.handle('agent:focusRun', (_event, runId: string | null): boolean => runs.focus(runId))
ipcMain.handle('agent:adoptActiveRun', (_event, runId: string): ActiveRun | null => {
  const entry = runs.get(runId)
  if (!entry || entry.state.done) return null
  entry.control.adoptSession()
  runs.focus(runId)
  return entry.state
})
ipcMain.handle('agent:answerQuestion', (event, response: unknown) => {
  if (!win || event.sender.id !== win.webContents.id) return false
  return userQuestionBroker.answer(response)
})

// B2：sqlite 跨会话分析（工具频率 / 按目录花费），纯文件做不到的结构化查询
ipcMain.handle('agent:stats', () => statsQuery())
ipcMain.handle('agent:billingState', async () => {
  await warmShellEnv()
  return billingStateQuery()
})
ipcMain.handle('agent:syncBillingAdmin', async () => {
  await warmShellEnv()
  return syncBillingAdmin()
})
ipcMain.handle('agent:importBillingFixture', () => importBillingFixture())

// P2 Files & Diff：cwd 的最终 git diff（vs HEAD 增删），与工具足迹对照
ipcMain.handle('agent:gitDiff', (_e, cwd: string) => gitNumstat(cwd))

// P2 Diagnostics：claude 版本（init 报）+ SDK 声明版本 + settingSources
ipcMain.handle('agent:diagnostics', () => {
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

ipcMain.handle('agent:stop', (_event, runId: string) => {
  const entry = runs.get(runId)
  if (!entry || entry.state.done) return false
  const stopping = entry.control
  stopping.interrupt()
  userQuestionBroker.cancelRun(stopping.runId)
  // A2：强制超时兜底——若 SDK 2s 内没结束（interrupt 卡住），强制通知 renderer 结束，防 UI 永久卡在运行态
  setTimeout(async () => {
    const current = runs.get(stopping.runId)
    if (current?.control !== stopping || current.state.done) return
    if (stopping.providerId === 'codex') {
      // Managed Codex 必须等 Provider settle 后再归档并提交同一份 canonical evidence。
      // 提前 turnDone 会允许下一轮覆盖唯一 open identity，因此此处宁可保持 stopping。
      void stopping.finalizeTurnDiff()
      return
    }
    // 观测采集不能破坏“2 秒强制停止”兜底；结果完成后仍会增量写回 live trace。
    void stopping.finalizeTurnDiff()
    if (runs.get(stopping.runId)?.control !== stopping) return
    stopping.runState.done = true
    stopping.cleanupProvisional()
    mirrorSessionTranscript(stopping.providerId, stopping.cwd, stopping.getExternalSessionId() ?? stopping.resume)
    flushTraceSend()
    win?.webContents.send('agent:turnDone', { runId: stopping.runId, stopped: true, providerId: stopping.providerId })
    // 控制器保留到 Provider promise 真正 settle，避免迟到 reject/error 找不到自身状态或误命中其他 run。
  }, 2000)
  return true
})

// B2-lite：累计用量统计（读 usage.jsonl 聚合）
ipcMain.handle('agent:usageStats', (_event, context?: ProviderContext) =>
  readUsageStats(app.getPath('userData'), context ? { providerId: context.providerId, cwd: context.cwd } : {})
)

app.whenReady().then(() => {
  void warmShellEnv()
  try {
    migrateLegacyUserData(app.getPath('appData'), app.getPath('userData'))
  } catch (e) {
    console.warn('[scry] legacy userData migration skipped:', (e as Error)?.message)
  }
  void recoverManagedTraceProgress(app.getPath('userData'))
    .then(async (progress) => {
      if (progress.pending > 0) console.warn('[scry] managed turn progress recovery pending:', progress)
      const journals = await recoverManagedTraceTurns(app.getPath('userData'))
      if (journals.pending > 0) console.warn('[scry] managed turn recovery pending:', journals)
    })
    .catch((error) => console.warn('[scry] managed turn startup recovery failed:', error))
  createWindow()
  setTimeout(() => initDb(), 800)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const run of runs.activeControls()) {
    userQuestionBroker.cancelRun(run.runId)
    mirrorSessionTranscript(run.providerId, run.cwd, run.getExternalSessionId() ?? run.resume)
    void run.cancelTurnDiff()
    run.interrupt()
  }
  void providerRegistry.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
