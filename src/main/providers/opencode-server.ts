import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { runtimeCliEnv } from '../claude-locate'

const HOOK_PREFIX = 'SCRY_OPENCODE_HOOK\t'
const MAX_HOOK_FRAME = 64 * 1024

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

const HOOK_PLUGIN = `
const prefix = ${JSON.stringify(HOOK_PREFIX)}
const emit = (type, input = {}) => {
  const picked = { sessionID: input.sessionID, callID: input.callID, tool: input.tool, command: input.command }
  process.stderr.write(prefix + JSON.stringify({ v: 1, type, ts: Date.now(), input: picked }) + "\\n")
}
export const ScryObserver = async () => {
  emit("init")
  return {
    "tool.execute.before": async (input) => emit("tool.execute.before", input),
    "tool.execute.after": async (input) => emit("tool.execute.after", input),
    "command.execute.before": async (input) => emit("command.execute.before", input),
    "permission.ask": async (input) => emit("permission.ask", input)
  }
}
`

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
    return { enabled: process.env.SCRY_OPENCODE_HOOK_BRIDGE?.trim() !== '0', ready: this.hookReady, error: this.hookError }
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
    const port = await freePort()
    const hookEnabled = process.env.SCRY_OPENCODE_HOOK_BRIDGE?.trim() !== '0'
    let hookPlugin: string | undefined
    this.hookReady = false
    this.hookError = undefined
    if (hookEnabled) {
      this.hookConfigDir = await mkdtemp(join(tmpdir(), 'scry-opencode-'))
      const plugins = join(this.hookConfigDir, 'plugins')
      await mkdir(plugins, { recursive: true })
      hookPlugin = join(plugins, 'scry-observer.js')
      await writeFile(hookPlugin, HOOK_PLUGIN, { mode: 0o600 })
    }
    const child = spawn(executable, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
      cwd,
      env: {
        ...runtimeCliEnv(),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(hookPlugin ? { plugin: [pathToFileURL(hookPlugin).href] } : {})
      },
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
      client: createOpencodeClient({ baseUrl: url, directory: cwd })
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
