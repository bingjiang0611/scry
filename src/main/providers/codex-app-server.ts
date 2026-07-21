import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

interface JsonRpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface CodexAppServerOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
}

type NotificationListener = (method: string, params: unknown) => void

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly listeners = new Set<NotificationListener>()
  private stderr = ''

  constructor(private readonly options: CodexAppServerOptions) {}

  get pid(): number | undefined {
    return this.process?.pid
  }

  async start(): Promise<void> {
    if (this.process) return
    if (this.startPromise) return this.startPromise
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
    this.process = child
    this.stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8_000)
    })
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, signal) => {
      const detail = this.stderr.trim()
      this.fail(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`))
    })
    await this.request('initialize', {
      clientInfo: { name: 'scry', title: 'Scry', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    this.notify('initialized')
  }

  private write(message: JsonRpcMessage): void {
    const child = this.process
    if (!child || child.stdin.destroyed) throw new Error('Codex app-server is not running')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method !== 'initialize') await this.start()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.options.requestTimeoutMs ?? 30_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'))
      else pending.resolve(message.result)
      return
    }
    if (message.method && message.id !== undefined) {
      this.write({ id: message.id, error: { code: -32601, message: `Scry does not handle server request: ${message.method}` } })
      return
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message.method, message.params)
    }
  }

  private fail(error: Error): void {
    this.process = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  close(): void {
    const child = this.process
    this.process = null
    if (child && !child.killed) child.kill('SIGTERM')
    this.fail(new Error('Codex app-server closed'))
  }
}
