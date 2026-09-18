import { Worker } from 'node:worker_threads'
import type {
  TerminalExitEvent, TerminalRecordingListPage, TerminalRecordingListRequest,
  TerminalRecordingPage, TerminalRecordingRequest, TerminalSessionDescriptor
} from '../shared/terminal'
import { TerminalRecordingStore } from './terminal-recording'

export interface TerminalRecordingBackend {
  start(info: TerminalSessionDescriptor): Promise<void>
  append(id: string, data: string): void
  finish(event: TerminalExitEvent): void
  read(request: TerminalRecordingRequest, cwd: string): Promise<TerminalRecordingPage>
  list(request: TerminalRecordingListRequest, cwd: string): Promise<TerminalRecordingListPage>
  delete(id: string, cwd: string): Promise<void>
  settle(): Promise<void>
  close(): Promise<void>
}

export interface TerminalRecordingFlowEvent { id: string; paused: boolean }
export interface TerminalRecordingWorkerCallbacks {
  onFailure(id: string, error: unknown): void
  onFlow(event: TerminalRecordingFlowEvent): void
}

interface WorkerRequest {
  requestId: number
  op: 'start' | 'append' | 'finish' | 'read' | 'list' | 'delete'
  value: unknown
}
interface WorkerReply {
  requestId: number
  ok: boolean
  value?: unknown
  error?: string
  failures?: Array<{ id: string; error: string }>
}
interface WorkerFailure { event: 'failure'; id: string; error: string }
type WorkerMessage = WorkerReply | WorkerFailure
interface WorkerLike {
  postMessage(message: WorkerRequest): void
  on(event: 'message', listener: (reply: WorkerMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}
interface PendingOperation {
  request: WorkerRequest
  bytes: number
  ids: Set<string>
  resolve?: (value: unknown) => void
  reject?: (error: Error) => void
}

const BATCH_BYTES = 512 * 1024
const HIGH_WATER_BYTES = 4 * 1024 * 1024
const LOW_WATER_BYTES = 2 * 1024 * 1024

function* splitUtf16(text: string): Generator<string> {
  const maxUnits = BATCH_BYTES / 2
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maxUnits)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    yield text.slice(start, end)
    start = end
  }
}

export class DirectTerminalRecordingBackend implements TerminalRecordingBackend {
  private readonly store: TerminalRecordingStore
  constructor(directory: string, onFailure: (id: string, error: unknown) => void) {
    this.store = new TerminalRecordingStore(directory, onFailure)
  }
  start(info: TerminalSessionDescriptor): Promise<void> { this.store.start(info); return Promise.resolve() }
  append(id: string, data: string): void { this.store.append(id, data) }
  finish(event: TerminalExitEvent): void { this.store.finish(event) }
  async read(request: TerminalRecordingRequest, cwd: string): Promise<TerminalRecordingPage> { return this.store.read(request, cwd) }
  list(request: TerminalRecordingListRequest, cwd: string): Promise<TerminalRecordingListPage> { return this.store.list(request, cwd) }
  async delete(id: string, cwd: string): Promise<void> { this.store.delete(id, cwd) }
  async settle(): Promise<void> {}
  async close(): Promise<void> {}
}

// The client retains at most a bounded amount of unsaved text and sends one batch at a time.
// Disk syscalls and fsync run in the worker, never in Electron's main event loop.
export class TerminalRecordingWorkerClient implements TerminalRecordingBackend {
  private readonly queue: PendingOperation[] = []
  private readonly failedIds = new Set<string>()
  private readonly pausedIds = new Set<string>()
  private readonly bytesById = new Map<string, number>()
  private readonly settlers: Array<{ resolve(): void; reject(error: Error): void }> = []
  private inFlight?: PendingOperation
  private pendingBytes = 0
  private nextRequestId = 1
  private stoppedError?: Error
  private closing?: Promise<void>

