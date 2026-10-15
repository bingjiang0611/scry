import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createPiRpcDecoder } from './pi-rpc-decoder'
import { PiBackgroundWork } from './pi-background-work'
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
  type AgentRunControlCatalog,
  type AgentSteerInput,
  type AgentSteerResult
} from '../../shared/runtime'
import {
  classifyTool,
  contextCompactionOf,
  contextUsageEvidence,
  fileOpOf,
  mcpPayloadFailed,
  parseMcp,
  type ModelUsageRow,
  type TraceEvent
} from '../../shared/trace'
import { AgentRuntimeError } from '../run-outcome'
import { execFileText, resolveCommandOnPath, sanitizeProviderEnv, shellEnv, shellEnvError } from '../claude-locate'
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
const serialized = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? null)
const bounded = (value: unknown, max = 200_000): string => {
  const text = serialized(value)
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated by Scry]`
}

const PI_BOOTSTRAP_MAX_BYTES = 64 * 1024
const PI_NODE_PROBE_TIMEOUT_MS = 5_000
export const PI_RPC_COMMAND_TIMEOUT_MS = 15_000
// Resuming a large Pi session includes loading its JSONL history and extensions before the first
// response. That cold-start work can legitimately exceed an ordinary command's deadline (the
// reported 8.3 MiB session took about 20 seconds), so startup has its own bounded allowance.
export const PI_RPC_STARTUP_TIMEOUT_MS = 60_000
// Limit retained evidence per frame, not cumulative session output or redundant native snapshots.
// The decoder streams past repeated lifecycle payloads and projects get_entries to identity only.
// Larger live evidence still fails explicitly; supporting it requires a disk-backed evidence path,
// not a larger main-process heap or silent truncation.
export const PI_RPC_MAX_FRAME_BYTES = 64 * 1024 * 1024

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

function compatibleNodeVersion(raw: string, rotom: boolean): boolean {
  const [major, minor] = raw.trim().split('.').map(Number)
  return major >= 24 || (!rotom && major === 23 && minor >= 6)
}

async function compatiblePiNode(env: Record<string, string>, rotom: boolean): Promise<string | undefined> {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolveCommandOnPath('node', directory)
    if (!candidate) continue
    const version = await execFileText(candidate, ['-p', 'process.versions.node'], { env, timeout: PI_NODE_PROBE_TIMEOUT_MS })
    if (compatibleNodeVersion(version, rotom)) return realpathSync(candidate)
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
  if (basename(profile.executable) === 'rotom') {
    if (!env.ROTOM_NODE) env.ROTOM_NODE = compatibleNode
    return
  }
  if (!env.PI_AGENT_NODE) env.PI_AGENT_NODE = compatibleNode
}

const PROXY_ENV_NAMES = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'
] as const

function enableRotomNodeEnvProxy(profile: PiAgentProfile, env: Record<string, string>): void {
  if (basename(profile.executable) !== 'rotom' || Object.hasOwn(env, 'NODE_USE_ENV_PROXY')) return
  // Node's built-in fetch/WebSocket stack does not consume HTTP(S)_PROXY merely because the
  // variables exist. Rotom's OpenAI Codex transport falls back from WebSocket to fetch/SSE, so
  // opt its Node >=24 runtime into the env-proxy dispatcher whenever a usable proxy is present.
  if (PROXY_ENV_NAMES.some((name) => Boolean(env[name]?.trim()))) env.NODE_USE_ENV_PROXY = '1'
}

export async function piRpcEnvironment(
  profile: PiAgentProfile,
  baseEnv: Record<string, string> = shellEnv()
): Promise<Record<string, string>> {
  const env = sanitizeProviderEnv(baseEnv, 'pi')
  // Discovery, profile validation and runs must use the same non-blocking launcher resolution.
  // Rotom requires Node >=24 and owns ROTOM_NODE; PI_AGENT_NODE belongs to the legacy launcher.
  const rotom = basename(profile.executable) === 'rotom'
  const configuredNode = rotom ? env.ROTOM_NODE : env.PI_AGENT_NODE
  const compatibleNode = configuredNode ?? await compatiblePiNode(env, rotom)
  pinPiLauncherNode(profile, env, compatibleNode)
  enableRotomNodeEnvProxy(profile, env)
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
    timer: ReturnType<typeof setTimeout> | undefined
    command: string
  }>()
  private readonly listeners = new Set<(event: JsonRecord) => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()
  private stderr = ''
  private requestSeq = 0
  private failed: Error | null = null
  private closing = false
  private closed = false
  private readonly exited: Promise<void>

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly profile: PiAgentProfile,
    private readonly maxFrameBytes = PI_RPC_MAX_FRAME_BYTES
  ) {
    this.exited = new Promise((resolve) => child.once('close', () => {
      this.closed = true
      resolve()
    }))
    child.stdin.on('error', (error) => this.fail(error))
    const decoder = createPiRpcDecoder(this.maxFrameBytes)
    child.stdout.pipe(decoder)
    decoder.on('data', (message: JsonRecord) => this.receive(message))
    decoder.on('error', (error: Error) => {
      this.fail(new PiRpcTransportError('process', `Pi RPC stdout JSONL 解码失败：${error.message}`, { cause: error }))
      this.terminate()
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_384) })
    child.on('error', (error) => this.fail(new PiRpcTransportError('process', `Pi RPC 进程错误：${error.message}`, { cause: error })))
    child.on('close', (code, signal) => {
      if (!this.closing && !this.failed) {
        this.fail(new PiRpcTransportError('process', `Pi RPC 进程提前退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）：${this.stderr.trim()}`))
      }
    })
  }

  static start(profile: PiAgentProfile, args: string[], env: Record<string, string>, cwd?: string, maxFrameBytes = PI_RPC_MAX_FRAME_BYTES): PiRpcProcess {
    const child = spawn(profile.executable, args, {
      cwd: cwd || homedir(),
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return new PiRpcProcess(child, profile, maxFrameBytes)
  }

  private receive(message: JsonRecord): void {
    if (this.failed) return
    if (message.type === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.success === false) {
          pending.reject(new PiRpcCommandError(pending.command, String(message.error ?? 'Pi RPC command failed')))
        } else pending.resolve(message)
        return
      }
    }
    for (const listener of this.listeners) listener(message)
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

  send(command: JsonRecord, timeoutMs: number | null = PI_RPC_COMMAND_TIMEOUT_MS): Promise<JsonRecord> {
    if (this.failed) return Promise.reject(this.failed)
    if (this.closing || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      return Promise.reject(new Error('Pi RPC stdin 已关闭'))
    }
    const id = `scry-${++this.requestSeq}`
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id)
        reject(new PiRpcTransportError('timeout', `Pi RPC ${String(command.type ?? 'command')} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, command: String(command.type ?? 'command') })
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(new PiRpcTransportError('write', `Pi RPC stdin 写入失败：${error.message}`, { cause: error }))
      })
    })
  }

  notify(message: JsonRecord): void {
    if (this.failed || this.closing || this.child.stdin.destroyed || this.child.stdin.writableEnded) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private async waitForClose(): Promise<boolean> {
    if (this.closed) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 750) })
      ])
      return this.closed
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    this.fail(new Error('Pi RPC 已关闭'))
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end()
    if (await this.waitForClose()) return
    this.terminate()
    if (await this.waitForClose()) return
    // The main stop lifecycle cancels its escalation when this run settles. Keep ownership until
    // the child really closes, including launchers that ignore abort, stdin EOF and SIGTERM.
    this.forceTerminate()
    if (!await this.waitForClose()) throw new Error('Pi RPC SIGKILL 后仍未确认进程关闭')
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
    this.fail(new Error('Pi RPC 已被强制终止'))
    this.closing = true
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGKILL')
      else this.child.kill('SIGKILL')
    } catch {
      try { this.child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }

  reusable(): boolean {
    return !this.failed && !this.closing && !this.closed && !this.child.stdin.destroyed && !this.child.stdin.writableEnded
  }

  stderrTail(): string {
    return this.stderr
  }
}

