import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { cpus, release } from 'node:os'
import { join } from 'node:path'
import type { RendererPerformanceSample } from '../shared/performance'
import type { PerformanceResourceSample } from './performance-resource-monitor'
import type { PerformanceSample } from './performance-timing'

export type PerformanceObservation =
  | { kind: 'trace'; sample: PerformanceSample }
  | { kind: 'renderer'; sample: RendererPerformanceSample }
  | { kind: 'resource'; sample: PerformanceResourceSample }
  | { kind: 'health'; sample: { droppedRecords: number; closed: true } }

export interface PerformanceEnvironment {
  version: string
  build: string
  mode: 'packaged' | 'development'
  platform: string
  osRelease: string
  arch: string
  cpu: string
  runtime: string
}

export interface PerformanceRecord extends PerformanceEnvironment {
  schema: 1
  session: string
  recordedAt: string
  observation: PerformanceObservation
}

export function performanceEnvironment(version: string, build: string, packaged: boolean): PerformanceEnvironment {
  return {
    version,
    // Embedded at build time from all source surfaces + lockfile/config. No startup hashing.
    build,
    mode: packaged ? 'packaged' : 'development',
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    cpu: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} cores)`,
    runtime: `electron-${process.versions.electron ?? 'none'}-node-${process.versions.node}`
  }
}

/** Local diagnostics only: bounded queue + four bounded files, no DB, content or network. */
export class PerformanceJournal {
  private readonly session = randomUUID()
  private readonly pending: string[] = []
  private pendingBytes = 0
  private size = 0
  private writing: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private failed = false
  private dropped = 0

  constructor(private readonly options: {
    directory: string
    environment: PerformanceEnvironment
    maxFileBytes?: number
    maxQueueBytes?: number
    intervalMs?: number
    onError: () => void
  }) {}

  async open(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    try {
      this.size = (await stat(this.file(0))).size
      if (this.size > 0) {
        const file = await open(this.file(0), 'r')
        const last = Buffer.alloc(1)
        try { await file.read(last, 0, 1, this.size - 1) } finally { await file.close() }
        // Preserve a crash-truncated tail for reporting, but never concatenate a new record to it.
        if (last[0] !== 10 || this.size > this.maxFileBytes) await this.rotate()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.timer = setInterval(() => { void this.flush() }, this.options.intervalMs ?? 5_000)
    this.timer.unref()
  }

  record(observation: PerformanceObservation): void {
    if (this.closed || this.failed) return
    const record: PerformanceRecord = {
      schema: 1,
      ...this.options.environment,
      session: this.session,
      recordedAt: new Date().toISOString(),
      observation
    }
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    if (bytes > this.maxFileBytes || this.pendingBytes + bytes > (this.options.maxQueueBytes ?? 256 * 1024)) {
      this.dropped += 1
      return
    }
    this.pending.push(line)
    this.pendingBytes += bytes
  }

  get status(): { dropped: number; failed: boolean; queuedBytes: number } {
    return { dropped: this.dropped, failed: this.failed, queuedBytes: this.pendingBytes }
  }

  private get maxFileBytes(): number { return this.options.maxFileBytes ?? 5 * 1024 * 1024 }
  private file(index: number): string { return join(this.options.directory, `performance-${index}.jsonl`) }

  private async rotate(): Promise<void> {
    await rm(this.file(3), { force: true })
    for (let index = 2; index >= 0; index--) {
      try {
        await rename(this.file(index), this.file(index + 1))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.size = 0
  }

  flush(): Promise<void> {
    if (this.writing) return this.writing
    if (this.failed || this.pending.length === 0) return Promise.resolve()
    const lines = this.pending.splice(0)
    this.pendingBytes = 0
    // Observation must fail open. Report a fixed message once, never filesystem error contents.
    this.writing = (async () => {
      for (const line of lines) {
        const bytes = Buffer.byteLength(line)
        if (this.size + bytes > this.maxFileBytes) await this.rotate()
        await appendFile(this.file(0), line, { mode: 0o600 })
        this.size += bytes
      }
    })().catch(() => {
      this.failed = true
      this.pending.length = 0
      this.pendingBytes = 0
      this.options.onError()
    }).finally(() => { this.writing = null })
    return this.writing
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.writing
    await this.flush()
    // Preserve loss evidence even when shutdown occurs before the next resource sample.
    this.closed = false
    this.record({ kind: 'health', sample: { droppedRecords: this.dropped, closed: true } })
    this.closed = true
    await this.flush()
  }
}
