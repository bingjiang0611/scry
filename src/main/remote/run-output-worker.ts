import { Worker } from 'node:worker_threads'
import type { OutputChunk, RunOutputPage, RunOutputStore } from './run-output-log'

interface Request { requestId: number; op: 'appendBatch' | 'since' | 'close'; value: unknown }
interface Reply { requestId: number; ok: boolean; value?: unknown; error?: string }
type Message = Reply | { event: 'ready' }
interface WorkerLike {
  postMessage(message: Request): void
  on(event: 'message', listener: (message: Message) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}
interface Pending { request: Request; resolve(value: unknown): void; reject(error: Error): void }

const MAX_QUEUED_REQUESTS = 128

// One request crosses the worker boundary at a time. RunOutputLog owns the bounded
// producer queue; this client adds no second body queue and never retries an unknown write.
export class RunOutputWorkerStore implements RunOutputStore {
  private readonly queue: Pending[] = []
  private inFlight?: Pending
  private nextRequestId = 1
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly ready: Promise<void>
  private stopped?: Error
  private closing = false

  private constructor(private readonly worker: WorkerLike) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    worker.on('message', (message) => {
      if ('event' in message) this.readyResolve()
      else this.replied(message)
    })
    worker.on('error', (error) => this.stop(error))
    worker.on('exit', (code) => {
      if (!this.closing) this.stop(new Error(`run_output_worker_exit_${code}`))
    })
  }

  static async create(directory: string): Promise<RunOutputWorkerStore> {
    const worker = new Worker(new URL('./run-output-file-worker.js', import.meta.url), { workerData: { directory } })
    const store = new RunOutputWorkerStore(worker)
    await store.ready
    return store
  }

  append(chunk: Omit<OutputChunk, 'seq'>): Promise<OutputChunk> {
    return this.appendBatch([chunk]).then((events) => events[0])
  }
  appendBatch(chunks: Array<Omit<OutputChunk, 'seq'>>): Promise<OutputChunk[]> {
    return this.call('appendBatch', chunks) as Promise<OutputChunk[]>
  }
  since(runId: string, cursor: number, pageSize?: number): Promise<RunOutputPage> {
    return this.call('since', { runId, cursor, pageSize }) as Promise<RunOutputPage>
  }
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try { await this.call('close', null) } finally { await this.worker.terminate() }
  }

  private call(op: Request['op'], value: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(this.stopped)
    if (this.queue.length >= MAX_QUEUED_REQUESTS) return Promise.reject(new Error('run_output_worker_queue_full'))
    return new Promise((resolve, reject) => {
      this.queue.push({ request: { requestId: this.nextRequestId++, op, value }, resolve, reject })
      this.pump()
    })
  }
  private pump(): void {
    if (this.inFlight || this.stopped) return
    const pending = this.queue.shift()
    if (!pending) return
    this.inFlight = pending
    try { this.worker.postMessage(pending.request) }
    catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))) }
  }
  private replied(reply: Reply): void {
    const pending = this.inFlight
    if (!pending || pending.request.requestId !== reply.requestId) {
      this.stop(new Error('run_output_worker_protocol_error'))
      return
    }
    this.inFlight = undefined
    if (reply.ok) pending.resolve(reply.value)
    else pending.reject(new Error(reply.error ?? 'run_output_worker_error'))
    this.pump()
  }
  private stop(error: Error): void {
    if (this.stopped) return
    this.stopped = error
    this.readyReject(error)
    const pending = [...(this.inFlight ? [this.inFlight] : []), ...this.queue]
    this.inFlight = undefined
    this.queue.length = 0
    for (const item of pending) item.reject(error)
  }
}
