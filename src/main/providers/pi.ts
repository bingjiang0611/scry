import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { billingProviderForUpstream } from '../../shared/billing'
import {
  capabilityReady,
  capabilityUnavailable,
  type ProviderCommand,
  type ProviderContext,
  type ProviderDescriptor,
  type SkillMeta
} from '../../shared/provider'
import {
  classifyRunTermination,
  type AgentQuestionRequest,
  type AgentQuestionResponse,
  type AgentRunControlCatalog
} from '../../shared/runtime'
import {
  classifyTool,
  contextUsageEvidence,
  fileOpOf,
  mcpPayloadFailed,
  parseMcp,
  type ModelUsageRow,
  type TraceEvent
} from '../../shared/trace'
import { AgentRuntimeError } from '../run-outcome'
import { execFileText, resolveCommandOnPath, sanitizeProviderEnv, shellEnv } from '../claude-locate'
import type { PiAgentProfile } from '../pi-agent-profiles'
import type { ParsedTurn } from '../normalize'
import { cancelManagedRecorderTurn } from '../../core/turn-recorder/managed'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'
import { effortOption } from './run-controls'
import { completedPiTurnForkTarget } from './session-fork-boundary'
import type { ProviderAdapter, ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'

type JsonRecord = Record<string, unknown>

const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonRecord
  : {}
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const bounded = (value: unknown, max = 200_000): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated by Scry]`
}

const PI_BOOTSTRAP_MAX_BYTES = 64 * 1024

function packagePiExecutable(executable: string): string | undefined {
  let canonical: string
  try {
    canonical = realpathSync(executable)
    const stat = statSync(canonical)
    if (!stat.isFile()) return undefined
    accessSync(canonical, constants.X_OK)
  } catch {
    return undefined
  }
  let directory = dirname(canonical)
  for (;;) {
    try {
      const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        bin?: { pi?: unknown }
      }
      if (typeof packageJson.bin?.pi === 'string') {
        const declared = realpathSync(join(directory, packageJson.bin.pi))
        if (declared === canonical) return canonical
      }
    } catch {
      // Continue toward the filesystem root; wrappers and source checkouts may have unrelated package.json files.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function piRuntimeFromBootstrap(bootstrap: string): string | undefined {
  const packaged = packagePiExecutable(bootstrap)
  if (packaged) return packaged
  try {
    const stat = statSync(bootstrap)
    if (!stat.isFile() || stat.size > PI_BOOTSTRAP_MAX_BYTES) return undefined
    const source = readFileSync(bootstrap, 'utf8')
    const configured = source.match(/^\s*:\s*["']\$\{PI_AGENT_PI:=(\/[^\r\n}"']+)}["']\s*$/m)?.[1] ??
      source.match(/^\s*(?:export\s+)?PI_AGENT_PI\s*=\s*["']?(\/[^\r\n"']+?)["']?\s*(?:\\)?\s*$/m)?.[1]
    return configured ? packagePiExecutable(configured) : undefined
  } catch {
    return undefined
  }
}

function compatibleNodeVersion(raw: string): boolean {
  const [major, minor] = raw.trim().split('.').map(Number)
  return major > 23 || (major === 23 && minor >= 6)
}

function compatiblePiNode(pathValue: string): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = resolveCommandOnPath('node', directory)
    if (!candidate) continue
    try {
      const version = execFileSync(candidate, ['-p', 'process.versions.node'], {
        encoding: 'utf8',
        timeout: 1_500
      })
      if (compatibleNodeVersion(version)) return realpathSync(candidate)
    } catch {
      // Keep scanning: version-manager PATHs commonly contain an older Node before the active one.
    }
  }
  return undefined
}

async function compatiblePiNodeAsync(pathValue: string): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = resolveCommandOnPath('node', directory)
    if (!candidate) continue
    const version = await execFileText(candidate, ['-p', 'process.versions.node'], { timeout: 1_500 })
    if (compatibleNodeVersion(version)) return realpathSync(candidate)
  }
  return undefined
}

function completePiEnvironment(profile: PiAgentProfile, env: Record<string, string>): Record<string, string> {
  if (basename(profile.executable) !== 'pi-agent') return env
  if (env.PI_AGENT_PI) return env
  const verified = env.PI_AGENT_VERIFIED_PI_EXECUTABLE
    ? packagePiExecutable(env.PI_AGENT_VERIFIED_PI_EXECUTABLE)
    : undefined
  const onPath = resolveCommandOnPath('pi', env.PATH ?? '')
  const runtime = verified ?? (onPath ? piRuntimeFromBootstrap(onPath) : undefined)
  if (runtime) env.PI_AGENT_PI = runtime
  return env
}

function pinPiLauncherNode(
  profile: PiAgentProfile,
  env: Record<string, string>,
  compatibleNode: string | undefined
): void {
  if (!compatibleNode) return
  if (!env.PI_AGENT_NODE) env.PI_AGENT_NODE = compatibleNode
  if (basename(profile.executable) === 'rotom' && !env.ROTOM_NODE) env.ROTOM_NODE = compatibleNode
}

export function piRpcEnvironment(
  profile: PiAgentProfile,
  baseEnv: Record<string, string> = shellEnv()
): Record<string, string> {
  const env = sanitizeProviderEnv(baseEnv, 'pi')
  const compatibleNode = env.PI_AGENT_NODE ?? compatiblePiNode(env.PATH ?? '')
  pinPiLauncherNode(profile, env, compatibleNode)
  return completePiEnvironment(profile, env)
}

export async function piVersionProbeEnvironment(
  profile: PiAgentProfile,
  baseEnv: Record<string, string> = shellEnv()
): Promise<Record<string, string>> {
  const env = sanitizeProviderEnv(baseEnv, 'pi')
  // Finder 的 PATH 常先命中旧 Node；异步寻找兼容版本，避免扫描时阻塞 Electron 主线程。
  const compatibleNode = env.PI_AGENT_NODE ?? await compatiblePiNodeAsync(env.PATH ?? '')
  pinPiLauncherNode(profile, env, compatibleNode)
  return completePiEnvironment(profile, env)
}

let eventCounter = 0
const piEvent = (runId: string, fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>): TraceEvent => ({
  id: `pi-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`,
  runId,
  ts: new Date().toISOString(),
  ...fields
})

class PiRpcProcess {
  private readonly pending = new Map<string, {
    resolve: (response: JsonRecord) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    command: string
  }>()
  private readonly listeners = new Set<(event: JsonRecord) => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()
  private buffer = ''
  private stderr = ''
  private requestSeq = 0
  private failed: Error | null = null
  private closing = false
  private stdoutBytes = 0

  private constructor(readonly child: ChildProcessWithoutNullStreams, readonly profile: PiAgentProfile) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.feed(chunk))
    child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_384) })
    child.on('error', (error) => this.fail(error))
    child.on('close', (code, signal) => {
      if (this.buffer.trim() && !this.failed) this.fail(new Error('Pi RPC stdout 以不完整 JSONL 结束'))
      if (!this.closing && !this.failed) {
        this.fail(new Error(`Pi RPC 进程提前退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）：${this.stderr.trim()}`))
      }
    })
  }

  static start(profile: PiAgentProfile, args: string[], cwd?: string): PiRpcProcess {
    const child = spawn(profile.executable, args, {
      cwd: cwd || homedir(),
      env: piRpcEnvironment(profile),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return new PiRpcProcess(child, profile)
  }

  private feed(chunk: string): void {
    this.stdoutBytes += Buffer.byteLength(chunk, 'utf8')
    if (this.stdoutBytes > 64 * 1024 * 1024) {
      this.fail(new Error('Pi RPC stdout 超过 64 MiB 安全上限'))
      this.terminate()
      return
    }
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > 16 * 1024 * 1024) {
      this.fail(new Error('Pi RPC 单行超过 16 MiB 安全上限'))
      this.terminate()
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (!raw) continue
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        this.fail(new Error(`Pi RPC stdout 包含非 JSONL 内容：${raw.slice(0, 240)}`))
        this.terminate()
        return
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        this.fail(new Error('Pi RPC 返回了非对象 JSON 行'))
        this.terminate()
        return
      }
      const message = value as JsonRecord
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.success === false) {
            pending.reject(new PiRpcCommandError(pending.command, String(message.error ?? 'Pi RPC command failed')))
          }
          else pending.resolve(message)
          continue
        }
      }
      for (const listener of this.listeners) listener(message)
    }
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of this.failureListeners) listener(error)
  }

  onEvent(listener: (event: JsonRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void {
    if (this.failed) listener(this.failed)
    else this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  send(command: JsonRecord, timeoutMs = 15_000): Promise<JsonRecord> {
    if (this.failed) return Promise.reject(this.failed)
    const id = `scry-${++this.requestSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC ${String(command.type ?? 'command')} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, command: String(command.type ?? 'command') })
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  notify(message: JsonRecord): void {
    if (!this.failed && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    this.closing = true
    this.child.stdin.end()
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('close', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 750))
    ])
    if (this.child.exitCode == null && this.child.signalCode == null) this.terminate()
  }

  terminate(): void {
    this.closing = true
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGTERM')
      else this.child.kill('SIGTERM')
    } catch {
      try { this.child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  abort(): void {
    this.fail(new Error('Pi RPC 已被用户中止'))
    this.terminate()
  }

  forceTerminate(): void {
    this.closing = true
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGKILL')
      else this.child.kill('SIGKILL')
    } catch {
      try { this.child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }

  stderrTail(): string {
    return this.stderr
  }
}

class PiRpcCommandError extends Error {
  constructor(readonly command: string, message: string) {
    super(message)
    this.name = 'PiRpcCommandError'
  }
}

interface PiProbe {
  state: JsonRecord
  models: JsonRecord[]
  levels: string[]
  commands: JsonRecord[]
}

interface PiEntrySnapshot {
  entries: JsonRecord[]
  leafId: string | null
  appendCursor: string | null
}

interface PiRunState {
  stopped: boolean
  sessionId?: string
  providerTurnId?: string
  rpc?: PiRpcProcess
}

function piEntrySnapshot(response: JsonRecord): PiEntrySnapshot {
  const data = record(response.data)
  const rows = data.entries
  const leafId = data.leafId
  if (!Array.isArray(rows) || !(leafId === null || typeof leafId === 'string')) {
    throw new Error('Pi RPC get_entries 返回了无效 session entry 快照')
  }
  const entries = rows.map(record)
  const entryIds = entries.map((entry) => entry.id)
  if (entryIds.some((id) => typeof id !== 'string' || !id) || new Set(entryIds).size !== entryIds.length) {
    throw new Error('Pi RPC get_entries 返回了无效或重复的 session entry id')
  }
  if (leafId === null && entries.length > 0) {
    throw new Error('Pi RPC get_entries 的空 leaf 与非空 entries 冲突')
  }
  if (leafId !== null && !entries.some((entry) => entry.id === leafId)) {
    throw new Error('Pi RPC get_entries 的 leafId 不在 session entries 中')
  }
  return { entries, leafId, appendCursor: entries.length > 0 ? entryIds.at(-1) as string : null }
}

function isUserMessageEntry(entry: JsonRecord): boolean {
  return entry.type === 'message' && record(entry.message).role === 'user'
}

export function piUserEntryIdAfterBaseline(baselineLeafId: string | null, entries: JsonRecord[]): string | null {
  const candidates = entries.filter(isUserMessageEntry)
  if (candidates.length === 0) return null
  if (candidates.length !== 1) throw new Error('Pi RPC prompt 对应多个新增 user session entries')
  const candidate = candidates[0]
  if (typeof candidate.id !== 'string' || !candidate.id) {
    throw new Error('Pi RPC prompt 的 user session entry 缺少稳定 id')
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  let parentId = candidate.parentId
  const visited = new Set<string>()
  while (parentId !== baselineLeafId) {
    if (typeof parentId !== 'string' || !parentId || visited.has(parentId)) {
      throw new Error('Pi RPC user session entry 无法回溯到 prompt 前冻结的 active leaf')
    }
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) throw new Error('Pi RPC user session entry 的新增 ancestry 不完整')
    parentId = parent.parentId
  }
  return candidate.id
}

async function piEntryBaseline(rpc: PiRpcProcess): Promise<PiEntrySnapshot> {
  return piEntrySnapshot(await rpc.send({ type: 'get_entries' }))
}

async function waitForPiUserEntryId(
  rpc: PiRpcProcess,
  baseline: PiEntrySnapshot,
  timeoutMs = 5_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await rpc.send({
      type: 'get_entries',
      ...(baseline.appendCursor ? { since: baseline.appendCursor } : {})
    })
    const data = record(response.data)
    const rows = data.entries
    if (!Array.isArray(rows)) throw new Error('Pi RPC get_entries 返回了无效增量 entries')
    const id = piUserEntryIdAfterBaseline(baseline.leafId, rows.map(record))
    if (id) return id
    if (Date.now() >= deadline) throw new Error('Pi RPC prompt 已接受，但未出现 authoritative user session entry')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function explicitPiSkill(prompt: string): { command: string; name: string } | null {
  const match = prompt.match(/^\/skill:([A-Za-z0-9._-]+)(?:\s|$)/)
  return match ? { command: `skill:${match[1]}`, name: match[1] } : null
}

async function proveExplicitPiSkill(rpc: PiRpcProcess, request: ProviderRunRequest): Promise<TraceEvent | null> {
  const mention = explicitPiSkill(request.prompt)
  if (!mention) return null
  const rows = record((await rpc.send({ type: 'get_commands' })).data).commands
  const commands = Array.isArray(rows) ? rows.map(record) : []
  const skill = commands.find((command) => command.name === mention.command && command.source === 'skill')
  if (!skill) throw new Error(`Pi 命令目录未证明 /${mention.command} 是可用 Skill`)
  const sourceInfo = record(skill.sourceInfo)
  return piEvent(request.runId, {
    kind: 'skill',
    stage: `skill:${mention.name}`,
    tool: 'Skill',
    name: mention.name,
    input: {
      source: 'explicit_user_input',
      path: sourceInfo.path ?? skill.path ?? null,
      scope: sourceInfo.scope ?? skill.location ?? null
    }
  })
}

function piRpcArgs(options: { noSession?: boolean; session?: string; offline?: boolean } = {}): string[] {
  // Pi project trust is independent from Scry's full-access run mode. Do not pass
  // --approve/--no-approve: RPC should honor Pi's saved/default project trust so
  // catalogs and runs agree without silently trusting repository-controlled resources.
  return [
    '--mode', 'rpc',
    ...(options.noSession ? ['--no-session'] : []),
    ...(options.session ? ['--session', options.session] : []),
    ...(options.offline ? ['--offline'] : [])
  ]
}

async function withPiRpc<T>(
  profile: PiAgentProfile,
  cwd: string | undefined,
  args: string[],
  operation: (rpc: PiRpcProcess) => Promise<T>
): Promise<T> {
  const rpc = PiRpcProcess.start(profile, args, cwd)
  try {
    return await operation(rpc)
  } finally {
    await rpc.close()
  }
}

export async function probePiAgent(profile: PiAgentProfile, cwd?: string): Promise<PiProbe> {
  return withPiRpc(profile, cwd, piRpcArgs({ noSession: true, offline: true }), async (rpc) => {
    const [state, models, levels, commands] = await Promise.all([
      rpc.send({ type: 'get_state' }),
      rpc.send({ type: 'get_available_models' }),
      rpc.send({ type: 'get_available_thinking_levels' }),
      rpc.send({ type: 'get_commands' })
    ])
    const modelRows = record(models.data).models
    const thinkingLevels = record(levels.data).levels
    const commandRows = record(commands.data).commands
    return {
      state: record(state.data),
      models: Array.isArray(modelRows) ? modelRows.map(record) : [],
      levels: Array.isArray(thinkingLevels)
        ? thinkingLevels.filter((level): level is string => typeof level === 'string')
        : [],
      commands: Array.isArray(commandRows) ? commandRows.map(record) : []
    }
  })
}

function commandCatalog(probe: PiProbe): ProviderCommand[] {
  return probe.commands.flatMap((command) => {
    if (typeof command.name !== 'string' || !command.name) return []
    const source = command.source === 'skill'
      ? 'skill' as const
      : command.source === 'prompt'
        ? 'custom' as const
        : 'custom' as const
    return [{
      name: command.name,
      description: typeof command.description === 'string' ? command.description : '',
      source
    }]
  })
}

function skillCatalog(probe: PiProbe): SkillMeta[] {
  return probe.commands.flatMap((command) => {
    if (command.source !== 'skill' || typeof command.name !== 'string' || !command.name) return []
    const sourceInfo = record(command.sourceInfo)
    const path = typeof sourceInfo.path === 'string'
      ? sourceInfo.path
      : typeof command.path === 'string'
        ? command.path
        : ''
    const scope = typeof sourceInfo.scope === 'string'
      ? sourceInfo.scope
      : typeof command.location === 'string'
        ? command.location
        : 'unknown'
    return [{
      name: command.name.replace(/^skill:/, ''),
      dir: path ? dirname(path) : '',
      scope,
      description: typeof command.description === 'string' ? command.description : '',
      enabled: true
    }]
  })
}

function piModelContextWindows(models: JsonRecord[]): Map<string, number> {
  const windows = new Map<string, number>()
  for (const model of models) {
    const provider = typeof model.provider === 'string' ? model.provider : undefined
    const id = typeof model.id === 'string' ? model.id : undefined
    const contextWindow = number(model.contextWindow)
    if (provider && id && contextWindow != null && contextWindow > 0) {
      windows.set(`${provider}\0${id}`, contextWindow)
    }
  }
  return windows
}

function piHistoryNeedsModelCatalog(turns: ParsedTurn[]): boolean {
  return turns.some((turn) => turn.items.some((event) => {
    if (event.kind !== 'harness' || event.stage !== 'result' || event.contextTokens == null) return false
    if (contextUsageEvidence(event)) return false
    const model = event.contextModel ?? (event.modelUsage?.length === 1 ? event.modelUsage[0].model : undefined)
    const provider = event.upstreamProvider ?? (typeof event.runtimeMetadata?.provider === 'string' ? event.runtimeMetadata.provider : undefined)
    return Boolean(model && provider)
  }))
}

function enrichPiHistory(turns: ParsedTurn[], windows: ReadonlyMap<string, number>): ParsedTurn[] {
  if (windows.size === 0) return turns
  return turns.map((turn) => ({
    ...turn,
    items: turn.items.map((event) => {
      if (event.kind !== 'harness' || event.stage !== 'result' || event.contextTokens == null) return event
      if (contextUsageEvidence(event)) return event
      const model = event.contextModel ?? (event.modelUsage?.length === 1 ? event.modelUsage[0].model : undefined)
      const provider = event.upstreamProvider ?? (typeof event.runtimeMetadata?.provider === 'string' ? event.runtimeMetadata.provider : undefined)
      if (!model || !provider) return event
      const contextWindow = windows.get(`${provider}\0${model}`)
      if (!contextWindow) return event
      return {
        ...event,
        contextModel: model,
        contextProvider: provider,
        contextUsageSource: 'pi_rpc_archive_usage+current_model_catalog',
        contextUsageQuality: 'inferred',
        modelUsage: (event.modelUsage ?? [{ model, upstreamProvider: provider, usageSource: 'pi_rpc' }]).map((row) =>
          row.model === model && (!row.upstreamProvider || row.upstreamProvider === provider)
            ? { ...row, upstreamProvider: row.upstreamProvider ?? provider, contextWindow }
            : row
        )
      }
    })
  }))
}

function runControlCatalog(probe: PiProbe): AgentRunControlCatalog {
  const current = record(probe.state.model)
  const currentKey = `${String(current.provider ?? '')}\0${String(current.id ?? '')}`
  return {
    models: probe.models.flatMap((model) => {
      if (typeof model.id !== 'string' || typeof model.provider !== 'string') return []
      const key = `${model.provider}\0${model.id}`
      const levelMap = record(model.thinkingLevelMap)
      const levels = key === currentKey
        ? probe.levels
        : model.reasoning === true
          ? [...new Set([
              'off', 'minimal', 'low', 'medium', 'high',
              ...Object.entries(levelMap).filter(([, value]) => value !== null).map(([level]) => level)
            ])]
          : ['off']
      return [{
        model: { id: model.id, providerId: model.provider },
        label: typeof model.name === 'string' ? model.name : model.id,
        ...(key === currentKey ? { isDefault: true } : {}),
        efforts: levels.map((level) => effortOption(level, undefined, level === probe.state.thinkingLevel))
      }]
    }),
    permissions: [{
      id: 'full_access',
      label: '本机完全访问',
      description: 'Pi 没有内置沙箱；launcher、Extension 与工具继承当前本机用户权限'
    }]
  }
}

function questionFromExtension(runId: string, event: JsonRecord): AgentQuestionRequest | null {
  const id = typeof event.id === 'string' ? event.id : ''
  const method = String(event.method ?? '')
  if (!id || !['select', 'confirm', 'input', 'editor'].includes(method)) return null
  const title = String(event.title ?? 'Pi Extension').slice(0, 120)
  const question = method === 'confirm'
    ? String(event.message ?? title)
    : method === 'editor'
      ? '请输入多行内容'
      : method === 'input'
        ? String(event.placeholder ?? '请输入内容')
        : title
  const labels = method === 'confirm'
    ? ['确认', '取消']
    : Array.isArray(event.options)
      ? event.options.filter((item): item is string => typeof item === 'string').slice(0, 100)
      : []
  return {
    runId,
    questionId: id,
    providerId: 'pi',
    questionKind: 'clarification',
    source: `pi_extension_ui:${method}`,
    questions: [{
      header: title,
      question: question.slice(0, 2_000),
      multiSelect: false,
      options: labels.map((label) => ({ label, description: method === 'confirm' ? `${label}这次操作` : '选择此项' }))
    }]
  }
}

function extensionResponse(
  event: JsonRecord,
  question: AgentQuestionRequest,
  response: AgentQuestionResponse
): JsonRecord {
  if (response.behavior === 'cancelled') return { type: 'extension_ui_response', id: event.id, cancelled: true }
  const answer = response.answers[question.questions[0].question] ?? ''
  return event.method === 'confirm'
    ? { type: 'extension_ui_response', id: event.id, confirmed: answer === '确认' }
    : { type: 'extension_ui_response', id: event.id, value: answer }
}

interface UsageAggregate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
  allCostKnown: boolean
  byModel: Map<string, ModelUsageRow>
  lastContextTokens?: number
  lastContextModel?: string
  lastContextProvider?: string
  contextUsageSource?: string
  contextUsageQuality?: 'exact' | 'inferred'
  lastStopReason?: string
  lastError?: string
  upstreamProvider?: string
  model?: string
}

function addAssistantUsage(
  aggregate: UsageAggregate,
  message: JsonRecord,
  contextWindows: ReadonlyMap<string, number>
): void {
  const usage = record(message.usage)
  const input = number(usage.input)
  const output = number(usage.output)
  const cacheRead = number(usage.cacheRead)
  const cacheWrite = number(usage.cacheWrite)
  const reasoning = number(usage.reasoning)
  const cost = number(record(usage.cost).total)
  const model = typeof message.model === 'string' ? message.model : 'unknown'
  const provider = typeof message.provider === 'string' ? message.provider : undefined
  const key = `${provider ?? ''}\0${model}`
  aggregate.input += input ?? 0
  aggregate.output += output ?? 0
  aggregate.cacheRead += cacheRead ?? 0
  aggregate.cacheWrite += cacheWrite ?? 0
  aggregate.reasoning += reasoning ?? 0
  if ([input, cacheRead, cacheWrite].some((value) => value != null)) {
    const billingProvider = billingProviderForUpstream(provider)
    aggregate.lastContextTokens = billingProvider === 'codex' || billingProvider === 'openai'
      ? (input ?? 0)
      : (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    aggregate.lastContextModel = model
    aggregate.lastContextProvider = provider
    aggregate.contextUsageSource = 'pi_rpc_assistant_usage'
    aggregate.contextUsageQuality = 'exact'
  }
  if (cost == null) aggregate.allCostKnown = false
  else aggregate.cost += cost
  const existing = aggregate.byModel.get(key) ?? {
    model,
    billingProvider: billingProviderForUpstream(provider),
    upstreamProvider: provider,
    usageSource: 'pi_rpc'
  }
  existing.contextWindow = contextWindows.get(key) ?? existing.contextWindow
  existing.inputTokens = (existing.inputTokens ?? 0) + (input ?? 0)
  existing.outputTokens = (existing.outputTokens ?? 0) + (output ?? 0)
  existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (cacheRead ?? 0)
  existing.cacheCreationTokens = (existing.cacheCreationTokens ?? 0) + (cacheWrite ?? 0)
  existing.reasoningTokens = (existing.reasoningTokens ?? 0) + (reasoning ?? 0)
  if (cost != null) {
    existing.costUsd = (existing.costUsd ?? 0) + cost
    existing.costSource = 'provider_reported'
    existing.costConfidence = 'provider_reported'
    existing.costUnit = 'usd'
  }
  aggregate.byModel.set(key, existing)
  aggregate.upstreamProvider = provider
  aggregate.model = model
  aggregate.lastStopReason = typeof message.stopReason === 'string' ? message.stopReason : aggregate.lastStopReason
  aggregate.lastError = typeof message.errorMessage === 'string' ? message.errorMessage : aggregate.lastError
}

async function runPiAgent(
  profile: PiAgentProfile,
  request: ProviderRunRequest,
  state: PiRunState
): Promise<ProviderRunResult> {
  if (request.permissionMode !== 'full_access') {
    throw new AgentRuntimeError('Pi 只支持显式选择“本机完全访问”后运行', {
      provider: 'pi_rpc',
      stage: 'frontdoor',
      cwd: request.cwd,
      nextAction: '在权限选择器中选择“本机完全访问”；Pi 没有可映射的内置沙箱或审批模式'
    })
  }
  const args = piRpcArgs({ session: request.resume })
  const rpc = PiRpcProcess.start(profile, args, request.cwd)
  state.rpc = rpc
  const usage: UsageAggregate = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    allCostKnown: true,
    byModel: new Map()
  }
  const modelContextWindows = new Map<string, number>()
  const abortController = new AbortController()
  const toolNames = new Map<string, string>()
  const toolStarts = new Map<string, number>()
  let streamedText = false
  let streamedThinking = false
  let assistantMessageSequence = 0
  let assistantMessageId: string | undefined
  const nextAssistantMessageId = (message: JsonRecord): string => {
    const upstreamId = typeof message.id === 'string' && message.id.trim() ? message.id.trim() : undefined
    return upstreamId ? `pi:${upstreamId}` : `pi:${request.runId}:assistant-${++assistantMessageSequence}`
  }
  const currentAssistantMessageId = (message: JsonRecord = {}): string => {
    assistantMessageId ??= nextAssistantMessageId(message)
    return assistantMessageId
  }
  let settledResolve: (() => void) | undefined
  const settled = new Promise<void>((resolve) => { settledResolve = resolve })
  let rpcFailureReject: ((error: Error) => void) | undefined
  const rpcFailure = new Promise<never>((_resolve, reject) => { rpcFailureReject = reject })
  void rpcFailure.catch(() => undefined)
  const offFailure = rpc.onFailure((error) => rpcFailureReject?.(error))
  const off = rpc.onEvent((event) => {
    if (event.type === 'agent_settled') {
      settledResolve?.()
      return
    }
    if (event.type === 'message_start') {
      const message = record(event.message)
      if (message.role === 'assistant') {
        streamedText = false
        streamedThinking = false
        assistantMessageId = nextAssistantMessageId(message)
      }
      return
    }
    if (event.type === 'message_update') {
      const delta = record(event.assistantMessageEvent)
      const messageId = currentAssistantMessageId()
      if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
        streamedText = true
        request.emit(piEvent(request.runId, { kind: 'model', stage: 'text_delta', text: delta.delta, messageId }))
      } else if (delta.type === 'thinking_delta' && typeof delta.delta === 'string') {
        streamedThinking = true
        request.emit(piEvent(request.runId, { kind: 'model', stage: 'thinking', thinking: delta.delta, messageId }))
      }
      return
    }
    if (event.type === 'message_end') {
      const message = record(event.message)
      if (message.role !== 'assistant') return
      const messageId = currentAssistantMessageId(message)
      addAssistantUsage(usage, message, modelContextWindows)
      if (!streamedText || !streamedThinking) {
        const content = Array.isArray(message.content) ? message.content.map(record) : []
        for (const block of content) {
          if (!streamedText && block.type === 'text' && typeof block.text === 'string') {
            request.emit(piEvent(request.runId, { kind: 'model', stage: 'text_delta', text: block.text, messageId }))
          }
          if (!streamedThinking && block.type === 'thinking' && typeof block.thinking === 'string') {
            request.emit(piEvent(request.runId, { kind: 'model', stage: 'thinking', thinking: block.thinking, messageId }))
          }
        }
      }
      assistantMessageId = undefined
      return
    }
    if (event.type === 'tool_execution_start') {
      const toolUseId = typeof event.toolCallId === 'string' ? event.toolCallId : `pi-tool-${eventCounter++}`
      const rawName = typeof event.toolName === 'string' ? event.toolName : 'Tool'
      const toolName = rawName === 'subagent' ? 'Agent' : rawName
      const input = record(event.args)
      const classified = classifyTool(toolName, input)
      toolNames.set(toolUseId, toolName)
      toolStarts.set(toolUseId, Date.now())
      request.emit(piEvent(request.runId, {
        kind: classified.kind,
        stage: `${classified.kind}:${classified.name}`,
        tool: toolName,
        name: classified.name,
        toolUseId,
        input,
        ...parseMcp(rawName, input),
        ...fileOpOf(toolName, input)
      }))
      return
    }
    if (event.type === 'tool_execution_end') {
      const toolUseId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined
      const rawName = typeof event.toolName === 'string' ? event.toolName : toolNames.get(toolUseId ?? '') ?? 'Tool'
      const toolName = rawName === 'subagent' ? 'Agent' : rawName
      const output = bounded(event.result)
      const mcp = parseMcp(rawName, record(event.args))
      const startedAt = toolUseId ? toolStarts.get(toolUseId) : undefined
      request.emit(piEvent(request.runId, {
        kind: 'tool',
        stage: 'tool_result',
        tool: toolName,
        toolUseId,
        output,
        text: output,
        durationMs: startedAt == null ? undefined : Date.now() - startedAt,
        ...mcp,
        isError: event.isError === true || (mcp.isMcp && mcpPayloadFailed(output))
      }))
      if (toolUseId) {
        toolNames.delete(toolUseId)
        toolStarts.delete(toolUseId)
      }
      return
    }
    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      request.emit(piEvent(request.runId, {
        kind: 'harness',
        stage: event.type,
        compaction: { trigger: event.reason === 'manual' ? 'manual' : 'auto' },
        runtimeMetadata: event
      }))
      return
    }
    if (event.type === 'extension_error') {
      request.emit(piEvent(request.runId, {
        kind: 'harness',
        stage: 'runtime:extension_error',
        text: bounded(event.error, 4_000),
        isError: true,
        runtimeMetadata: { extensionPath: event.extensionPath, event: event.event }
      }))
      return
    }
    if (event.type !== 'extension_ui_request') return
    const question = questionFromExtension(request.runId, event)
    if (!question || !request.requestUserInput) {
      if (question) rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true })
      else request.emit(piEvent(request.runId, {
        kind: 'harness',
        stage: 'runtime:extension_ui',
        text: bounded(event, 4_000),
        runtimeMetadata: { method: event.method }
      }))
      return
    }
    void request.requestUserInput(question, abortController.signal)
      .then((response) => rpc.notify(extensionResponse(event, question, response)))
      .catch(() => rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true }))
  })
  const startedAt = Date.now()
  try {
    const initialState = record((await rpc.send({ type: 'get_state' })).data)
    if (typeof initialState.sessionId === 'string' && initialState.sessionId) {
      state.sessionId = initialState.sessionId
      request.onExternalSessionId?.(initialState.sessionId)
    }
    request.emit(piEvent(request.runId, {
      kind: 'harness',
      stage: 'runtime:init',
      text: state.sessionId,
      runtimeMetadata: {
        agentProfileId: profile.id,
        executable: profile.executable,
        sessionId: initialState.sessionId ?? null,
        sessionFile: initialState.sessionFile ?? null,
        model: initialState.model ?? null,
        thinkingLevel: initialState.thinkingLevel ?? null
      }
    }))
    if (request.model) {
      if (!request.model.providerId) throw new Error('Pi 模型选择缺少 upstream providerId')
      await rpc.send({ type: 'set_model', provider: request.model.providerId, modelId: request.model.id })
    }
    if (request.effort) await rpc.send({ type: 'set_thinking_level', level: request.effort })
    try {
      const available = record((await rpc.send({ type: 'get_available_models' })).data).models
      if (Array.isArray(available)) {
        for (const [key, value] of piModelContextWindows(available.map(record))) modelContextWindows.set(key, value)
      }
    } catch {
      // Model-window telemetry is optional; usage remains available without Context%.
    }
    const explicitSkillEvent = await proveExplicitPiSkill(rpc, request)
    const entryBaseline = await piEntryBaseline(rpc)
    if (request.managedRecorder) {
      if (!request.cwd || !state.sessionId || !request.managedRecorderIdentity) {
        throw new Error('Pi managed recorder 缺少 workspace、session 或受信任轮次身份')
      }
      const opened = await handleRecorderHook({
        provider: 'pi',
        event: 'UserPromptSubmit',
        workspace: request.cwd,
        managed: true,
        env: {
          ...sanitizeProviderEnv(process.env as Record<string, string>, 'pi'),
          SCRY_MANAGED_RUN_ID: request.managedRecorderIdentity.runId,
          SCRY_MANAGED_PROMPT_HASH: request.managedRecorderIdentity.promptHash
        },
        payload: {
          session_id: state.sessionId,
          prompt: request.prompt,
          timestamp: new Date(startedAt).toISOString()
        }
      })
      if (opened.status !== 'started' && opened.status !== 'duplicate') {
        throw new Error(`Pi managed recorder 无法建立轮次身份：${opened.reason ?? opened.status}`)
      }
    }
    if (explicitSkillEvent) request.emit(explicitSkillEvent)
    const images = request.attachments.map((attachment) => ({
      type: 'image',
      data: attachment.dataBase64,
      mimeType: attachment.mimeType
    }))
    try {
      await rpc.send({ type: 'prompt', message: request.prompt, ...(images.length > 0 ? { images } : {}) })
    } catch (error) {
      const identity = request.managedRecorderIdentity
      if (
        request.managedRecorder &&
        request.cwd &&
        state.sessionId &&
        identity &&
        error instanceof PiRpcCommandError &&
        error.command === 'prompt'
      ) {
        try {
          await cancelManagedRecorderTurn({
            workspace: request.cwd,
            provider: 'pi',
            sessionId: state.sessionId,
            runId: identity.runId,
            promptHash: identity.promptHash
          })
        } catch (cancelError) {
          throw new AggregateError([error, cancelError], 'Pi prompt preflight 失败，且 provisional recorder lifecycle 撤销失败')
        }
      }
      throw error
    }
    state.providerTurnId = await waitForPiUserEntryId(rpc, entryBaseline)
    let settlementTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        settled,
        rpcFailure,
        new Promise<never>((_, reject) => {
          settlementTimer = setTimeout(
            () => reject(new Error('Pi RPC 等待 agent_settled 超过 30 分钟')),
            30 * 60 * 1000
          )
        })
      ])
    } finally {
      if (settlementTimer) clearTimeout(settlementTimer)
    }
    const finalState = record((await rpc.send({ type: 'get_state' })).data)
    if (typeof finalState.sessionId === 'string' && finalState.sessionId) {
      state.sessionId = finalState.sessionId
      request.onExternalSessionId?.(finalState.sessionId)
    }
    const stopReason = usage.lastError ?? usage.lastStopReason
    const terminationReason = classifyRunTermination({ rawReason: usage.lastStopReason, message: usage.lastError })
    const failed = !state.stopped && usage.lastStopReason === 'error'
    request.emit(piEvent(request.runId, {
      kind: 'harness',
      stage: 'result',
      text: stopReason,
      tokensIn: usage.input,
      tokensOut: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheWrite,
      reasoningTokens: usage.reasoning,
      contextTokens: usage.lastContextTokens,
      contextModel: usage.lastContextModel,
      contextProvider: usage.lastContextProvider,
      contextUsageSource: usage.contextUsageSource,
      contextUsageQuality: usage.contextUsageQuality,
      costUsd: usage.allCostKnown && usage.byModel.size > 0 ? usage.cost : undefined,
      costSource: usage.allCostKnown && usage.byModel.size > 0 ? 'provider_reported' : undefined,
      costConfidence: usage.allCostKnown && usage.byModel.size > 0 ? 'provider_reported' : undefined,
      costUnit: usage.allCostKnown && usage.byModel.size > 0 ? 'usd' : undefined,
      billingProvider: billingProviderForUpstream(usage.upstreamProvider),
      modelUsage: [...usage.byModel.values()],
      upstreamProvider: usage.upstreamProvider,
      usageSource: 'pi_rpc',
      durationMs: Date.now() - startedAt,
      isError: failed,
      ...(terminationReason ? { terminationReason } : {}),
      ...(usage.lastStopReason ? { providerStopReason: usage.lastStopReason } : {}),
      runtimeMetadata: {
        agentProfileId: profile.id,
        sessionFile: finalState.sessionFile ?? null,
        model: usage.model ?? null,
        provider: usage.upstreamProvider ?? null,
        stderrTail: rpc.stderrTail() || null
      }
    }))
    return {
      externalSessionId: state.sessionId,
      providerTurnId: state.providerTurnId,
      stopped: state.stopped,
      status: state.stopped ? 'interrupted' : failed ? 'failed' : 'completed'
    }
  } catch (error) {
    if (state.stopped) return {
      externalSessionId: state.sessionId,
      providerTurnId: state.providerTurnId,
      stopped: true,
      status: 'interrupted'
    }
    throw new AgentRuntimeError(String((error as Error).message), {
      provider: 'pi_rpc',
      stage: 'runtime',
      cwd: request.cwd,
      nextAction: '检查该 Pi Agent launcher、RPC 兼容性和 stderr 后重试'
    })
  } finally {
    off()
    offFailure()
    abortController.abort()
    await rpc.close()
    if (state.rpc === rpc) state.rpc = undefined
  }
}

