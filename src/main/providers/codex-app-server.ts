import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

interface JsonRpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
  emittedAtMs?: number
}

export interface CodexAppServerOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
}

export interface CodexNotificationEnvelope {
  emittedAtMs?: number
  receivedAtMs: number
}

interface GenerationFailureState {
  generation: number
  promise: Promise<Error>
  resolve: (error: Error) => void
  settled: boolean
}

type NotificationListener = (
  method: string,
  params: unknown,
  envelope: CodexNotificationEnvelope
) => void

type ServerRequestListener = (
  method: string,
  params: unknown,
  envelope: CodexNotificationEnvelope
) => Promise<unknown> | unknown

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private processGeneration = 0
  private nextGeneration = 1
  private generationFailureState: GenerationFailureState | null = null
  private startPromise: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number | string, {
    generation: number
    method: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()
  private readonly listeners = new Set<NotificationListener>()
  private readonly requestListeners = new Set<ServerRequestListener>()

  constructor(private readonly options: CodexAppServerOptions) {}

  get pid(): number | undefined {
    return this.process?.pid
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.startPromise) return this.startPromise
    if (this.process) return
    this.startPromise = this.spawnAndInitialize()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    // app-server 默认以 JSONL/stdio 服务；当前 Codex 构建不接受 `--stdio`，传入后会立即退出。
    const child = spawn(this.options.command, this.options.args ?? ['app-server'], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const generation = this.nextGeneration++
    let resolveGenerationFailure: (error: Error) => void = () => {}
    const generationFailureState: GenerationFailureState = {
      generation,
      promise: new Promise((resolve) => {
        resolveGenerationFailure = resolve
      }),
      resolve: (error) => resolveGenerationFailure(error),
      settled: false
    }
    this.process = child
    this.processGeneration = generation
    this.generationFailureState = generationFailureState
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8_000)
    })
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line, generation))
    child.once('error', (error) => this.failGeneration(child, generation, error))
    child.once('exit', (code, signal) => {
      const detail = stderr.trim()
      this.failGeneration(
        child,
        generation,
        new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`)
      )
    })
    try {
      await this.requestOnGeneration('initialize', {
        clientInfo: { name: 'scry', title: 'Scry', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }, child, generation)
      await this.writeOnGeneration({ method: 'initialized' }, child, generation)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.failGeneration(child, generation, failure)
      await this.stopGeneration(child, generation)
      throw failure
    }
  }

  private writeOnGeneration(
    message: JsonRpcMessage,
    child: ChildProcessWithoutNullStreams,
    generation: number
  ): Promise<void> {
    if (this.process !== child || generation !== this.processGeneration || child.stdin.destroyed) {
      return Promise.reject(new Error('Codex app-server is not running'))
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private write(message: JsonRpcMessage, generation = this.processGeneration): void {
    const child = this.process
    if (!child || generation !== this.processGeneration || child.stdin.destroyed) {
      throw new Error('Codex app-server is not running')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.start()
    const child = this.process
    if (!child) throw new Error('Codex app-server failed to start')
    return this.requestOnGeneration<T>(method, params, child, this.processGeneration)
  }

  failureForCurrentGeneration(): Promise<Error> {
    const state = this.generationFailureState
    if (!this.process || !state || state.generation !== this.processGeneration) {
      throw new Error('Codex app-server is not running')
    }
    return state.promise
  }

  private requestOnGeneration<T = unknown>(
    method: string,
    params: unknown,
    child: ChildProcessWithoutNullStreams,
    generation: number
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const suffix = method === 'turn/start' ? ' (termination_unconfirmed)' : ''
        const error = new Error(`Codex app-server request timed out: ${method}${suffix}`)
        this.failGeneration(child, generation, error)
        void this.stopGeneration(child, generation)
      }, this.options.requestTimeoutMs ?? 30_000)
      this.pending.set(id, { generation, method, resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.write({ id, method, params }, generation)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.notifyOnGeneration(method, params, this.processGeneration)
  }

  private notifyOnGeneration(method: string, params: unknown, generation: number): void {
    this.write(params === undefined ? { method } : { method, params }, generation)
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onRequest(listener: ServerRequestListener): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  private handleLine(line: string, generation: number): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending || pending.generation !== generation) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'))
      else pending.resolve(message.result)
      return
    }
    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message, generation)
      return
    }
    if (message.method) {
      if (generation !== this.processGeneration) return
      const receivedAtMs = Date.now()
      const emittedAtMs =
        typeof message.emittedAtMs === 'number' && Number.isFinite(message.emittedAtMs)
          ? message.emittedAtMs
          : undefined
      for (const listener of this.listeners) {
        listener(message.method, message.params, { emittedAtMs, receivedAtMs })
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage, generation: number): Promise<void> {
    const id = message.id
    if (id === undefined || !message.method) return
    const envelope = {
      receivedAtMs: Date.now(),
      emittedAtMs: typeof message.emittedAtMs === 'number' ? message.emittedAtMs : undefined
    }
    try {
      for (const listener of this.requestListeners) {
        const result = await listener(message.method, message.params, envelope)
        if (result !== undefined) {
          this.write({ id, result }, generation)
          return
        }
      }
      this.write({ id, error: { code: -32601, message: `Scry does not handle server request: ${message.method}` } }, generation)
    } catch (error) {
      if (generation === this.processGeneration) {
        this.write({ id, error: { code: -32000, message: String((error as Error).message) } }, generation)
      }
    }
  }

  private failGeneration(child: ChildProcessWithoutNullStreams, generation: number, error: Error): void {
    const state = this.generationFailureState
    if (state?.generation === generation && !state.settled) {
      state.settled = true
      state.resolve(error)
    }
    if (this.process === child && this.processGeneration === generation) this.process = null
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private async stopGeneration(child: ChildProcessWithoutNullStreams, generation: number): Promise<void> {
    if (this.stopping) return this.stopping
    const stop = (async () => {
      if (child.exitCode == null && child.signalCode == null && !child.killed) child.kill('SIGTERM')
      await this.waitForExit(child, 1_000)
      if (child.exitCode == null && child.signalCode == null) {
        child.kill('SIGKILL')
        await this.waitForExit(child, 1_000)
      }
      this.failGeneration(child, generation, new Error('Codex app-server terminated after request failure'))
    })()
    this.stopping = stop
    try {
      await stop
    } finally {
      if (this.stopping === stop) this.stopping = null
    }
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  close(): void {
    const child = this.process
    if (!child) return
    const generation = this.processGeneration
    this.failGeneration(child, generation, new Error('Codex app-server closed'))
    void this.stopGeneration(child, generation)
  }

  async shutdown(): Promise<void> {
    const child = this.process
    if (!child) {
      if (this.stopping) await this.stopping
      return
    }
    const generation = this.processGeneration
    this.failGeneration(child, generation, new Error('Codex app-server closed'))
    await this.stopGeneration(child, generation)
  }
}