  constructor(private readonly worker: WorkerLike, private readonly callbacks: TerminalRecordingWorkerCallbacks) {
    worker.on('message', (message) => {
      if ('event' in message) this.recordFailure(message.id, message.error)
      else this.replied(message)
    })
    worker.on('error', (error) => this.stop(error))
    worker.on('exit', (code) => {
      if (!this.closing && code !== 0) this.stop(new Error(`terminal_recording_worker_exit_${code}`))
    })
  }

  static create(directory: string, callbacks: TerminalRecordingWorkerCallbacks): TerminalRecordingWorkerClient {
    const worker = new Worker(new URL('./terminal-recording-worker.js', import.meta.url), { workerData: { directory } })
    return new TerminalRecordingWorkerClient(worker, callbacks)
  }

  start(info: TerminalSessionDescriptor): Promise<void> { return this.control('start', info).then(() => undefined) }

  append(id: string, data: string): void {
    if (this.stoppedError || this.failedIds.has(id) || !data) return
    for (const piece of splitUtf16(data)) {
      const bytes = Buffer.byteLength(piece, 'utf16le')
      let operation = this.queue.at(-1)
      const value = operation?.request.value as { entries?: Array<{ id: string; data: string }> } | undefined
      if (!operation || operation.request.op !== 'append' || operation.bytes + bytes > BATCH_BYTES || !value?.entries) {
        operation = this.operation('append', { entries: [] })
        this.queue.push(operation)
      }
      ;(operation.request.value as { entries: Array<{ id: string; data: string }> }).entries.push({ id, data: piece })
      operation.bytes += bytes
      operation.ids.add(id)
      this.pendingBytes += bytes
      this.bytesById.set(id, (this.bytesById.get(id) ?? 0) + bytes)
    }
    if (this.pendingBytes >= HIGH_WATER_BYTES) this.pausePendingIds()
    this.pump()
  }

  finish(event: TerminalExitEvent): void {
    if (this.stoppedError) return
    void this.control('finish', event).catch((error) => this.callbacks.onFailure(event.id, error))
  }
  read(request: TerminalRecordingRequest, cwd: string): Promise<TerminalRecordingPage> {
    return this.control('read', { request, cwd }) as Promise<TerminalRecordingPage>
  }
  list(request: TerminalRecordingListRequest, cwd: string): Promise<TerminalRecordingListPage> {
    return this.control('list', { request, cwd }) as Promise<TerminalRecordingListPage>
  }
  delete(id: string, cwd: string): Promise<void> { return this.control('delete', { id, cwd }).then(() => undefined) }

