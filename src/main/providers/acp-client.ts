import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/** Hard per-line byte ceiling for ACP stdio framing (P7 §4.2). */
export const ACP_MAX_LINE_BYTES = 16 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

export type AcpJsonRpcId = string | number

export class AcpRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message || `ACP JSON-RPC error ${code}`)
    this.name = 'AcpRpcError'
    this.code = code
    this.data = data
  }
}

export class AcpProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpProtocolError'
  }
}

export class AcpRequestTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number

  constructor(method: string, timeoutMs: number) {
    super(`ACP request "${method}" timed out after ${timeoutMs}ms`)
    this.name = 'AcpRequestTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export class AcpTransportClosedError extends Error {
  readonly nonJsonLineCount: number
  readonly loginPromptDetected: boolean

  constructor(message: string, nonJsonLineCount: number, loginPromptDetected: boolean) {
    super(message)
    this.name = 'AcpTransportClosedError'
    this.nonJsonLineCount = nonJsonLineCount
    this.loginPromptDetected = loginPromptDetected
  }
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentInfo: { name?: string; version?: string; [key: string]: unknown }
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
    sessionCapabilities?: Record<string, unknown>
    [key: string]: unknown
  }
  authMethods?: Array<{ id: string; name?: string; description?: string }>
  _meta?: Record<string, unknown>
}