const ROTOM_RPC_IDLE_MS = 60_000

interface IdleRotomRpc {
  rpc: PiRpcProcess
  env: Record<string, string>
  profileId: string
  executable: string
  cwd: string
  sessionId: string
  timer: ReturnType<typeof setTimeout>
}

class RotomRpcPool {
  private readonly idle = new Map<string, IdleRotomRpc>()

  private key(profile: PiAgentProfile, cwd: string | undefined, sessionId: string): string {
    return `${profile.id}\0${profile.executable}\0${cwd ?? ''}\0${sessionId}`
  }

  async take(profile: PiAgentProfile, cwd: string | undefined, sessionId: string | undefined, env: Record<string, string>): Promise<PiRpcProcess | undefined> {
    if (!sessionId) return undefined
    const key = this.key(profile, cwd, sessionId)
    const entry = this.idle.get(key)
    if (!entry) return undefined
    this.idle.delete(key)
    clearTimeout(entry.timer)
    // A live process cannot inherit a recovered proxy/PATH. Compare the sanitized
    // launch environment in memory only; never persist or log credential values.
    if (entry.rpc.reusable() && isDeepStrictEqual(entry.env, env)) return entry.rpc
    // Confirm the previous writer has exited before reopening the same native session.
    await entry.rpc.close()
    return undefined
  }

  keep(profile: PiAgentProfile, cwd: string | undefined, sessionId: string, rpc: PiRpcProcess, env: Record<string, string>): void {
    if (!rpc.reusable()) {
      void rpc.close().catch(() => undefined)
      return
    }
    const key = this.key(profile, cwd, sessionId)
    const previous = this.idle.get(key)
    if (previous) {
      clearTimeout(previous.timer)
      void previous.rpc.close().catch(() => undefined)
    }
    const entry: IdleRotomRpc = {
      rpc,
      env,
      profileId: profile.id,
      executable: profile.executable,
      cwd: cwd ?? '',
      sessionId,
      timer: setTimeout(() => {
        if (this.idle.get(key) !== entry) return
        this.idle.delete(key)
        void rpc.close().catch(() => undefined)
      }, ROTOM_RPC_IDLE_MS)
    }
    entry.timer.unref()
    this.idle.set(key, entry)
  }

  async invalidate(context: ProviderContext): Promise<void> {
    const matches = [...this.idle.entries()].filter(([, entry]) =>
      entry.cwd === (context.cwd ?? '') &&
      (!context.agentProfileId || entry.profileId === context.agentProfileId) &&
      (!context.externalSessionId || entry.sessionId === context.externalSessionId)
    )
    await Promise.all(matches.map(async ([key, entry]) => {
      this.idle.delete(key)
      clearTimeout(entry.timer)
      await entry.rpc.close()
    }))
  }

  async dispose(): Promise<void> {
    const entries = [...this.idle.values()]
    this.idle.clear()
    await Promise.all(entries.map(async (entry) => {
      clearTimeout(entry.timer)
      await entry.rpc.close()
    }))
  }
}

class PiRpcCommandError extends Error {
  constructor(readonly command: string, message: string) {
    super(message)
    this.name = 'PiRpcCommandError'
  }
}

class PiRpcTransportError extends Error {
  constructor(readonly reason: 'timeout' | 'write' | 'process', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PiRpcTransportError'
  }
}

class PiRecorderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PiRecorderError'
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
  sessionFile?: string
  persistedSessionId?: string
  providerTurnId?: string
  rpc?: PiRpcProcess
  steerAdmissionUncertain?: boolean
  steerDispatched?: boolean
  steer?: (input: AgentSteerInput) => Promise<AgentSteerResult>
}