  settle(): Promise<void> {
    if (this.stoppedError) return Promise.reject(this.stoppedError)
    if (!this.inFlight && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve, reject) => this.settlers.push({ resolve, reject }))
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.settle().finally(async () => { await this.worker.terminate() })
    return this.closing
  }

  snapshot(): { pendingBytes: number; queuedOperations: number; inFlight: boolean; pausedIds: string[] } {
    return { pendingBytes: this.pendingBytes, queuedOperations: this.queue.length,
      inFlight: Boolean(this.inFlight), pausedIds: [...this.pausedIds] }
  }

  private control(op: WorkerRequest['op'], value: unknown): Promise<unknown> {
    if (this.stoppedError) return Promise.reject(this.stoppedError)
    return new Promise((resolve, reject) => {
      const operation = this.operation(op, value)
      operation.resolve = resolve
      operation.reject = reject
      this.queue.push(operation)
      this.pump()
    })
  }
  private operation(op: WorkerRequest['op'], value: unknown): PendingOperation {
    return { request: { requestId: this.nextRequestId++, op, value }, bytes: 0, ids: new Set() }
  }
  private pump(): void {
    if (this.inFlight || this.stoppedError) return
    const operation = this.queue.shift()
    if (!operation) {
      for (const settler of this.settlers.splice(0)) settler.resolve()
      return
    }
    if (operation.request.op === 'append') {
      const value = operation.request.value as { entries: Array<{ id: string; data: string }> }
      const retained = value.entries.filter((entry) => !this.failedIds.has(entry.id))
      if (retained.length !== value.entries.length) {
        const dropped = value.entries.filter((entry) => this.failedIds.has(entry.id))
        const droppedBytes = dropped.reduce((sum, entry) => sum + Buffer.byteLength(entry.data, 'utf16le'), 0)
        operation.bytes -= droppedBytes
        this.pendingBytes = Math.max(0, this.pendingBytes - droppedBytes)
        for (const id of new Set(dropped.map((entry) => entry.id))) {
          const idBytes = dropped.filter((entry) => entry.id === id)
            .reduce((sum, entry) => sum + Buffer.byteLength(entry.data, 'utf16le'), 0)
          const remaining = Math.max(0, (this.bytesById.get(id) ?? 0) - idBytes)
          if (remaining) this.bytesById.set(id, remaining)
          else this.bytesById.delete(id)
        }
        value.entries = retained
        operation.ids = new Set(retained.map((entry) => entry.id))
      }
      if (value.entries.length === 0) {
        this.release(operation)
        this.pump()
        return
      }
    }
    this.inFlight = operation
    try { this.worker.postMessage(operation.request) }
    catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))) }
  }
  private replied(reply: WorkerReply): void {
    const operation = this.inFlight
    if (!operation || reply.requestId !== operation.request.requestId) {
      this.stop(new Error('terminal_recording_worker_protocol_error'))
      return
    }
    this.inFlight = undefined
    this.release(operation)
    for (const failure of reply.failures ?? []) this.recordFailure(failure.id, failure.error)
    if (!reply.ok && operation.request.op === 'start') {
      this.failedIds.add((operation.request.value as TerminalSessionDescriptor).id)
    }
    if (reply.ok && operation.request.op === 'finish') {
      this.failedIds.delete((operation.request.value as TerminalExitEvent).id)
    }
    if (reply.ok) operation.resolve?.(reply.value)
    else operation.reject?.(new Error(reply.error ?? 'terminal_recording_worker_error'))
    this.pump()
  }
  private recordFailure(id: string, error: string): void {
    if (this.failedIds.has(id)) return
    this.failedIds.add(id)
    this.callbacks.onFailure(id, new Error(error))
  }
  private release(operation: PendingOperation): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - operation.bytes)
    for (const id of operation.ids) {
      const entries = operation.request.op === 'append'
        ? (operation.request.value as { entries: Array<{ id: string; data: string }> }).entries
        : []
      const bytes = entries.filter((entry) => entry.id === id)
        .reduce((sum, entry) => sum + Buffer.byteLength(entry.data, 'utf16le'), 0)
      const remaining = Math.max(0, (this.bytesById.get(id) ?? 0) - bytes)
      if (remaining) this.bytesById.set(id, remaining)
      else this.bytesById.delete(id)
    }
    if (this.pendingBytes <= LOW_WATER_BYTES) this.resumePausedIds()
  }
  private pausePendingIds(): void {
    for (const id of this.bytesById.keys()) {
      if (this.pausedIds.has(id)) continue
      this.pausedIds.add(id)
      this.callbacks.onFlow({ id, paused: true })
    }
  }
  private resumePausedIds(): void {
    for (const id of this.pausedIds) this.callbacks.onFlow({ id, paused: false })
    this.pausedIds.clear()
  }
  private stop(error: Error): void {
    if (this.stoppedError) return
    this.stoppedError = error
    const operations = [...(this.inFlight ? [this.inFlight] : []), ...this.queue]
    this.inFlight = undefined
    this.queue.length = 0
    for (const operation of operations) {
      for (const id of operation.ids) {
        if (!this.failedIds.has(id)) {
          this.failedIds.add(id)
          this.callbacks.onFailure(id, error)
        }
      }
      operation.reject?.(error)
    }
    this.pendingBytes = 0
    this.bytesById.clear()
    this.resumePausedIds()
    for (const settler of this.settlers.splice(0)) settler.reject(error)
  }
}
