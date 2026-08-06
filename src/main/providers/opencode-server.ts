import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
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

async function isolatedOpenCodeAuthContent(env: NodeJS.ProcessEnv): Promise<string> {
  const merged: Record<string, Record<string, unknown>> = {}
  const configuredDataHome = env.XDG_DATA_HOME?.trim()
  const dataHome = configuredDataHome && isAbsolute(configuredDataHome)
    ? configuredDataHome
    : join(env.HOME?.trim() || userInfo().homedir, '.local', 'share')
  try {
    Object.assign(merged, sanitizeOpenCodeAuth(JSON.parse(await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8'))))
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
  }) | null = null
  private starting: Promise<OpenCodeServerState> | null = null
  private pendingChild: ChildProcessWithoutNullStreams | null = null
  private pendingDispatcher: Dispatcher | null = null
  private startGeneration = 0
  private hookConfigDir: string | null = null
  private lastExit: OpenCodeServerExitDiagnostic | undefined
  private readonly expectedStops = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(private readonly executable: () => string | undefined) {}

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