function publishPersistedPiSession(request: ProviderRunRequest, state: PiRunState): void {
  if (!state.sessionId || state.persistedSessionId === state.sessionId || !state.sessionFile) return
  // Pi assigns an ID/path at startup, but creates the JSONL only after a conversation
  // entry. Publishing the in-memory ID makes an early stop poison the next resume.
  if (!statSync(state.sessionFile, { throwIfNoEntry: false })?.isFile()) return
  state.persistedSessionId = state.sessionId
  request.onExternalSessionId?.(state.persistedSessionId)
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

export function piUserEntryIdAfterBaseline(
  baselineLeafId: string | null,
  entries: JsonRecord[],
  allowSteeringEntries = false
): string | null {
  const candidates = entries.filter(isUserMessageEntry)
  if (candidates.length === 0) return null
  if (!allowSteeringEntries && candidates.length !== 1) throw new Error('Pi RPC prompt 对应多个新增 user session entries')
  const root = candidates[0]
  if (typeof root.id !== 'string' || !root.id) throw new Error('Pi RPC prompt 的 user session entry 缺少稳定 id')
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  for (const candidate of candidates) {
    let parentId = candidate.parentId
    const visited = new Set<string>()
    let reachedRoot = candidate === root
    while (parentId !== baselineLeafId) {
      if (typeof parentId !== 'string' || !parentId || visited.has(parentId)) {
        throw new Error('Pi RPC user session entry 无法回溯到 prompt 前冻结的 active leaf')
      }
      visited.add(parentId)
      if (parentId === root.id) reachedRoot = true
      const parent = byId.get(parentId)
      if (!parent) throw new Error('Pi RPC user session entry 的新增 ancestry 不完整')
      parentId = parent.parentId
    }
    if (!reachedRoot) throw new Error('Pi RPC prompt 对应多个 active branch user entries')
  }
  // get_entries uses append order. Only an actual Steer dispatch permits additional
  // users, all on the same ancestry. Expanded slash text must not select a later user.
  return root.id
}

async function piEntryBaseline(rpc: PiRpcProcess): Promise<PiEntrySnapshot> {
  return piEntrySnapshot(await rpc.send({ type: 'get_entries' }))
}

async function waitForPiUserEntryId(
  rpc: PiRpcProcess,
  baseline: PiEntrySnapshot,
  isSettled: () => boolean,
  hasSteerInput: () => boolean
): Promise<string> {
  for (;;) {
    let changed!: () => void
    let failed!: (error: Error) => void
    const activity = new Promise<void>((resolve, reject) => { changed = resolve; failed = reject })
    void activity.catch(() => undefined)
    // Subscribe before the snapshot so an event arriving during get_entries is not lost.
    const off = rpc.onEvent(changed)
    const offFailure = rpc.onFailure(failed)
    const terminalSnapshot = isSettled()
    try {
      const response = await rpc.send({
        type: 'get_entries',
        ...(baseline.appendCursor ? { since: baseline.appendCursor } : {})
      }, null)
      const rows = record(response.data).entries
      if (!Array.isArray(rows)) throw new Error('Pi RPC get_entries 返回了无效增量 entries')
      const id = piUserEntryIdAfterBaseline(
        baseline.leafId,
        rows.map(record),
        hasSteerInput()
      )
      if (id) return id
      // Only a post-settlement snapshot proves missing identity. Do not kill a running
      // Provider because its prompt entry has not appeared within an arbitrary five seconds.
      if (terminalSnapshot) throw new Error('Pi RPC prompt 已接受，但未出现 authoritative user session entry')
      await activity
    } finally {
      off()
      offFailure()
    }
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

async function piExtensionCommand(rpc: PiRpcProcess, prompt: string): Promise<string | undefined> {
  // Match Pi's command parser, not arbitrary slash-looking text or skill/template expansions.
  if (!prompt.startsWith('/') || explicitPiSkill(prompt)) return undefined
  const name = prompt.slice(1).split(' ', 1)[0]
  const rows = record((await rpc.send({ type: 'get_commands' })).data).commands
  return Array.isArray(rows) && rows.some((row) => record(row).name === name && record(row).source === 'extension')
    ? name
    : undefined
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
  const rpc = PiRpcProcess.start(profile, args, await piRpcEnvironment(profile), cwd)
  try {
    return await operation(rpc)
  } finally {
    await rpc.close()
  }
}

// Share only overlapping reads, never a settled capability snapshot: a later refresh must see
// changed models, extensions and project trust. Profile identity and workspace remain isolated.
const piProbesInFlight = new Map<string, Promise<PiProbe>>()

export function probePiAgent(profile: PiAgentProfile, cwd?: string): Promise<PiProbe> {
  const probeCwd = cwd || homedir()
  const key = JSON.stringify([profile.id, profile.executable, probeCwd])
  const pending = piProbesInFlight.get(key)
  if (pending) return pending
  const probe = withPiRpc(profile, probeCwd, piRpcArgs({ noSession: true, offline: true }), async (rpc) => {
    const [state, models, levels, commands] = await Promise.all([
      rpc.send({ type: 'get_state' }, PI_RPC_STARTUP_TIMEOUT_MS),
      rpc.send({ type: 'get_available_models' }, PI_RPC_STARTUP_TIMEOUT_MS),
      rpc.send({ type: 'get_available_thinking_levels' }, PI_RPC_STARTUP_TIMEOUT_MS),
      rpc.send({ type: 'get_commands' }, PI_RPC_STARTUP_TIMEOUT_MS)
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
  }).finally(() => { piProbesInFlight.delete(key) })
  piProbesInFlight.set(key, probe)
  return probe
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

function nativeCustomAnswerOption(event: JsonRecord): string | undefined {
  if (event.method !== 'select' || !Array.isArray(event.options)) return undefined
  const last = event.options.at(-1)
  return typeof last === 'string' && /^(?:\d+[.)、]\s*)?Type something\.?$/i.test(last.trim()) ? last : undefined
}

export function questionFromExtension(runId: string, event: JsonRecord): AgentQuestionRequest | null {
  const id = typeof event.id === 'string' ? event.id : ''
  const method = String(event.method ?? '')
  if (!id || !['select', 'confirm', 'input', 'editor'].includes(method)) return null
  const title = String(event.title ?? 'Pi Extension').slice(0, 2_000)
  const inputTitle = title.match(/^\[([^\]\n]{1,16})\]\s*([\s\S]+)$/)
  const inputBody = inputTitle?.[2].trim() || title
  const numberedOptions = method === 'input'
    ? [...inputBody.matchAll(/^\s*(\d+)[.)、]\s+(.+)$/gm)]
    : []
  const firstOptionAt = numberedOptions[0]?.index
  const parsedQuestion = firstOptionAt == null
    ? inputBody
    : inputBody.slice(0, firstOptionAt).trim()
  const isMultiSelect = /[（(]\s*可多选\s*[）)]/.test(parsedQuestion)
  const cleanQuestion = parsedQuestion.replace(/\s*[（(]\s*可多选\s*[）)]\s*$/, '').trim()
  const parsedOptions = numberedOptions.map((match) => {
    const copy = match[2].trim()
    const split = copy.match(/^(.+?)\s+[—–]\s+(.+)$/)
    return {
      label: split?.[1].trim() || copy,
      description: split?.[2].trim() || '选择此项',
      answerValue: match[1]
    }
  })
  const header = method === 'input'
    ? inputTitle?.[1].trim() || '回答'
    : title.slice(0, 120)
  const question = method === 'confirm'
    ? String(event.message ?? title)
    : method === 'editor'
      ? '请输入多行内容'
      : method === 'input'
        ? cleanQuestion
        : title
  const labels = method === 'confirm'
    ? ['确认', '取消']
    : Array.isArray(event.options)
      ? event.options.filter((item): item is string => typeof item === 'string').slice(0, 100)
      : []
  const customAnswerOption = nativeCustomAnswerOption(event)
  const options = parsedOptions.length >= 2
    ? parsedOptions
    : labels.filter((label) => label !== customAnswerOption)
      .map((label) => ({ label, description: method === 'confirm' ? `${label}这次操作` : '选择此项' }))
  const placeholder = method === 'input' && typeof event.placeholder === 'string'
    ? event.placeholder.slice(0, 500)
    : ''
  return {
    runId,
    questionId: id,
    providerId: 'pi',
    questionKind: 'clarification',
    source: `pi_extension_ui:${method}`,
    questions: [{
      header,
      question: question.slice(0, 2_000),
      multiSelect: parsedOptions.length >= 2 && isMultiSelect,
      options,
      // Only the known questionnaire sentinel supports a staged select → input reply.
      // Other native select/confirm requests remain closed choices.
      ...((method === 'select' || method === 'confirm') ? { allowCustomAnswer: !!customAnswerOption } : {}),
      ...((method === 'editor' || method === 'input' && options.length === 0)
        ? { inputMode: method === 'editor' ? 'multiline' as const : 'singleline' as const }
        : {}),
      ...(placeholder && options.length === 0 ? { placeholder } : {}),
      ...(method === 'editor' && typeof event.prefill === 'string'
        ? { initialValue: event.prefill } : {})
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
  lastTransportError?: string
  upstreamProvider?: string
  model?: string
}

/**
 * Pi stamps an assistant message when its request is created; message_end arrives when the response
 * is complete. Their difference is one call's local time, including first-token wait. The first
 * message_update is the first content block (text, thinking or tool call), so it marks the first token.
 * Errored or aborted calls are retried by Pi and must not count as generation speed.
 */
function piLlmCall(message: JsonRecord, endedAtMs: number, firstContentAtMs: number | undefined): Pick<TraceEvent, 'llmCall'> {
  const startedAtMs = number(message.timestamp)
  const outputTokens = number(record(message.usage).output)
  const completed = message.stopReason === 'stop' || message.stopReason === 'toolUse' || message.stopReason === 'length'
  if (!completed || startedAtMs == null || outputTokens == null || outputTokens <= 0 || endedAtMs <= startedAtMs) return {}
  const firstTokenMs = firstContentAtMs != null && firstContentAtMs >= startedAtMs && firstContentAtMs <= endedAtMs
    ? firstContentAtMs - startedAtMs : undefined
  return { llmCall: {
    outputTokens,
    durationMs: endedAtMs - startedAtMs,
    ...(firstTokenMs != null ? { firstTokenMs } : {}),
    ...(typeof message.model === 'string' ? { model: message.model } : {})
  } }
}

function addAssistantUsage(
  aggregate: UsageAggregate,
  message: JsonRecord,
  contextWindows: ReadonlyMap<string, number>
): boolean {
  const usage = record(message.usage)
  const input = number(usage.input)
  const output = number(usage.output)
  const cacheRead = number(usage.cacheRead)
  const cacheWrite = number(usage.cacheWrite)
  const reasoning = number(usage.reasoning)
  const model = typeof message.model === 'string' ? message.model : 'unknown'
  const provider = typeof message.provider === 'string' ? message.provider : undefined
  // Qoder is credit-billed. Pi's USD catalogue total is not credit evidence;
  // match the native Qoder adapter rather than treating its zero placeholder as free.
  const cost = provider === 'qoder' ? undefined : number(record(usage.cost).total)
  const key = `${provider ?? ''}\0${model}`
  aggregate.input += input ?? 0
  aggregate.output += output ?? 0
  aggregate.cacheRead += cacheRead ?? 0
  aggregate.cacheWrite += cacheWrite ?? 0
  aggregate.reasoning += reasoning ?? 0
  const contextEvidence = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  // Pi normalizes input/cacheRead/cacheWrite into disjoint counts, including for OpenAI/Codex.
  // Cached tokens still occupy context. All-zero transport failures are not context samples.
  if (contextEvidence > 0) {
    aggregate.lastContextTokens = contextEvidence
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
  if (Array.isArray(message.diagnostics)) {
    for (const rawDiagnostic of message.diagnostics) {
      const diagnostic = record(rawDiagnostic)
      if (diagnostic.type !== 'provider_transport_failure') continue
      const diagnosticError = record(diagnostic.error)
      if (typeof diagnosticError.message === 'string' && diagnosticError.message.trim()) {
        aggregate.lastTransportError = diagnosticError.message.trim()
      }
    }
  }
  return contextEvidence > 0
}

async function runPiAgent(
  profile: PiAgentProfile,
  request: ProviderRunRequest,
  state: PiRunState,
  maxFrameBytes = PI_RPC_MAX_FRAME_BYTES,
  rotomPool?: RotomRpcPool
): Promise<ProviderRunResult> {
  if (request.permissionMode !== 'full_access') {
    throw new AgentRuntimeError('Pi 只支持显式选择“本机完全访问”后运行', {
      provider: 'pi_rpc',
      stage: 'frontdoor',
      cwd: request.cwd,
      nextAction: '在权限选择器中选择“本机完全访问”；Pi 没有可映射的内置沙箱或审批模式'
    })
  }
  if (state.stopped) return { stopped: true, status: 'interrupted' }
  const baseEnv = shellEnv()
  const launchShellEnvError = shellEnvError()
  const env = await piRpcEnvironment(profile, baseEnv)
  // Stop may arrive while resolving the profile or probing Node. Do not spawn after that stop.
  if (state.stopped) return { stopped: true, status: 'interrupted' }
  const args = piRpcArgs({ session: request.resume })
  const mayReuse = basename(profile.executable) === 'rotom'
  const pooledRpc = mayReuse ? await rotomPool?.take(profile, request.cwd, request.resume, env) : undefined
  if (state.stopped) {
    await pooledRpc?.close()
    return { stopped: true, status: 'interrupted' }
  }
  const rpc = pooledRpc ?? PiRpcProcess.start(profile, args, env, request.cwd, maxFrameBytes)
  state.rpc = rpc
  let retainRpc = false
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
  let stagedCustomAnswer: { value: string; inputTitle: string } | undefined
  const toolNames = new Map<string, string>()
  const toolStarts = new Map<string, number>()
  let streamedText = false
  let streamedThinking = false
  let assistantMessageSequence = 0
  let assistantMessageId: string | undefined
  let assistantFirstContentAtMs: number | undefined
  let assistantToolCallIds = new Set<string>()
  let toolTermination: TraceEvent['toolTermination']
  const nextAssistantMessageId = (message: JsonRecord): string => {
    const upstreamId = typeof message.id === 'string' && message.id.trim() ? message.id.trim() : undefined
    return upstreamId ? `pi:${upstreamId}` : `pi:${request.runId}:assistant-${++assistantMessageSequence}`
  }
  const currentAssistantMessageId = (message: JsonRecord = {}): string => {
    assistantMessageId ??= nextAssistantMessageId(message)
    return assistantMessageId
  }
  let agentStarted = false
  let extensionCommand: string | undefined
  let extensionCommandError: string | undefined
  let agentSettled = false
  let agentEnded = false
  let steerCapabilityEmitted = false
  let steerPending = false
  let resolveAgentCycleEnd!: () => void
  let agentCycleEnd = new Promise<void>(resolve => { resolveAgentCycleEnd = resolve })
  let settledResolve: (() => void) | undefined
  const settled = new Promise<void>((resolve) => { settledResolve = resolve })
  let rpcFailureReject: ((error: Error) => void) | undefined
  const rpcFailure = new Promise<never>((_resolve, reject) => { rpcFailureReject = reject })
  void rpcFailure.catch(() => undefined)
  const offFailure = rpc.onFailure((error) => rpcFailureReject?.(error))
  const background = new PiBackgroundWork()
  const emitBackground = (work: ReturnType<PiBackgroundWork['observe']>): void => {
    if (work) request.emit(piEvent(request.runId, {
      kind: 'harness', stage: 'runtime:background_work', backgroundWork: work,
      runtimeMetadata: { source: 'pi_subagents_async_status_v1' }
    }))
  }
  const off = rpc.onEvent((event) => {
    request.recordNative?.(typeof event.type === 'string' ? event.type : 'unknown', event)
    emitBackground(background.observe(event))
    // Owned follow-up/Goal work can begin another agent cycle before canonical settlement.
    // Rearm only on agent_start, never on a late message from an ended cycle.
    if (event.type === 'agent_start' && agentEnded && !agentSettled) {
      agentEnded = false
      agentCycleEnd = new Promise<void>(resolve => { resolveAgentCycleEnd = resolve })
    }
    if (event.type === 'agent_start' || event.type === 'tool_execution_start' ||
      (event.type === 'message_start' || event.type === 'message_end') &&
      ['user', 'assistant', 'toolResult'].includes(String(record(event.message).role))) {
      agentStarted = true
      if (!steerCapabilityEmitted && !agentSettled && !state.stopped) {
        steerCapabilityEmitted = true
        request.emit(piEvent(request.runId, {
          kind: 'harness', stage: 'runtime:steer_capability', providerId: 'pi', runtimeProvider: 'pi_rpc',
          steerCapability: { status: 'available', attachments: true }
        }))
      }
    }
    if (event.type === 'agent_end') {
      if (steerPending) state.steerAdmissionUncertain = true
      agentEnded = true
      resolveAgentCycleEnd()
    }
    if (event.type === 'agent_settled') {
      if (steerPending) state.steerAdmissionUncertain = true
      agentEnded = true
      resolveAgentCycleEnd()
      // Native idle does not include detached extension work. Keep this run's
      // listener/usage/recorder owner until the child result and parent continuation.
      if (background.pending && !state.stopped && event.aborted !== true) return
      agentSettled = true
      settledResolve?.()
      return
    }
    if (event.type === 'message_start') {
      const message = record(event.message)
      if (message.role === 'assistant') {
        streamedText = false
        streamedThinking = false
        assistantToolCallIds.clear()
        toolTermination = undefined
        assistantMessageId = nextAssistantMessageId(message)
        assistantFirstContentAtMs = undefined
      }
      return
    }
    if (event.type === 'message_update') {
      assistantFirstContentAtMs ??= Date.now()
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
      if (message.role === 'custom' && message.display === true) {
        request.emit(piEvent(request.runId, {
          kind: 'harness', stage: 'runtime:extension_message', providerId: 'pi', runtimeProvider: 'pi_rpc',
          text: typeof message.content === 'string' ? message.content :
            (Array.isArray(message.content) ? message.content.map(record) : [])
              .filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n'),
          runtimeMetadata: { customType: message.customType }
        }))
      }
      if (message.role !== 'assistant') return
      const messageId = currentAssistantMessageId(message)
      if (addAssistantUsage(usage, message, modelContextWindows)) {
        // A request-level sample, not a turn result: never feed these snapshots into billing totals.
        request.emit(piEvent(request.runId, {
          kind: 'harness',
          stage: 'context_usage',
          messageId,
          contextTokens: usage.lastContextTokens,
          contextModel: usage.lastContextModel,
          contextProvider: usage.lastContextProvider,
          contextUsageSource: usage.contextUsageSource,
          contextUsageQuality: usage.contextUsageQuality,
          modelUsage: [{
            model: usage.lastContextModel!,
            upstreamProvider: usage.lastContextProvider,
            contextWindow: modelContextWindows.get(`${usage.lastContextProvider ?? ''}\0${usage.lastContextModel}`)
          }]
        }))
      }
      assistantToolCallIds = new Set(
        (Array.isArray(message.content) ? message.content.map(record) : [])
          .filter((block) => block.type === 'toolCall' && typeof block.id === 'string')
          .map((block) => block.id as string)
      )
      if (!streamedText || !streamedThinking) {
        const content = Array.isArray(message.content) ? message.content.map(record) : []
        for (const block of content) {
          if (!streamedText && block.type === 'text' && typeof block.text === 'string') {
            request.emit(piEvent(request.runId, {
              kind: 'model', stage: 'text_delta', text: block.text, messageId,
              runtimeMetadata: { bufferedOutput: true }
            }))
          }
          if (!streamedThinking && block.type === 'thinking' && typeof block.thinking === 'string') {
            request.emit(piEvent(request.runId, { kind: 'model', stage: 'thinking', thinking: block.thinking, messageId }))
          }
        }
      }
      request.emit(piEvent(request.runId, { kind: 'harness', stage: 'runtime:llm_stream_end', messageId, ...piLlmCall(message, Date.now(), assistantFirstContentAtMs) }))
      assistantMessageId = undefined
      assistantFirstContentAtMs = undefined
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
      const output = serialized(event.result)
      const result = record(event.result)
      // The native loop may intentionally end after a tool (Goal pause/complete/continue).
      // Only the current assistant's explicit termination receipt proves this boundary;
      // tool names, human text, child events and an unexplained toolUse are not sufficient.
      if (result.terminate === true && toolUseId && assistantToolCallIds.has(toolUseId)) {
        const content = Array.isArray(result.content) ? result.content.map(record) : []
        toolTermination = {
          tool: toolName,
          message: bounded(content.filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('\n'), 4_000)
        }
      }
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
      const lifecycle = piEvent(request.runId, {
        kind: 'harness',
        stage: event.type,
        runtimeMetadata: event
      })
      const compaction = contextCompactionOf(lifecycle)
      if (compaction) {
        lifecycle.stage = 'context_compaction'
        lifecycle.compaction = compaction
        // The pre-compaction request no longer describes the active context. Wait for new usage.
        usage.lastContextTokens = undefined
        usage.lastContextModel = undefined
        usage.lastContextProvider = undefined
        usage.contextUsageSource = undefined
        usage.contextUsageQuality = undefined
      }
      request.emit(lifecycle)
      return
    }
    if (event.type === 'extension_error') {
      if (extensionCommand && event.event === 'command' && event.extensionPath === `command:${extensionCommand}`) {
        extensionCommandError = bounded(event.error, 4_000)
      }
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
    if (question && stagedCustomAnswer !== undefined) {
      const answer = stagedCustomAnswer
      stagedCustomAnswer = undefined
      // The questionnaire follows its sentinel with the same question + input label.
      // Older versions sent only the label; do not accept another question's suffix.
      if (event.method === 'input' && (event.title === answer.inputTitle || event.title === 'Type your answer:')) {
        rpc.notify(abortController.signal.aborted
          ? { type: 'extension_ui_response', id: event.id, cancelled: true }
          : { type: 'extension_ui_response', id: event.id, value: answer.value })
        return
      }
    }
    if (!question || !request.requestUserInput) {
      if (question) rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true })
      else request.emit(piEvent(request.runId, {
        kind: 'harness',
        stage: 'runtime:extension_ui',
        providerId: 'pi', runtimeProvider: 'pi_rpc',
        isError: event.method === 'notify' && event.notifyType === 'error',
        text: bounded(event.method === 'notify' ? event.message : event, 4_000),
        runtimeMetadata: { method: event.method, notifyType: event.notifyType }
      }))
      return
    }
    void request.requestUserInput(question, abortController.signal)
      .then((response) => {
        const customOption = nativeCustomAnswerOption(event)
        if (customOption && response.behavior === 'answered') {
          const prompt = question.questions[0]
          const answer = response.answers[prompt.question]
          if (response.nativeCustomAnswer || !prompt.options.some((option) => (option.answerValue ?? option.label) === answer)) {
            // RPC select titles append previews; the follow-up input omits them.
            // Use the raw title, not the bounded display copy in question.questions.
            const title = String(event.title ?? 'Pi Extension').split(/\n\n--- \d+\. [^\n]+ preview ---\n/, 1)[0]
            stagedCustomAnswer = { value: answer, inputTitle: `${title}\n\nType your answer:` }
            rpc.notify({ type: 'extension_ui_response', id: event.id, value: customOption })
            return
          }
        }
        rpc.notify(extensionResponse(event, question, response))
      })
      .catch(() => rpc.notify({ type: 'extension_ui_response', id: event.id, cancelled: true }))
  })
  const uncertainSteer = (message: string): AgentSteerResult => {
    state.steerAdmissionUncertain = true
    return { status: 'unknown', message }
  }
  state.steer = async (input) => {
    if (state.stopped) return { status: 'rejected', message: 'Pi run 已停止，steer 未发送' }
    if (agentSettled || agentEnded) return { status: 'rejected', message: 'Pi agent 已结束，steer 未发送' }
    if (!agentStarted) return { status: 'unavailable', message: 'Pi agent 尚未进入 active run' }
    const images = input.attachments.map((attachment) => ({
      type: 'image',
      data: attachment.dataBase64,
      mimeType: attachment.mimeType
    }))
    steerPending = true
    state.steerDispatched = true
    const cycleEnd = agentCycleEnd
    try {
      const outcome = await Promise.race([
        rpc.send({ type: 'steer', message: input.prompt, ...(images.length > 0 ? { images } : {}) })
          .then(() => 'ack' as const),
        cycleEnd.then(() => 'ended' as const)
      ])
      // Pi's RPC response has no turn guard. Once agent_end/settled wins the race, the
      // message may have been admitted to a future idle queue; never report it accepted.
      if (outcome === 'ended' || cycleEnd !== agentCycleEnd || agentEnded || agentSettled || state.stopped) {
        return uncertainSteer('Pi agent 在 steer 确认前结束，消息归属未知')
      }
      return { status: 'accepted', providerTurnId: state.providerTurnId }
    } catch (error) {
      if (cycleEnd !== agentCycleEnd || agentEnded || agentSettled || state.stopped) {
        return uncertainSteer('Pi agent 在 steer 确认前结束，消息归属未知')
      }
      if (error instanceof PiRpcCommandError) {
        return { status: 'rejected', message: `Pi steer 被 Provider 拒绝：${error.message}` }
      }
      // Timeout, process exit and stdin write failures do not prove whether Pi admitted it.
      return uncertainSteer(`Pi steer admission 未知：${(error as Error).message}`)
    } finally {
      steerPending = false
    }
  }
  const startedAt = Date.now()
  try {
    // Capability probes remain bounded; an explicitly started run stays cancellable while
    // large native history/extensions load, rather than being killed by a startup clock.
    const initialState = record((await rpc.send({ type: 'get_state' }, null)).data)
    if (typeof initialState.sessionId === 'string' && initialState.sessionId) {
      state.sessionId = initialState.sessionId
      state.sessionFile = typeof initialState.sessionFile === 'string' ? initialState.sessionFile : undefined
      publishPersistedPiSession(request, state)
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
    let modelChanged = false
    if (request.model) {
      if (!request.model.providerId) throw new Error('Pi 模型选择缺少 upstream providerId')
      const currentModel = record(initialState.model)
      modelChanged = currentModel.provider !== request.model.providerId || currentModel.id !== request.model.id
      // Even a same-model set performs auth lookup, appends a model-change entry and reapplies
      // native thinking defaults. Preserve that last effect when no explicit effort was selected.
      // Compare with this run's fresh state, not UI state or a previous pooled turn.
      if (modelChanged || !request.effort) {
        await rpc.send({ type: 'set_model', provider: request.model.providerId, modelId: request.model.id })
      }
    }
    // A model switch may clamp/reset thinking; the pre-switch level is no longer authoritative.
    if (request.effort && (modelChanged || request.effort !== initialState.thinkingLevel)) {
      await rpc.send({ type: 'set_thinking_level', level: request.effort })
    }
    // Model-window telemetry is optional. Do not put its native catalog latency in front of
    // entry baseline, recorder identity, or the prompt; the response can enrich context usage
    // while the turn is already running. The rejection is handled here so a delayed/failed
    // capability query cannot become an unhandled promise or change the run outcome.
    void rpc.send({ type: 'get_available_models' }).then((response) => {
      const available = record(response.data).models
      if (Array.isArray(available)) {
        for (const [key, value] of piModelContextWindows(available.map(record))) modelContextWindows.set(key, value)
      }
    }).catch(() => {
      // Model-window telemetry is optional; usage remains available without Context%.
    })
    const explicitSkillEvent = await proveExplicitPiSkill(rpc, request)
    extensionCommand = await piExtensionCommand(rpc, request.prompt)
    const entryBaseline = await piEntryBaseline(rpc)
    if (state.stopped) return { externalSessionId: state.persistedSessionId, stopped: true, status: 'interrupted' }
    if (request.managedRecorder) {
      if (!request.cwd || !state.sessionId || !request.managedRecorderIdentity) {
        throw new PiRecorderError('Pi managed recorder 缺少 workspace、session 或受信任轮次身份')
      }
      try {
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
          throw new Error(`无法建立轮次身份：${opened.reason ?? opened.status}`)
        }
      } catch (error) {
        throw new PiRecorderError(`Pi managed recorder 启动失败：${String((error as Error).message)}`, {
          cause: error
        })
      }
    }
    if (explicitSkillEvent) request.emit(explicitSkillEvent)
    const images = request.attachments.map((attachment) => ({
      type: 'image',
      data: attachment.dataBase64,
      mimeType: attachment.mimeType
    }))
    let promptDispatched = false
    try {
      if (state.stopped) throw new Error('Pi prompt 发送前已停止')
      promptDispatched = true
      // Accepted execution stays owned until Pi acknowledges it or the user stops this process.
      await rpc.send({ type: 'prompt', message: request.prompt, ...(images.length > 0 ? { images } : {}) }, null)
    } catch (error) {
      const identity = request.managedRecorderIdentity
      if (
        request.managedRecorder &&
        request.cwd &&
        state.sessionId &&
        identity &&
        (!promptDispatched || (error instanceof PiRpcCommandError && error.command === 'prompt'))
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
          throw new PiRecorderError('Pi prompt 未执行，但 provisional recorder lifecycle 撤销失败', {
            cause: new AggregateError([error, cancelError])
          })
        }
      }
      throw error
    }
    if (extensionCommand && !agentStarted && !state.stopped) {
      // Pi acknowledges an extension prompt only after its handler returns. A menu/settings
      // command need not append a user message or emit agent_settled. Do not wait for a model
      // boundary that has not been observed; this result proves the command handler only.
      const commandState = record((await rpc.send({ type: 'get_state' })).data)
      const response = await rpc.send({
        type: 'get_entries',
        ...(entryBaseline.appendCursor ? { since: entryBaseline.appendCursor } : {})
      })
      const entries = record(response.data).entries
      if (!Array.isArray(entries)) throw new Error('Pi RPC get_entries 返回了无效增量 entries')
      const hasModelEntry = entries.some((entry) => {
        const message = record(record(entry).message)
        return ['user', 'assistant', 'toolResult'].includes(String(message.role))
      })
      if (!agentStarted && !hasModelEntry && commandState.isStreaming === false &&
        commandState.isCompacting === false && commandState.pendingMessageCount === 0 &&
        commandState.sessionId === state.sessionId) {
        if (request.managedRecorder && request.cwd && state.sessionId && request.managedRecorderIdentity) {
          try {
            await cancelManagedRecorderTurn({
              workspace: request.cwd, provider: 'pi', sessionId: state.sessionId,
              runId: request.managedRecorderIdentity.runId,
              promptHash: request.managedRecorderIdentity.promptHash
            })
          } catch (error) {
            throw new PiRecorderError('Pi 命令已返回，但 provisional recorder lifecycle 撤销失败', { cause: error })
          }
        }
        request.emit(piEvent(request.runId, {
          kind: 'harness', stage: 'result', providerId: 'pi', runtimeProvider: 'pi_rpc',
          text: extensionCommandError ?? `/${extensionCommand} 命令交互已结束；未观测到模型轮次`,
          isError: extensionCommandError !== undefined,
          durationMs: Date.now() - startedAt,
          providerCommand: { name: extensionCommand, source: 'extension', modelTurn: 'unobserved' }
        }))
        publishPersistedPiSession(request, state)
        retainRpc = mayReuse && !state.stopped && !state.steerAdmissionUncertain && Boolean(state.persistedSessionId) && rpc.reusable()
        return {
          externalSessionId: state.persistedSessionId, stopped: state.stopped,
          status: state.stopped ? 'interrupted' : extensionCommandError === undefined ? 'completed' : 'failed'
        }
      }
    }
    state.providerTurnId = await waitForPiUserEntryId(
      rpc,
      entryBaseline,
      () => agentSettled,
      () => state.steerDispatched === true
    )
    publishPersistedPiSession(request, state)
    // Pi workflows can intentionally run for hours. Do not impose a wall-clock or inactivity
    // deadline here: transport/process failures reject rpcFailure, and users retain stop controls.
    await Promise.race([settled, rpcFailure])
    // Startup supplies the native ID/path; persistence is checked independently. Asking Pi
    // for one more state snapshot after abort only delays the queued next turn and can hit
    // an avoidable timeout while the launcher is shutting down.
    let finalState = initialState
    if (!state.stopped) {
      try {
        finalState = record((await rpc.send({ type: 'get_state' })).data)
      } catch (error) {
        // The native turn has already settled. A metadata refresh timeout cannot rewrite that
        // outcome as a failed Agent run; retain startup identity and expose the evidence gap.
        request.emit(piEvent(request.runId, {
          kind: 'harness',
          stage: 'runtime:telemetry_degraded',
          text: `Pi final state unavailable: ${String((error as Error).message)}`,
          runtimeMetadata: { source: 'pi_rpc', capability: 'final_state' }
        }))
      }
    }
    if (typeof finalState.sessionId === 'string' && finalState.sessionId) {
      state.sessionId = finalState.sessionId
      state.sessionFile = typeof finalState.sessionFile === 'string' ? finalState.sessionFile : undefined
      publishPersistedPiSession(request, state)
    }
    const endedByTool = !state.stopped && usage.lastStopReason === 'toolUse' &&
      toolTermination !== undefined && toolNames.size === 0
    const unprovenToolBoundary = usage.lastStopReason === 'toolUse' && !endedByTool
    const stopReason = endedByTool ? toolTermination?.message : usage.lastError ?? usage.lastStopReason
    const failureText = unprovenToolBoundary
      ? 'Pi 在工具调用后结束，但缺少明确的工具终止证据；本轮结果未验证'
      : usage.lastError && usage.lastTransportError && usage.lastTransportError !== usage.lastError && !endedByTool
        ? `${usage.lastError} (${usage.lastTransportError})`
        : stopReason
    const terminationReason = endedByTool ? undefined : classifyRunTermination({ rawReason: usage.lastStopReason, message: failureText })
    // A settled Rotom RPC remains bound to this native session and retains its provider transport.
    // Reusing it makes Scry match terminal Pi instead of paying a fresh WebSocket/proxy handshake
    // and replaying the complete context on every user turn. An uncertain native steer may still
    // be queued in Pi's idle queue, so quarantine this transport rather than carry it forward.
    retainRpc = mayReuse && !state.stopped && !state.steerAdmissionUncertain && Boolean(state.persistedSessionId) && rpc.reusable()
    // Pi may settle cleanly at the RPC layer while the upstream model reports `aborted` (for
    // example Qoder aborting a long generation). Only an explicit Scry stop is an interruption;
    // an explicit tool termination is a separate execution boundary, not Goal approval.
    const failed = !state.stopped && !endedByTool && Boolean(usage.lastStopReason && usage.lastStopReason !== 'stop')
    request.emit(piEvent(request.runId, {
      kind: 'harness',
      stage: 'result',
      text: failureText,
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
      ...(endedByTool ? { toolTermination } : {}),
      runtimeMetadata: {
        agentProfileId: profile.id,
        sessionFile: finalState.sessionFile ?? null,
        model: usage.model ?? null,
        provider: usage.upstreamProvider ?? null,
        stderrTail: rpc.stderrTail() || null,
        transportError: usage.lastTransportError ?? null,
        shellEnvError: launchShellEnvError ?? null
      }
    }))
    if (failed) {
      const transportFailure = Boolean(
        usage.lastTransportError || usage.lastError?.toLowerCase().includes('fetch failed')
      )
      throw new AgentRuntimeError(failureText ?? 'Pi Provider 未正常完成本轮', {
        provider: 'pi_rpc',
        stage: 'runtime',
        cwd: request.cwd,
        nextAction: unprovenToolBoundary
          ? '先检查最后一项工具结果与 Rotom 日志，确认执行状态；不要在结果未知时重复执行'
          : terminationReason === 'input_context_overflow'
            ? '点击失败卡片的“从失败处恢复”，在新分支中移除或压缩大图后重试；也可以新建会话'
            : transportFailure
              ? launchShellEnvError ?? '检查上游服务和代理连接（WebSocket 与 SSE）；若修改了 shell 代理配置，请重启 Scry 后重试'
              : '继续当前会话重试；若再次中止，请检查上游 Provider 状态与 Rotom 日志'
      })
    }
    return {
      externalSessionId: state.persistedSessionId,
      providerTurnId: state.providerTurnId,
      stopped: state.stopped,
      status: state.stopped ? 'interrupted' : 'completed'
    }
  } catch (error) {
    if (state.stopped && !(error instanceof PiRecorderError)) return {
      externalSessionId: state.persistedSessionId,
      providerTurnId: state.providerTurnId,
      stopped: true,
      status: 'interrupted'
    }
    if (error instanceof AgentRuntimeError) throw error
    const recorderFailure = error instanceof PiRecorderError
    throw new AgentRuntimeError(String((error as Error).message), {
      provider: 'pi_rpc',
      stage: recorderFailure ? 'ledger' : 'runtime',
      cwd: request.cwd,
      nextAction: recorderFailure
        ? '运行 scry doctor 检查工作区记录；升级 Recorder 后重试'
        : '检查该轮 Pi Provider 结果、launcher 与 stderr 后重试'
    })
  } finally {
    off()
    offFailure()
    emitBackground(background.end())
    abortController.abort()
    if (retainRpc && state.sessionId && rotomPool) rotomPool.keep(profile, request.cwd, state.sessionId, rpc, env)
    else await rpc.close()
    if (state.rpc === rpc) state.rpc = undefined
  }
}

export function createPiAdapter(options: {
  listProfiles: () => Promise<PiAgentProfile[]>
  resolveProfile: (id: string) => Promise<PiAgentProfile | undefined>
  /** Tests may lower the frame residency boundary without allocating tens of MiB. */
  rpcMaxFrameBytes?: number
}): ProviderAdapter {
  const rotomPool = new RotomRpcPool()
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
            const snapshot = await rpc.send({ type: 'get_entries' }, PI_RPC_STARTUP_TIMEOUT_MS)
            const entries = record(snapshot.data).entries
            const target = Array.isArray(entries)
              ? entries.map(record).find((entry) => entry.id === request.replaceForkTurnId)
              : undefined
            if (!target || record(target.message).role !== 'user') {
              throw new Error('Pi 会话无法定位待替换的用户消息 entry')
            }
            const forked = await rpc.send({ type: 'fork', entryId: request.replaceForkTurnId }, null)
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
            const snapshot = record((await rpc.send({ type: 'get_entries' }, PI_RPC_STARTUP_TIMEOUT_MS)).data)
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
              ? await rpc.send({ type: 'fork', entryId: target.entryId }, null)
              : await rpc.send({ type: 'clone' }, null)
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
        let result: ProviderRunResult
        try {
          result = await runPiAgent(profile, request, state, options.rpcMaxFrameBytes, rotomPool)
        } finally {
          // Prompt admission can race a stop/transport exit. Recheck after transport
          // cleanup, including failures, so persisted history remains resumable.
          publishPersistedPiSession(request, state)
        }
        return { ...result, externalSessionId: state.persistedSessionId }
      })()
      return {
        promise,
        interrupt: () => {
          state.stopped = true
          state.rpc?.notify({ type: 'abort' })
          setTimeout(() => state.rpc?.abort(), 2_000)
        },
        steer: (input) => state.steer?.(input) ?? Promise.resolve({
          status: 'unavailable', message: 'Pi native run 尚未准备好'
        }),
        forceKill: () => {
          state.stopped = true
          state.rpc?.forceTerminate()
        },
        // 每轮 run 自己 spawn 一个 Pi RPC 子进程：SIGKILL 不会波及其他 run。
        forceKillScope: 'run_scoped',
        getExternalSessionId: () => state.persistedSessionId,
        getProviderTurnId: () => state.providerTurnId
      }
    },
    invalidateContext(context) {
      return rotomPool.invalidate(context)
    },
    dispose() {
      return rotomPool.dispose()
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
