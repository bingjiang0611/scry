import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { Agent as UndiciAgent, type Dispatcher } from 'undici'
import { runtimeCliEnv } from '../claude-locate'
import { authorizedMcpServers, isRemoteMcpConfig } from '../mcp-config'
import type { AuthorizedMcpExecution } from './types'

export const OPEN_CODE_LONG_REQUEST_TIMEOUTS = {
  headersTimeout: 0,
  bodyTimeout: 0
} as const

const LONG_REQUEST_PATH = /^\/session\/[^/]+\/(?:command|message)$/

export function createOpenCodeFetch(
  dispatcher: Dispatcher,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  return (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const longRunning = request.method === 'POST' && LONG_REQUEST_PATH.test(new URL(request.url).pathname)
    return longRunning
      ? fetchImpl(request, { dispatcher } as unknown as RequestInit)
      : fetchImpl(input, init)
  }
}

export function sanitizeOpenCodeServerLog(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(
      /\b((?:[A-Z0-9]+_)*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE))["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]'
    )
    .slice(-2_000)
}

export function sanitizeOpenCodeAuth(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const safe: Record<string, Record<string, unknown>> = {}
  for (const [provider, auth] of Object.entries(value)) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) continue
    const type = (auth as Record<string, unknown>).type
    if (type === 'api' || type === 'oauth') safe[provider] = { ...(auth as Record<string, unknown>) }
  }
  return safe
}

export function openCodeMcpAuthFile(env: NodeJS.ProcessEnv): string {
  const configuredDataHome = env.XDG_DATA_HOME?.trim()
  const dataHome = configuredDataHome && isAbsolute(configuredDataHome)
    ? configuredDataHome
    : join(env.HOME?.trim() || userInfo().homedir, '.local', 'share')
  return join(dataHome, 'opencode', 'mcp-auth.json')
}

const openCodeMcpAuthWrites = new Map<string, Promise<void>>()
const OPEN_CODE_MCP_AUTH_WRITE_ATTEMPTS = 5

function parseOpenCodeMcpAuth(contents: Buffer, source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(contents.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
    return value as Record<string, unknown>
  } catch {
    throw new Error(`OpenCode MCP OAuth 凭据文件格式无效：${source}`)
  }
}

async function readOptionalOpenCodeMcpAuth(source: string): Promise<Record<string, unknown> | null> {
  try {
    return parseOpenCodeMcpAuth(await readFile(source), source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)])
  )
}

type OpenCodeMcpTarget = AuthorizedMcpExecution['targets'][number]

function digestOpenCodeMcpIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex')
}

export function openCodeMcpCredentialKey(cwd: string, target: OpenCodeMcpTarget): string {
  return digestOpenCodeMcpIdentity({ cwd, targetId: target.targetId })
}

function privateOpenCodeMcpAuthFile(directory: string, cwd: string, target: OpenCodeMcpTarget): string {
  return join(directory, `${openCodeMcpCredentialKey(cwd, target)}.json`)
}

interface PrivateOpenCodeMcpAuth {
  version: 1
  workspaceDigest: string
  targetId: string
  configDigest: string
  serverName: string
  credential: unknown
}

function openCodeMcpWorkspaceDigest(cwd: string): string {
  return digestOpenCodeMcpIdentity({ cwd })
}

function openCodeMcpConfigDigest(target: OpenCodeMcpTarget): string {
  return digestOpenCodeMcpIdentity({ targetId: target.targetId, config: target.config })
}

function parsePrivateOpenCodeMcpAuth(contents: Buffer, source: string): PrivateOpenCodeMcpAuth {
  try {
    const value = JSON.parse(contents.toString('utf8')) as Record<string, unknown>
    if (
      value?.version !== 1
      || typeof value.workspaceDigest !== 'string'
      || typeof value.targetId !== 'string'
      || typeof value.configDigest !== 'string'
      || typeof value.serverName !== 'string'
      || !Object.hasOwn(value, 'credential')
    ) throw new Error('invalid envelope')
    return value as unknown as PrivateOpenCodeMcpAuth
  } catch {
    throw new Error(`Scry OpenCode MCP OAuth 凭据文件格式无效：${source}`)
  }
}