export interface AcpClientOptions {
  maxLineBytes?: number
  onNotification?: (method: string, params: unknown) => void
  /**
   * Handle an incoming JSON-RPC request from the Agent (id may be string or number).
   * Returning `undefined` replies with JSON-RPC `-32601 Method not found`.
   */
  onRequest?: (method: string, params: unknown, id: AcpJsonRpcId) => Promise<unknown> | unknown
  /** Valid JSON-RPC lines only; dropped login-prompt and non-JSON stdout lines are never forwarded. */
  onRawMessage?: (direction: 'in' | 'out', rawLine: string) => void
  /** Fired without line contents when a stdout login/OAuth prompt line is detected and dropped. */
  onLoginPromptDetected?: () => void
  onProtocolError?: (error: AcpProtocolError) => void
  onClose?: (error?: Error) => void
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface AcpTransportStreams {
  stdin: Writable | null
  stdout: Readable | null
  once?: (event: 'close' | 'exit' | 'error', listener: (...args: unknown[]) => void) => unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is AcpJsonRpcId {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Shape check for ACP `initialize` response (P7 §1.2 B1):
 * accepts any positive integer `protocolVersion` (never hardcodes `=== 1`),
 * requires `agentInfo` and either `loadSession === true` or `sessionCapabilities.resume`.
 */
export function validateAcpInitializeResult(value: unknown): value is AcpInitializeResult {
  if (!isRecord(value)) return false
  if (typeof value.protocolVersion !== 'number' || !Number.isInteger(value.protocolVersion) || value.protocolVersion < 1) {
    return false
  }
  if (!isRecord(value.agentInfo)) return false
  const caps = isRecord(value.agentCapabilities) ? value.agentCapabilities : undefined
  if (!caps) return false
  const sessionCaps = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : undefined
  return caps.loadSession === true || (sessionCaps !== undefined && sessionCaps.resume !== undefined)
}

const LOGIN_PROMPT_PATTERNS: readonly RegExp[] = [
  /accounts\.google\.com/i,
  /https?:\/\/[^\s]*oauth/i,
  /https?:\/\/[^\s]*[?&](?:state|code)=/i,
  /\b(?:please visit|open this url|authenticate at|login url)\b/i,
  /\bplease sign in (?:at|via|with)\b/i,
  /\bsign in\b[^\n]*https?:\/\//i
]

export function isAcpLoginPromptLine(line: string): boolean {
  return LOGIN_PROMPT_PATTERNS.some((pattern) => pattern.test(line))
}

/**
 * Minimal JSON-RPC 2.0 over stdio client for `agy acp` (P7 D6).
 * Enforces a strict 16 MiB line limit, handles string/number IDs, drops & counts non-JSON
 * stdout lines without logging their contents, and replies `-32601` to unknown methods.
 */
export class AcpClient {
  private readonly stdin: Writable
  private readonly stdout: Readable
  private readonly maxLineBytes: number
  private readonly options: AcpClientOptions
  private readonly pending = new Map<string, PendingRequest>()
  private readonly chunks: Buffer[] = []
  private bufferedBytes = 0
  private nextId = 0
  private closed = false
  private _nonJsonLineCount = 0
  private _loginPromptDetected = false

  constructor(transport: ChildProcess | AcpTransportStreams, options: AcpClientOptions = {}) {
    if (!transport.stdin || !transport.stdout) {
      throw new AcpProtocolError('ACP transport requires piped stdin and stdout')
    }
    this.stdin = transport.stdin
    this.stdout = transport.stdout
    this.maxLineBytes = options.maxLineBytes ?? ACP_MAX_LINE_BYTES
    this.options = options

    this.stdout.on('data', this.handleData)
    this.stdout.once('end', () => this.handleClose())
    this.stdout.once('error', (error: Error) => this.handleClose(error))
    this.stdin.on('error', (error: Error) => {
      if (!this.closed) this.handleClose(error)
    })
    transport.once?.('error', (error: unknown) => {
      this.handleClose(error instanceof Error ? error : new Error(String(error)))
    })
    transport.once?.('close', (code: unknown, signal: unknown) => {
      const detail = signal ? `signal ${String(signal)}` : `code ${String(code ?? 'unknown')}`
      this.handleClose(new AcpTransportClosedError(
        `ACP process closed (${detail})`,
        this._nonJsonLineCount,
        this._loginPromptDetected
      ))
    })
  }

  get nonJsonLineCount(): number {
    return this._nonJsonLineCount
  }

  get loginPromptDetected(): boolean {
    return this._loginPromptDetected
  }

  get isClosed(): boolean {
    return this.closed
  }

  async initialize(clientVersion: string, timeoutMs = 30_000): Promise<AcpInitializeResult> {
    const result = await this.request<unknown>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'scry', version: clientVersion },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    }, { timeoutMs })
    if (!validateAcpInitializeResult(result)) {
      throw new AcpProtocolError('ACP initialize response failed shape validation')
    }
    return result
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number | null } = {}
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AcpTransportClosedError(
        `ACP transport is closed before "${method}"`,
        this._nonJsonLineCount,
        this._loginPromptDetected
      ))
    }
    const id = ++this.nextId
    const key = String(id)
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : options.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject
      }
      if (timeoutMs !== null && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(key)) return
          reject(new AcpRequestTimeoutError(method, timeoutMs))
        }, timeoutMs)
      }
      this.pending.set(key, entry)
      const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
      if (params !== undefined) payload.params = params
      this.writeMessage(payload, (error) => {
        if (!error) return
        const failed = this.pending.get(key)
        if (!failed) return
        this.pending.delete(key)
        if (failed.timer) clearTimeout(failed.timer)
        failed.reject(error)
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    this.writeMessage(payload)
  }

  /** Close stdin cleanly so `agy acp` flushes its session to disk and exits naturally. */
  closeStdin(): void {
    if (!this.stdin.destroyed && this.stdin.writable) {
      try { this.stdin.end() } catch { /* ignore */ }
    }
  }

  destroy(options: { closeStdin?: boolean } = {}): void {
    this.handleClose(new AcpTransportClosedError(
      'ACP client destroyed',
      this._nonJsonLineCount,
      this._loginPromptDetected
    ))
    this.stdout.off('data', this.handleData)
    if (options.closeStdin !== false) this.closeStdin()
  }

  private writeMessage(message: Record<string, unknown>, onError?: (error: Error) => void): void {
    if (this.closed || this.stdin.destroyed || !this.stdin.writable) {
      onError?.(new AcpTransportClosedError('ACP stdin is not writable', this._nonJsonLineCount, this._loginPromptDetected))
      return
    }
    const line = JSON.stringify(message)
    this.options.onRawMessage?.('out', line)
    this.stdin.write(`${line}\n`, (error) => {
      if (error) onError?.(error)
    })
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) return
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    let offset = 0
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset)
      if (nl === -1) {
        const tail = buf.subarray(offset)
        this.bufferedBytes += tail.length
        if (this.bufferedBytes > this.maxLineBytes) {
          this.failProtocol(new AcpProtocolError(`ACP stdout line exceeded ${this.maxLineBytes} bytes (16 MiB) limit`))
          return
        }
        this.chunks.push(tail)
        return
      }
      const slice = buf.subarray(offset, nl)
      const lineBytes = this.bufferedBytes + slice.length
      if (lineBytes > this.maxLineBytes) {
        this.chunks.length = 0
        this.bufferedBytes = 0
        this.failProtocol(new AcpProtocolError(`ACP stdout line exceeded ${this.maxLineBytes} bytes (16 MiB) limit`))
        return
      }
      const rawBuf = this.chunks.length > 0 ? Buffer.concat([...this.chunks, slice], lineBytes) : slice
      this.chunks.length = 0
      this.bufferedBytes = 0
      const trimmedLen = rawBuf.length > 0 && rawBuf[rawBuf.length - 1] === 0x0d ? rawBuf.length - 1 : rawBuf.length
      const line = rawBuf.toString('utf8', 0, trimmedLen)
      offset = nl + 1
      this.handleLine(line)
      if (this.closed) return
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this._nonJsonLineCount += 1
      if (isAcpLoginPromptLine(line)) {
        this._loginPromptDetected = true
        this.options.onLoginPromptDetected?.()
      }
      return
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
      this._nonJsonLineCount += 1
      if (isAcpLoginPromptLine(line)) {
        this._loginPromptDetected = true
        this.options.onLoginPromptDetected?.()
      }
      return
    }
    this.options.onRawMessage?.('in', line)

    const hasMethod = typeof parsed.method === 'string' && parsed.method.length > 0
    const hasId = isJsonRpcId(parsed.id)

    if (!hasMethod && hasId) {
      const key = String(parsed.id)
      const entry = this.pending.get(key)
      if (!entry) return
      this.pending.delete(key)
      if (entry.timer) clearTimeout(entry.timer)
      if (isRecord(parsed.error)) {
        const code = typeof parsed.error.code === 'number' ? parsed.error.code : -32603
        const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'ACP error'
        entry.reject(new AcpRpcError(code, message, parsed.error.data))
      } else {
        entry.resolve(parsed.result)
      }
      return
    }

    if (hasMethod && hasId) {
      const method = parsed.method as string
      const id = parsed.id as AcpJsonRpcId
      void this.dispatchAgentRequest(method, parsed.params, id)
      return
    }

    if (hasMethod && !hasId) {
      this.options.onNotification?.(parsed.method as string, parsed.params)
    }
  }

  private async dispatchAgentRequest(method: string, params: unknown, id: AcpJsonRpcId): Promise<void> {
    if (!this.options.onRequest) {
      this.writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    try {
      const result = await this.options.onRequest(method, params, id)
      if (this.closed) return
      if (result === undefined) {
        this.writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      } else {
        this.writeMessage({ jsonrpc: '2.0', id, result })
      }
    } catch (error) {
      if (this.closed) return
      if (error instanceof AcpRpcError) {
        this.writeMessage({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message } })
      } else {
        this.writeMessage({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
        })
      }
    }
  }

  private failProtocol(error: AcpProtocolError): void {
    this.options.onProtocolError?.(error)
    this.stdout.off('data', this.handleData)
    this.handleClose(error)
  }

  private handleClose(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.chunks.length = 0
    this.bufferedBytes = 0
    const reason = error ?? new AcpTransportClosedError(
      'ACP transport closed',
      this._nonJsonLineCount,
      this._loginPromptDetected
    )
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
    this.options.onClose?.(error)
  }
}
