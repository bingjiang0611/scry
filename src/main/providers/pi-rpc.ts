import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import type { ProviderContext } from '../../shared/provider'
import type { TraceEvent } from '../../shared/trace'
import { createPiRpcDecoder } from './pi-rpc-decoder'
import { PI_RPC_COMMAND_TIMEOUT_MS, PI_RPC_MAX_FRAME_BYTES } from './pi-runtime'
import { type JsonRecord } from './pi-shared'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { PerformanceTrace } from '../performance-timing'

let eventCounter = 0
export const piEventSequence = (): number => eventCounter++
export const piEvent = (runId: string, fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>): TraceEvent => ({
  id: `pi-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`,
  runId,
  ts: new Date().toISOString(),
  ...fields
})

export class PiRpcProcess {
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
  private catalogResponses = 0
  private catalogTrace?: PerformanceTrace
  private readonly exited: Promise<void>

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly profile: PiAgentProfile,
    private readonly maxFrameBytes = PI_RPC_MAX_FRAME_BYTES,
    catalogTrace?: PerformanceTrace
  ) {
    this.catalogTrace = catalogTrace
    if (catalogTrace) child.once('spawn', () => catalogTrace.mark('spawned'))
    this.exited = new Promise((resolve) => child.once('close', () => {
      this.closed = true
      this.catalogTrace?.mark('closed')
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

  static start(profile: PiAgentProfile, args: string[], env: Record<string, string>, cwd?: string, maxFrameBytes = PI_RPC_MAX_FRAME_BYTES, catalogTrace?: PerformanceTrace): PiRpcProcess {
    const child = spawn(profile.executable, args, {
      cwd: cwd || homedir(),
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return new PiRpcProcess(child, profile, maxFrameBytes, catalogTrace)
  }

  private receive(message: JsonRecord): void {
    if (this.failed) return
    if (message.type === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        // Catalog timing sees only lifecycle/counts, never RPC data, command names or errors.
        if (this.catalogTrace) {
          this.catalogResponses++
          if (this.catalogResponses === 1) this.catalogTrace.mark('first_response')
          if (this.pending.size === 0) this.catalogTrace.mark('responses_received', { rpcResponses: this.catalogResponses })
        }
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

  // A reused process attributes each new operation to that operation's own trace, so a parked
  // process reports its reads instead of crediting the trace of the call that started it.
  attachCatalogTrace(trace: PerformanceTrace | undefined): void {
    this.catalogTrace = trace
    this.catalogResponses = 0
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

export class RotomRpcPool {
  private readonly idle = new Map<string, IdleRotomRpc>()

  private key(profile: PiAgentProfile, cwd: string | undefined, sessionId: string, continuationKey?: string): string {
    return `${profile.id}\0${profile.executable}\0${cwd ?? ''}\0${sessionId}\0${continuationKey ?? ''}`
  }

  async take(profile: PiAgentProfile, cwd: string | undefined, sessionId: string | undefined, env: Record<string, string>, continuationKey?: string): Promise<PiRpcProcess | undefined> {
    if (!sessionId) return undefined
    const key = this.key(profile, cwd, sessionId, continuationKey)
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

  keep(profile: PiAgentProfile, cwd: string | undefined, sessionId: string, rpc: PiRpcProcess, env: Record<string, string>, continuationKey?: string): void {
    if (!rpc.reusable()) {
      void rpc.close().catch(() => undefined)
      return
    }
    const key = this.key(profile, cwd, sessionId, continuationKey)
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

export class PiRpcCommandError extends Error {
  constructor(readonly command: string, message: string) {
    super(message)
    this.name = 'PiRpcCommandError'
  }
}

export class PiRpcTransportError extends Error {
  constructor(readonly reason: 'timeout' | 'write' | 'process', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PiRpcTransportError'
  }
}

export class PiRecorderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PiRecorderError'
  }
}
