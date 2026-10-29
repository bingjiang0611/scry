import { Worker } from 'node:worker_threads'
import { StorageError, type Operation, type Response, type Stats } from './protocol'

declare const SCRY_WORKFLOW_SQLITE_WORKER: string
export class MetadataWorker {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  readonly ready: Promise<Stats>
  private failed?: Error
  private closing = false
  private held?: () => void
  private readonly stopped: Promise<void>

  constructor(directory: string, create: boolean) {
    this.worker = new Worker(SCRY_WORKFLOW_SQLITE_WORKER, { workerData: { directory, create } })
    let ready!: (stats: Stats) => void, failed!: (error: Error) => void
    this.ready = new Promise<Stats>((resolve, reject) => { ready = resolve; failed = reject })
    this.worker.on('message', (reply: Response | { ready: Stats } | { held: true }) => {
      if ('ready' in reply) { ready(reply.ready); return }
      if ('held' in reply) { this.held?.(); this.held = undefined; return }
      const pending = this.pending.get(reply.id)
      if (!pending) { this.fail(new StorageError('unexpected SQLite reply', true)); return }
      this.pending.delete(reply.id)
      if (reply.ok) pending.resolve(reply.value)
      else pending.reject(new StorageError(reply.error, reply.unknown))
    })
    this.worker.once('error', error => { failed(error); this.fail(error) })
    this.stopped = new Promise(resolve => this.worker.once('exit', code => {
      if (!this.closing) {
        const error = new StorageError('SQLite worker exited: ' + code, true)
        failed(error); this.fail(error)
      }
      resolve()
    }))
  }
  request(operation: Operation): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed)
    if (this.pending.size >= 2) return Promise.reject(new Error('prototype request bound exceeded'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ ...operation, id }) }
      catch (error) { this.fail(new StorageError(String(error), true)) }
    })
  }
  waitHeld(): Promise<void> {
    if (this.held) throw new Error('held observer already registered')
    return new Promise(resolve => { this.held = resolve })
  }
  async close(): Promise<Stats | undefined> {
    this.closing = true
    try {
      if (this.failed) return undefined
      return await this.request({ op: 'close' }) as Stats
    } finally {
      await this.worker.terminate()
      await this.stopped
    }
  }
  private fail(error: Error): void {
    this.failed = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