export function createPiAdapter(options: {
  listProfiles: () => Promise<PiAgentProfile[]>
  resolveProfile: (id: string) => Promise<PiAgentProfile | undefined>
}): ProviderAdapter {
  const profileForContext = async (context: ProviderContext): Promise<PiAgentProfile> => {
    if (!context.agentProfileId) throw new Error('Pi Provider 缺少 agentProfileId')
    const profile = await options.resolveProfile(context.agentProfileId)
    if (!profile) throw new Error(`Pi Agent Profile 不存在：${context.agentProfileId}`)
    return profile
  }
  return {
    id: 'pi',
    runtimeProvider: 'pi_rpc',
    async describe(): Promise<ProviderDescriptor> {
      const profiles = await options.listProfiles().catch(() => [])
      return {
        id: 'pi',
        label: 'Pi',
        runtimeProvider: 'pi_rpc',
        transport: 'JSONL RPC subprocess',
        available: profiles.length > 0,
        path: profiles[0]?.executable,
        disabledReason: profiles.length > 0 ? undefined : '未检测到 Pi 或已保存的 Pi Agent Profile',
        capabilities: { skills: 'read', mcp: 'none', commands: 'read', account: 'none' },
        health: { state: profiles.length > 0 ? 'ready' : 'unavailable', transport: 'JSONL RPC subprocess' }
      }
    },
    forkLastTurn: {
      async fork(request) {
        if (!request.agentProfileId) throw new Error('Pi 分支缺少 agentProfileId')
        const profile = await options.resolveProfile(request.agentProfileId)
        if (!profile) throw new Error(`Pi Agent Profile 不存在：${request.agentProfileId}`)
        return withPiRpc(
          profile,
          request.cwd,
          piRpcArgs({ session: request.sourceSessionId }),
          async (rpc) => {
            const snapshot = await rpc.send({ type: 'get_entries' })
            const entries = record(snapshot.data).entries
            const target = Array.isArray(entries)
              ? entries.map(record).find((entry) => entry.id === request.replaceForkTurnId)
              : undefined
            if (!target || record(target.message).role !== 'user') {
              throw new Error('Pi 会话无法定位待替换的用户消息 entry')
            }
            const forked = await rpc.send({ type: 'fork', entryId: request.replaceForkTurnId })
            if (record(forked.data).cancelled === true) throw new Error('Pi extension 取消了会话分支')
            const state = record((await rpc.send({ type: 'get_state' })).data)
            if (typeof state.sessionId !== 'string' || !state.sessionId) throw new Error('Pi fork 未返回新 sessionId')
            return { externalSessionId: state.sessionId }
          }
        )
      }
    },
    forkSession: {
      async fork(request) {
        if (!request.agentProfileId) throw new Error('Pi 分支缺少 agentProfileId')
        const profile = await options.resolveProfile(request.agentProfileId)
        if (!profile) throw new Error(`Pi Agent Profile 不存在：${request.agentProfileId}`)
        return withPiRpc(
          profile,
          request.cwd,
          piRpcArgs({ session: request.sourceSessionId }),
          async (rpc) => {
            const snapshot = record((await rpc.send({ type: 'get_entries' })).data)
            const rawEntries = Array.isArray(snapshot.entries) ? snapshot.entries.map(record) : []
            if (typeof snapshot.leafId !== 'string' || !snapshot.leafId) {
              throw new Error('Pi 会话缺少 active leaf，无法创建分支')
            }
            const target = completedPiTurnForkTarget(rawEntries.map((entry) => ({
              id: typeof entry.id === 'string' ? entry.id : undefined,
              parentId: typeof entry.parentId === 'string' || entry.parentId === null ? entry.parentId : undefined,
              type: typeof entry.type === 'string' ? entry.type : undefined,
              role: typeof record(entry.message).role === 'string' ? String(record(entry.message).role) : undefined
            })), snapshot.leafId, request.sourceForkTurnId)
            const forked = target.operation === 'fork_before'
              ? await rpc.send({ type: 'fork', entryId: target.entryId })
              : await rpc.send({ type: 'clone' })
            if (record(forked.data).cancelled === true) throw new Error('Pi extension 取消了会话分支')
            const state = record((await rpc.send({ type: 'get_state' })).data)
            if (typeof state.sessionId !== 'string' || !state.sessionId) throw new Error('Pi fork 未返回新 sessionId')
            return { externalSessionId: state.sessionId }
          }
        )
      }
    },
    run(request: ProviderRunRequest): ProviderRunHandle {
      const state: PiRunState = { stopped: false }
      const promise = (async () => {
        if (!request.agentProfileId) throw new Error('Pi Provider run 缺少 agentProfileId')
        const profile = await options.resolveProfile(request.agentProfileId)
        if (!profile) throw new Error(`Pi Agent Profile 不存在：${request.agentProfileId}`)
        return runPiAgent(profile, request, state)
      })()
      return {
        promise,
        interrupt: () => {
          state.stopped = true
          state.rpc?.notify({ type: 'abort' })
          setTimeout(() => state.rpc?.abort(), 2_000)
        },
        forceKill: () => state.rpc?.forceTerminate(),
        // 每轮 run 自己 spawn 一个 Pi RPC 子进程：SIGKILL 不会波及其他 run。
        forceKillScope: 'run_scoped',
        getExternalSessionId: () => state.sessionId,
        getProviderTurnId: () => state.providerTurnId
      }
    },
    sessionEvidence: {
      async enrich(context, turns) {
        if (!piHistoryNeedsModelCatalog(turns)) return turns
        try {
          const probe = await probePiAgent(await profileForContext(context), context.cwd)
          return enrichPiHistory(turns, piModelContextWindows(probe.models))
        } catch {
          return turns
        }
      }
    },
    skills: {
      async list(context) {
        try {
          return capabilityReady(context, 'read', skillCatalog(await probePiAgent(await profileForContext(context), context.cwd)))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', `Pi Skill 目录探测失败：${String((error as Error).message)}`)
        }
      }
    },
    commands: {
      async list(context) {
        try {
          return capabilityReady(context, 'read', commandCatalog(await probePiAgent(await profileForContext(context), context.cwd)))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', `Pi 命令目录探测失败：${String((error as Error).message)}`)
        }
      }
    },
    runControls: {
      async read(context) {
        try {
          return capabilityReady(context, 'read', runControlCatalog(await probePiAgent(await profileForContext(context), context.cwd)))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', `Pi 运行能力探测失败：${String((error as Error).message)}`)
        }
      }
    }
  }
}
