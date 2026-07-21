import { app, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { getClaudeVersion } from './agent-runner'
import { detectAgents, shellEnv } from './claude-locate'
import { AgentRuntimeError, runtimeFailureTrace } from './cli-runtime'
import { parseTranscriptToTurns, type ParsedTurn } from './normalize'
import { classifyError } from './error-classify'
import { billingStateQuery, importBillingFixture, initDb, recordTurn, setBillingEnvProvider, statsQuery, syncBillingAdmin } from './db'
import { beginGitTurnDiff, cancelGitTurnDiff, finishGitTurnDiff, gitNumstat, type GitTurnDiffCapture } from './git'
import { deleteTranscriptCopies, inferTraceArchiveProvider, mirrorTranscript, readTraceArchive, resolveTranscriptPath, upsertTraceArchiveTurn } from './transcript-archive'
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
import { attachConfiguredHookCommands, loadClaudeHookConfig } from './hook-config'
import { UserQuestionBroker, type UserQuestionChange } from './user-question'

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

const providerContextKey = (providerId: ProviderId, cwd: string): string => `${providerId}\0${cwd}`

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

function archiveTraceTurn(args: {
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  cwd: string | undefined
  sessionId: string | undefined
  runId: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done: boolean
  error?: string
  errorHint?: string
}): void {
  if (!args.cwd || !args.sessionId) return
  const persistedItems = args.items.map((event) => {
    const { hookConfiguredCommands: _currentConfig, ...persisted } = event
    return persisted
  })
  const turnEvidence = aggregateTurnEvidence({
    userText: args.userText,
    events: persistedItems,
    source: 'scry_provider_adapter'
  })
  const ok = upsertTraceArchiveTurn({
    cwd: args.cwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    runtimeProvider: args.runtimeProvider,
    userDataDir: app.getPath('userData'),
    turn: {
      runId: args.runId,
      userText: args.userText,
      attachments: args.attachments,
      items: persistedItems,
      turnEvidence,
      done: args.done,
      error: args.error,
      errorHint: args.errorHint
    }
  })
  if (!ok) console.warn('[scry] trace archive skipped:', args.cwd, args.sessionId)
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
  const showWindow = (): void => {
    if (windowShown || !win || win.isDestroyed()) return
    windowShown = true
    win.show()
  }
  win.once('ready-to-show', showWindow)
  setTimeout(showWindow, 2500)
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('agent:detect', async () => {
  const [detected, descriptors] = await Promise.all([detectAgents(), providerRegistry.describe()])
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

ipcMain.handle('agent:setCwd', (_e, dir: string) => {
  setCurrentCwd(dir)
  recentStore().push(dir)
  return dir
})

ipcMain.handle('agent:newSession', (_event, context: ProviderContext) => {
  if (context?.providerId && currentCwd) sessionByContext.delete(providerContextKey(context.providerId, currentCwd))
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
  sessionByContext.set(providerContextKey(payload.providerId, payload.cwd), payload.externalSessionId)
  recentStore().push(payload.cwd)
  const merged = mergeSessionTurns(turns, archived)
  if (payload.providerId !== 'claude') return merged
  const hookConfig = loadClaudeHookConfig(payload.cwd, homeDir)
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

let active: {
  runId: string
  providerId: ProviderId
  interrupt: () => void
  cwd?: string
  resume?: string
  getExternalSessionId: () => string | undefined
  runtimeProvider: RuntimeProvider
  runState: ActiveRun
  finalizeTurnDiff: () => Promise<void>
  cancelTurnDiff: () => Promise<void>
} | null = null
// B1：缓冲当前 run 的事件流，供 renderer 重挂（HMR/窗口 reload）时拉回在途 trace。
let liveRun: ActiveRun | null = null
const userQuestionBroker = new UserQuestionBroker((change: UserQuestionChange) => {
  if (change.kind === 'open') {
    if (liveRun?.runId === change.request.runId) {
      liveRun.pendingQuestions = [
        ...(liveRun.pendingQuestions ?? []).filter((item) => item.questionId !== change.request.questionId),
        change.request
      ]
    }
    win?.webContents.send('agent:userQuestion', change.request)
    return
  }
  if (liveRun?.runId === change.runId) {
    liveRun.pendingQuestions = (liveRun.pendingQuestions ?? []).filter((item) => item.questionId !== change.questionId)
  }
  win?.webContents.send('agent:userQuestionClosed', change)
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
  const request = normalizeAgentStartRequest(payload)
  const cwd = currentCwd
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
  const runId = `run-${Date.now().toString(36)}-${runSeq++}`
  const unavailableCapture = (): GitTurnDiffCapture => {
    const beforeAt = new Date().toISOString()
    return { beforeAt, captureMs: 0, status: 'unavailable', reason: 'not_git' }
  }
  const turnDiffCapture = cwd ? await beginGitTurnDiff(cwd) : unavailableCapture()
  const resume = cwd ? sessionByContext.get(providerContextKey(providerId, cwd)) : undefined
  const attachments = prepareRunAttachments(runId, request.attachments)
  const displayPrompt = request.prompt
  const runtimePrompt = attachmentPrompt(displayPrompt, attachments)
  const hookConfig = providerId === 'claude' && cwd ? loadClaudeHookConfig(cwd, homeDir) : null
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
  const emit = (rawEvent: TraceEvent): void => {
    const ev = hookConfig ? attachConfiguredHookCommands(rawEvent, hookConfig) : rawEvent
    if (ev.kind === 'harness' && ev.stage === 'result') {
      appendUsage(
        app.getPath('userData'),
        { providerId, runtimeProvider, cwd, externalSessionId: observedSessionId, source: ev.usageSource },
        ev
      )
    }
    appendCoalescedTrace(runState.items, ev)
    if (liveRun === runState) queueTrace(ev) // 迟到旧 run 只归档到自己的 state，不污染当前 UI
  }
  liveRun = runState
  let turnDiffPromise: Promise<void> | null = null
  const finalizeTurnDiff = (): Promise<void> => {
    turnDiffPromise ??= finishGitTurnDiff(turnDiffCapture).then((turnDiff) => {
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
      if (liveRun === runState) queueTrace(event)
      if (turnDiff.status === 'failed' || turnDiff.status === 'timeout') {
        console.warn('[scry] turn diff capture degraded:', runId, turnDiff.reason, turnDiff.captureMs)
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
    if (cwd) sessionByContext.set(providerContextKey(providerId, cwd), sessionId)
    if (runState.sessionId === sessionId) return
    runState.sessionId = sessionId
    runState.externalSessionId = sessionId
    if (liveRun !== runState) return
    win?.webContents.send('agent:session', { runId, sessionId, externalSessionId: sessionId, providerId })
  }
  let h: {
    promise: Promise<{ externalSessionId?: string; stopped?: boolean }>
    interrupt: () => void
    getExternalSessionId: () => string | undefined
  }
  try {
    h = providerRegistry.run(providerId, {
      runId,
      prompt: runtimePrompt,
      cwd,
      resume,
      attachments,
      emit,
      onExternalSessionId: publishSessionId,
      requestUserInput: (question, signal) => userQuestionBroker.request(question, signal)
    })
  } catch (err) {
    h = {
      promise: Promise.reject(err),
      interrupt: () => {},
      getExternalSessionId: () => undefined
    }
  }
  active = {
    runId,
    providerId,
    interrupt: h.interrupt,
    cwd,
    resume,
    getExternalSessionId: h.getExternalSessionId,
    runtimeProvider,
    runState,
    finalizeTurnDiff,
    cancelTurnDiff: () => cancelGitTurnDiff(turnDiffCapture)
  }
  h.promise
    .then(async (r) => {
      publishSessionId(r.externalSessionId)
      // Diff 是附加观测数据：立即开始采集，但不能阻塞用户看到 turnDone。
      // 归档仍等待它完成，保证历史回放最终包含 turn_diff。
      const turnDiffDone = finalizeTurnDiff()
      if (r.externalSessionId && cwd) {
        appSessionStore().record({ providerId, runtimeProvider, externalSessionId: r.externalSessionId, cwd, prompt: displayPrompt })
      }
      mirrorSessionTranscript(providerId, cwd, r.externalSessionId ?? resume)
      runState.done = true
      flushTraceSend() // 先把模型/工具事件发完，再发 turnDone；turn_diff 可稍后增量到达
      win?.webContents.send('agent:turnDone', {
        runId,
        sessionId: r.externalSessionId,
        externalSessionId: r.externalSessionId,
        providerId,
        stopped: r.stopped
      })
      await turnDiffDone
      archiveTraceTurn({
        providerId,
        runtimeProvider,
        cwd,
        sessionId: r.externalSessionId ?? resume,
        runId,
        userText: displayPrompt,
        attachments,
        items: runState.items,
        done: true
      })
      // B2：把这一轮的 turn + tool_calls 结构化落 sqlite（liveRun 已缓冲全部事件）
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
    })
    .catch(async (err) => {
      const runtimeErr = err instanceof AgentRuntimeError ? err : null
      const message = String(err?.message ?? err)
      const classified = runtimeErr ? { category: runtimeErr.brief.stage, hint: runtimeErr.brief.nextAction } : classifyError(message)
      const { category, hint } = classified
      if (!runState.done) {
        if (runtimeErr) {
          const result = runState.items.find((ev) => ev.kind === 'harness' && ev.stage === 'result')
          if (result) {
            result.isError = true
            result.runtimeFailureStage = runtimeErr.brief.stage
            result.runtimeMetadata = { ...(result.runtimeMetadata ?? {}), brief: runtimeErr.brief }
          } else {
            const failure = { ...runtimeFailureTrace(runId, runtimeErr), providerId, runtimeProvider }
            appendCoalescedTrace(runState.items, failure)
            if (liveRun === runState) queueTrace(failure)
          }
        }
        runState.done = true
        runState.error = message
        runState.errorHint = hint
      }
      const turnDiffDone = finalizeTurnDiff()
      mirrorSessionTranscript(providerId, cwd, h.getExternalSessionId() ?? resume)
      flushTraceSend()
      win?.webContents.send('agent:error', { runId, message, category, hint })
      await turnDiffDone
      archiveTraceTurn({
        providerId,
        runtimeProvider,
        cwd,
        sessionId: h.getExternalSessionId() ?? resume,
        runId,
        userText: displayPrompt,
        attachments,
        items: runState.items,
        done: true,
        error: message,
        errorHint: hint
      })
      recordTurn({
        runId,
        sessionId: h.getExternalSessionId() ?? resume,
        cwd,
        userText: displayPrompt,
        items: runState.items,
        providerId,
        runtimeProvider,
        billingProvider: [...runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')?.billingProvider
      })
    })
    .finally(() => {
      userQuestionBroker.cancelRun(runId)
      if (active?.runId === runId) active = null
    })
  return { runId }
})

// B1：renderer 重挂时拉回在途 run 的快照（done 的不返回 done 态由 renderer 自行判断是否恢复）
ipcMain.handle('agent:activeRun', (): ActiveRun | null => liveRun)
ipcMain.handle('agent:answerQuestion', (event, response: unknown) => {
  if (!win || event.sender.id !== win.webContents.id) return false
  return userQuestionBroker.answer(response)
})

// B2：sqlite 跨会话分析（工具频率 / 按目录花费），纯文件做不到的结构化查询
ipcMain.handle('agent:stats', () => statsQuery())
ipcMain.handle('agent:billingState', () => billingStateQuery())
ipcMain.handle('agent:syncBillingAdmin', () => syncBillingAdmin())
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

ipcMain.handle('agent:stop', () => {
  const stopping = active
  active?.interrupt()
  if (stopping) userQuestionBroker.cancelRun(stopping.runId)
  // A2：强制超时兜底——若 SDK 2s 内没结束（interrupt 卡住），强制通知 renderer 结束，防 UI 永久卡在运行态
  if (stopping) {
    setTimeout(async () => {
      if (active?.runId === stopping.runId) {
        // 观测采集不能破坏“2 秒强制停止”兜底；结果完成后仍会增量写回 live trace。
        void stopping.finalizeTurnDiff()
        if (active?.runId !== stopping.runId) return
        stopping.runState.done = true
        mirrorSessionTranscript(stopping.providerId, stopping.cwd, stopping.getExternalSessionId() ?? stopping.resume)
        flushTraceSend()
        win?.webContents.send('agent:turnDone', { runId: stopping.runId, stopped: true })
        active = null
      }
    }, 2000)
  }
  return true
})

// B2-lite：累计用量统计（读 usage.jsonl 聚合）
ipcMain.handle('agent:usageStats', (_event, context?: ProviderContext) =>
  readUsageStats(app.getPath('userData'), context ? { providerId: context.providerId, cwd: context.cwd } : {})
)

app.whenReady().then(() => {
  try {
    migrateLegacyUserData(app.getPath('appData'), app.getPath('userData'))
  } catch (e) {
    console.warn('[scry] legacy userData migration skipped:', (e as Error)?.message)
  }
  createWindow()
  setTimeout(() => initDb(), 800)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (active) userQuestionBroker.cancelRun(active.runId)
  if (active) mirrorSessionTranscript(active.providerId, active.cwd, active.getExternalSessionId() ?? active.resume)
  if (active) void active.cancelTurnDiff()
  void providerRegistry.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
