import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { runtimeCliEnv } from '../claude-locate'

const HOOK_PREFIX = 'SCRY_OPENCODE_HOOK\t'
const MAX_HOOK_FRAME = 64 * 1024
const HOOK_DISABLED_REASON = 'OpenCode observer 在隔离配置目录中会阻塞 1.17.x 配置加载，当前版本已安全禁用'

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

export interface OpenCodeHookFrame {
  v: 1
  type: 'init' | 'tool.execute.before' | 'tool.execute.after' | 'command.execute.before' | 'permission.ask'
  ts: number
  input: Record<string, unknown>
}

export function parseOpenCodeHookLine(line: string): OpenCodeHookFrame | null {
  if (!line.startsWith(HOOK_PREFIX) || line.length > MAX_HOOK_FRAME) return null
  try {
    const frame = JSON.parse(line.slice(HOOK_PREFIX.length)) as OpenCodeHookFrame
    if (frame.v !== 1 || typeof frame.type !== 'string' || typeof frame.ts !== 'number' || !frame.input || typeof frame.input !== 'object') return null
    return frame
  } catch {
    return null
  }
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

export interface OpenCodeServerState {
  cwd: string
  url: string
  pid?: number
  client: OpencodeClient
}

export class OpenCodeServerManager {
  private active: (OpenCodeServerState & { process: ChildProcessWithoutNullStreams }) | null = null
  private starting: Promise<OpenCodeServerState> | null = null
  private hookConfigDir: string | null = null
  private hookReady = false
  private hookError: string | undefined
  private readonly hookListeners = new Set<(frame: OpenCodeHookFrame) => void>()

  constructor(private readonly executable: () => string | undefined) {}

  get state(): OpenCodeServerState | null {
    return this.active
  }

  get hookBridge(): { enabled: boolean; ready: boolean; error?: string } {
    return { enabled: false, ready: false, error: this.hookError ?? HOOK_DISABLED_REASON }
  }

  onHook(listener: (frame: OpenCodeHookFrame) => void): () => void {
    this.hookListeners.add(listener)
    return () => this.hookListeners.delete(listener)
  }

  async ensure(cwd: string): Promise<OpenCodeServerState> {
    if (this.active?.cwd === cwd && this.active.process.exitCode === null) return this.active
    if (this.starting) {
      const starting = await this.starting
      if (starting.cwd === cwd) return starting
    }
    this.close()
    this.starting = this.start(cwd)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async start(cwd: string): Promise<OpenCodeServerState> {
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
    const hookEnabled = false
    this.hookReady = false
    this.hookError = HOOK_DISABLED_REASON
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
      await writeFile(isolatedConfigPath, JSON.stringify({ mcp: {} }), { mode: 0o600 })
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
    let hookBuffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      hookBuffer += chunk
      const lines = hookBuffer.split('\n')
      hookBuffer = lines.pop() ?? ''
      if (hookBuffer.length > MAX_HOOK_FRAME) {
        hookBuffer = ''
        this.hookError = 'OpenCode Hook bridge frame exceeded 64 KiB'
      }
      for (const line of lines) {
        const frame = parseOpenCodeHookLine(line)
        if (!frame) continue
        if (frame.type === 'init') {
          this.hookReady = true
          this.hookError = undefined
        }
        for (const listener of this.hookListeners) listener(frame)
      }
    })
    let url: string
    try {
      url = await new Promise<string>((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error(`OpenCode server 启动超时: ${output.trim() || 'no output'}`))
        }, 10_000)
        const inspect = (chunk: Buffer | string): void => {
          output = (output + String(chunk)).slice(-12_000)
          const match = output.match(/opencode server listening.*?on\s+(https?:\/\/[^\s]+)/)
          if (!match) return
          clearTimeout(timeout)
          resolve(match[1])
        }
        child.stdout.on('data', inspect)
        child.stderr.on('data', inspect)
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('exit', (code, signal) => {
          clearTimeout(timeout)
          reject(new Error(`OpenCode server exited (${code ?? signal ?? 'unknown'}): ${output.trim()}`))
        })
      })
    } catch (error) {
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      throw error
    }
    const state = {
      cwd,
      url,
      pid: child.pid,
      process: child,
      client: createOpencodeClient({ baseUrl: url, directory: cwd, headers: { Authorization: authorization } })
    }
    child.once('exit', () => {
      if (this.active?.process === child) this.active = null
    })
    if (hookEnabled && !this.hookReady) this.hookError = 'OpenCode Hook bridge plugin did not initialize'
    this.active = state
    return state
  }

  close(): void {
    const active = this.active
    this.active = null
    if (active && !active.process.killed && active.process.exitCode === null) active.process.kill('SIGTERM')
    const dir = this.hookConfigDir
    this.hookConfigDir = null
    this.hookReady = false
    this.hookError = undefined
    if (dir) void rm(dir, { recursive: true, force: true })
  }
}