async function readOptionalPrivateOpenCodeMcpAuth(source: string): Promise<PrivateOpenCodeMcpAuth | null> {
  try {
    return parsePrivateOpenCodeMcpAuth(await readFile(source), source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function persistPrivateOpenCodeMcpAuth(
  source: string,
  directory: string,
  cwd: string,
  target: OpenCodeMcpTarget
): Promise<void> {
  const isolated = parseOpenCodeMcpAuth(await readFile(source), source)
  if (!Object.hasOwn(isolated, target.name)) {
    throw new Error(`OpenCode 未保存 MCP ${target.name} 的 OAuth 凭据`)
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = privateOpenCodeMcpAuthFile(directory, cwd, target)
  const previous = openCodeMcpAuthWrites.get(destination) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    const contents = Buffer.from(JSON.stringify({
      version: 1,
      workspaceDigest: openCodeMcpWorkspaceDigest(cwd),
      targetId: target.targetId,
      configDigest: openCodeMcpConfigDigest(target),
      serverName: target.name,
      credential: isolated[target.name]
    } satisfies PrivateOpenCodeMcpAuth))
    const temporary = `${destination}.scry-${randomBytes(8).toString('hex')}`
    try {
      await writeFile(temporary, contents, { mode: 0o600 })
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  })
  openCodeMcpAuthWrites.set(destination, write)
  try {
    await write
  } finally {
    if (openCodeMcpAuthWrites.get(destination) === write) openCodeMcpAuthWrites.delete(destination)
  }
}

/** Build an isolated Provider seed; Scry-private credentials are matched to exact workspace/config identities. */
export interface OpenCodeMcpAuthSeedOptions {
  /** Only a complete target inventory may prove that an omitted private credential is stale. */
  completeTargetInventory?: boolean
}

export async function openCodeMcpAuthSeed(
  providerFile: string,
  scryPrivateDirectory?: string,
  execution?: AuthorizedMcpExecution,
  options: OpenCodeMcpAuthSeedOptions = {}
): Promise<Buffer | null> {
  // A Provider-global file has only server names, not endpoint identities. It is safe only in
  // legacy/non-App callers; production Scry uses its identity-bound private directory instead.
  const provider = scryPrivateDirectory ? null : await readOptionalOpenCodeMcpAuth(providerFile)
  const merged = { ...(provider ?? {}) }
  if (scryPrivateDirectory && execution) {
    const workspaceDigest = openCodeMcpWorkspaceDigest(execution.cwd)
    const targetsById = new Map(execution.targets.map((target) => [target.targetId, target]))
    for (const target of execution.targets.filter((item) => item.enabled)) {
      const path = privateOpenCodeMcpAuthFile(scryPrivateDirectory, execution.cwd, target)
      const managed = await readOptionalPrivateOpenCodeMcpAuth(path)
      if (!managed) continue
      if (
        managed.workspaceDigest !== workspaceDigest
        || managed.targetId !== target.targetId
        || managed.configDigest !== openCodeMcpConfigDigest(target)
        || managed.serverName !== target.name
      ) {
        await rm(path, { force: true })
        continue
      }
      merged[target.name] = managed.credential
    }
    if (options.completeTargetInventory !== false) {
      try {
        for (const name of await readdir(scryPrivateDirectory)) {
          if (!name.endsWith('.json')) continue
          const path = join(scryPrivateDirectory, name)
          let candidate: PrivateOpenCodeMcpAuth
          try {
            candidate = parsePrivateOpenCodeMcpAuth(await readFile(path), path)
          } catch {
            continue
          }
          if (candidate.workspaceDigest === workspaceDigest && !targetsById.has(candidate.targetId)) {
            await rm(path, { force: true })
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return Object.keys(merged).length > 0 ? Buffer.from(JSON.stringify(merged)) : null
}

export async function persistOpenCodeMcpAuth(
  source: string,
  destination: string,
  serverName: string
): Promise<void> {
  const previous = openCodeMcpAuthWrites.get(destination) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    const isolated = parseOpenCodeMcpAuth(await readFile(source), source)
    if (!Object.hasOwn(isolated, serverName)) {
      throw new Error(`OpenCode 未保存 MCP ${serverName} 的 OAuth 凭据`)
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    for (let attempt = 1; attempt <= OPEN_CODE_MCP_AUTH_WRITE_ATTEMPTS; attempt += 1) {
      let before: Buffer | null = null
      let current: Record<string, unknown> = {}
      try {
        before = await readFile(destination)
        current = parseOpenCodeMcpAuth(before, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const contents = Buffer.from(JSON.stringify({ ...current, [serverName]: isolated[serverName] }))
      const temporary = `${destination}.scry-${randomBytes(8).toString('hex')}`
      try {
        await writeFile(temporary, contents, { mode: 0o600 })
        let latest: Buffer | null = null
        try {
          latest = await readFile(destination)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const unchanged = before === null ? latest === null : latest !== null && before.equals(latest)
        if (!unchanged) {
          await rm(temporary, { force: true })
          if (attempt === OPEN_CODE_MCP_AUTH_WRITE_ATTEMPTS) {
            throw new Error('OpenCode MCP OAuth 凭据文件在写入期间持续变化，请重试')
          }
          continue
        }
        await rename(temporary, destination)
        return
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    }
  })
  openCodeMcpAuthWrites.set(destination, write)
  try {
    await write
  } finally {
    if (openCodeMcpAuthWrites.get(destination) === write) openCodeMcpAuthWrites.delete(destination)
  }
}

async function isolatedOpenCodeAuthContent(env: NodeJS.ProcessEnv): Promise<string> {
  const merged: Record<string, Record<string, unknown>> = {}
  const dataHome = dirname(openCodeMcpAuthFile(env))
  try {
    Object.assign(merged, sanitizeOpenCodeAuth(JSON.parse(await readFile(join(dataHome, 'auth.json'), 'utf8'))))
  } catch {
    // Missing or malformed source auth means the isolated process starts unauthenticated.
  }
  try {
    if (env.OPENCODE_AUTH_CONTENT) Object.assign(merged, sanitizeOpenCodeAuth(JSON.parse(env.OPENCODE_AUTH_CONTENT)))
  } catch {
    // Never forward malformed or unclassified inherited auth content.
  }
  return JSON.stringify(merged)
}

export function isolatedOpenCodeChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  root: string,
  configPath: string,
  configDir: string,
  authContent: string,
  serverPassword: string
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => !key.startsWith('OPENCODE_') && !key.startsWith('XDG_'))
  )
  const openCodeApiKey = sourceEnv.OPENCODE_API_KEY?.trim()
  return {
    ...inherited,
    ...(openCodeApiKey ? { OPENCODE_API_KEY: openCodeApiKey } : {}),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CONFIG_DIRS: join(root, 'config-dirs'),
    XDG_DATA_DIRS: join(root, 'data-dirs'),
    OPENCODE_TEST_HOME: root,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, 'managed'),
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_AUTH_CONTENT: authContent,
    OPENCODE_DB: join(root, 'data', 'opencode.db'),
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_SERVER_PASSWORD: serverPassword,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true'
  }
}

export function openCodeServerAuthorization(serverPassword: string): string {
  return `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForOpenCodeHealth(
  url: string,
  authorization: string,
  child: ChildProcessWithoutNullStreams,
  startupError: () => Error | undefined
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const spawnError = startupError()
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`OpenCode server exited (${child.exitCode ?? child.signalCode ?? 'unknown'})`)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 500)
    try {
      const response = await fetch(`${url}/global/health`, {
        headers: { Authorization: authorization },
        signal: controller.signal
      })
      if (response.ok) return
    } catch {
      // The fixed local port may refuse connections until the child finishes binding.
    } finally {
      clearTimeout(timeout)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('OpenCode server 启动超时：本地健康检查在 10 秒内未就绪')
}

export interface OpenCodeServerState {
  cwd: string
  mcpFingerprint: string
  url: string
  pid?: number
  client: OpencodeClient
}

export interface OpenCodeServerExitDiagnostic {
  at: number
  code: number | null
  signal: NodeJS.Signals | null
  expected: boolean
}

export interface OpenCodeServerDiagnostic {
  running: boolean
  pid?: number
  lastExit?: OpenCodeServerExitDiagnostic
}

export function openCodeMcpConfig(execution?: AuthorizedMcpExecution): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(authorizedMcpServers(execution)).map(([name, config]) => {
      if (isRemoteMcpConfig(config)) {
        return [name, {
          type: 'remote',
          url: config.url,
          ...(config.headers && typeof config.headers === 'object' ? { headers: config.headers } : {}),
          ...(Object.hasOwn(config, 'oauth') ? { oauth: config.oauth } : {}),
          ...(typeof config.timeout === 'number' ? { timeout: config.timeout } : {}),
          enabled: true
        }]
      }
      return [name, {
        type: 'local',
        command: [String(config.command ?? ''), ...(Array.isArray(config.args) ? config.args.map(String) : [])],
        ...(config.env && typeof config.env === 'object' ? { environment: config.env } : {}),
        ...(typeof config.timeout === 'number' ? { timeout: config.timeout } : {}),
        enabled: true
      }]
    })
  )
}

export class OpenCodeServerManager {
  private active: (OpenCodeServerState & {
    process: ChildProcessWithoutNullStreams
    dispatcher: Dispatcher
    mcpAuthFile: string
  }) | null = null
  private starting: Promise<OpenCodeServerState> | null = null
  private pendingChild: ChildProcessWithoutNullStreams | null = null
  private pendingDispatcher: Dispatcher | null = null
  private startGeneration = 0
  private hookConfigDir: string | null = null
  private lastExit: OpenCodeServerExitDiagnostic | undefined
  private readonly expectedStops = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(
    private readonly executable: () => string | undefined,
    private readonly privateMcpAuthDirectory?: string,
    private readonly mcpAuthSeedOptions: OpenCodeMcpAuthSeedOptions = {}
  ) {}

  get state(): OpenCodeServerState | null {
    return this.active
  }

  get diagnostic(): OpenCodeServerDiagnostic {
    return {
      running: this.active?.process.exitCode === null,
      pid: this.active?.pid,
      lastExit: this.lastExit
    }
  }

  async ensure(cwd: string, mcpExecution?: AuthorizedMcpExecution): Promise<OpenCodeServerState> {
    const mcpFingerprint = mcpExecution?.fingerprint ?? 'none'
    if (this.active?.cwd === cwd && this.active.mcpFingerprint === mcpFingerprint && this.active.process.exitCode === null) return this.active
    if (this.starting) {
      const starting = await this.starting
      if (starting.cwd === cwd && starting.mcpFingerprint === mcpFingerprint) return starting
    }
    this.close()
    const starting = this.start(cwd, this.startGeneration, mcpExecution)
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  async persistMcpAuth(target: OpenCodeMcpTarget, cwd: string): Promise<void> {
    const active = this.active
    const root = this.hookConfigDir
    if (!active || !root) throw new Error('OpenCode server 当前未运行，无法保存 MCP OAuth 凭据')
    const source = join(root, 'data', 'opencode', 'mcp-auth.json')
    if (this.privateMcpAuthDirectory) {
      await persistPrivateOpenCodeMcpAuth(source, this.privateMcpAuthDirectory, cwd, target)
      return
    }
    await persistOpenCodeMcpAuth(source, active.mcpAuthFile, target.name)
  }

  private async start(cwd: string, generation: number, mcpExecution?: AuthorizedMcpExecution): Promise<OpenCodeServerState> {
    const executable = this.executable()
    if (!executable) throw new Error('OpenCode executable 未找到')
    if (process.platform === 'darwin') {
      const managedPreferences = [
        `/Library/Managed Preferences/${userInfo().username}/ai.opencode.managed.plist`,
        '/Library/Managed Preferences/ai.opencode.managed.plist'
      ]
      const configured = managedPreferences.find(existsSync)
      if (configured) throw new Error(`OpenCode managed config 无法安全隔离：${configured}`)
    }
    const port = await freePort()
    const sourceEnv = runtimeCliEnv()
    const providerMcpAuthFile = openCodeMcpAuthFile(sourceEnv)
    const mcpAuthFile = providerMcpAuthFile
    const mcpAuthSeed = await openCodeMcpAuthSeed(
      providerMcpAuthFile,
      this.privateMcpAuthDirectory,
      mcpExecution,
      this.mcpAuthSeedOptions
    )
    const isolatedAuthContent = await isolatedOpenCodeAuthContent(sourceEnv)
    if (generation !== this.startGeneration) throw new Error('OpenCode server 启动已取消')
    this.hookConfigDir = await mkdtemp(join(tmpdir(), 'scry-opencode-'))
    let isolatedConfigPath: string
    let isolatedConfigDir: string
    try {
      isolatedConfigDir = join(this.hookConfigDir, 'config')
      await mkdir(isolatedConfigDir, { mode: 0o700 })
      await Promise.all(['xdg-config', 'data', 'state', 'cache', 'runtime', 'config-dirs', 'data-dirs'].map((dir) =>
        mkdir(join(this.hookConfigDir!, dir), { mode: 0o700 })
      ))
      if (mcpAuthSeed) {
        const isolatedMcpAuthDir = join(this.hookConfigDir, 'data', 'opencode')
        await mkdir(isolatedMcpAuthDir, { recursive: true, mode: 0o700 })
        await writeFile(join(isolatedMcpAuthDir, 'mcp-auth.json'), mcpAuthSeed, { mode: 0o600 })
      }
      isolatedConfigPath = join(this.hookConfigDir, 'safe-config.json')
      await mkdir(join(this.hookConfigDir, 'managed'), { mode: 0o700 })
      await writeFile(isolatedConfigPath, JSON.stringify({ mcp: openCodeMcpConfig(mcpExecution) }), { mode: 0o600 })
      if (generation !== this.startGeneration) throw new Error('OpenCode server 启动已取消')
    } catch (error) {
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      throw error
    }
    const serverPassword = randomBytes(32).toString('base64url')
    const authorization = openCodeServerAuthorization(serverPassword)
    const child = spawn(executable, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
      cwd,
      env: isolatedOpenCodeChildEnv(
        sourceEnv,
        this.hookConfigDir,
        isolatedConfigPath,
        isolatedConfigDir,
        isolatedAuthContent,
        serverPassword
      ),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.pendingChild = child
    let output = ''
    const inspect = (chunk: Buffer | string): void => {
      output = (output + String(chunk)).slice(-12_000)
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    let dispatcher: Dispatcher | undefined
    let spawnError: Error | undefined
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('exit', (code, signal) => {
      this.lastExit = {
        at: Date.now(),
        code,
        signal,
        expected: this.expectedStops.has(child)
      }
      if (this.active?.process === child) this.active = null
      if (this.pendingChild === child) this.pendingChild = null
      dispatcher?.destroy()
    })
    const url = `http://127.0.0.1:${port}`
    try {
      await waitForOpenCodeHealth(url, authorization, child, () => spawnError)
      if (generation !== this.startGeneration || this.pendingChild !== child) {
        throw new Error('OpenCode server 启动已取消')
      }
    } catch (error) {
      this.expectedStops.add(child)
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM')
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      const detail = sanitizeOpenCodeServerLog(output).trim()
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `：${detail}` : ''}`, {
        cause: error instanceof Error ? error : undefined
      })
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const exit = child.exitCode ?? child.signalCode ?? 'unknown'
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      throw new Error(
        `OpenCode server exited before readiness commit (${exit}): ${sanitizeOpenCodeServerLog(output).trim()}`
      )
    }
    try {
      dispatcher = new UndiciAgent(OPEN_CODE_LONG_REQUEST_TIMEOUTS)
      this.pendingDispatcher = dispatcher
      const state = {
        cwd,
        mcpFingerprint: mcpExecution?.fingerprint ?? 'none',
        url,
        pid: child.pid,
        process: child,
        dispatcher,
        mcpAuthFile,
        client: createOpencodeClient({
          baseUrl: url,
          directory: cwd,
          headers: { Authorization: authorization },
          fetch: createOpenCodeFetch(dispatcher)
        })
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `OpenCode server exited during readiness commit (${child.exitCode ?? child.signalCode ?? 'unknown'})`
        )
      }
      this.lastExit = undefined
      this.active = state
      this.pendingChild = null
      this.pendingDispatcher = null
      return state
    } catch (error) {
      if (this.active?.process === child) this.active = null
      if (this.pendingChild === child) this.pendingChild = null
      if (this.pendingDispatcher === dispatcher) this.pendingDispatcher = null
      this.expectedStops.add(child)
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM')
      dispatcher?.destroy()
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  close(): void {
    this.startGeneration += 1
    const active = this.active
    this.active = null
    if (active) {
      this.expectedStops.add(active.process)
      if (!active.process.killed && active.process.exitCode === null) active.process.kill('SIGTERM')
      active.dispatcher.destroy()
    }
    const pendingChild = this.pendingChild
    this.pendingChild = null
    if (pendingChild) {
      this.expectedStops.add(pendingChild)
      if (!pendingChild.killed && pendingChild.exitCode === null) pendingChild.kill('SIGTERM')
    }
    this.pendingDispatcher?.destroy()
    this.pendingDispatcher = null
    const dir = this.hookConfigDir
    this.hookConfigDir = null
    if (dir) void rm(dir, { recursive: true, force: true })
  }
}
