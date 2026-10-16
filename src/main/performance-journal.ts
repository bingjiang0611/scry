import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { cpus, release } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
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

// Active records append to performance-0.jsonl. A full (or crash-truncated) active file is
// renamed to a timestamped archive and gzip-compressed off the write path; JSONL journals
// compress ~20x, so a small byte cap keeps weeks of daily use instead of a few hours.
// performance-[1-3].jsonl are the pre-archive layout and are compressed on the next open.
const ACTIVE_FILE = 'performance-0.jsonl'
const ARCHIVE_RE = /^performance-(?:[1-3]|\d{8}T\d{9}Z-[0-9a-f]{8})\.jsonl(?:\.gz)?$/
const archiveStamp = (date: Date): string => `${date.toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`

/** Local diagnostics only: bounded queue + one active file + byte-capped compressed archives; no DB, content or network. */
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
  // Archive compression/pruning runs serially and never blocks appends to the active file.
  private archiving: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    directory: string
    environment: PerformanceEnvironment
    maxFileBytes?: number
    maxArchiveBytes?: number
    maxQueueBytes?: number
    intervalMs?: number
    onError: () => void
  }) {}

  async open(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    try {
      this.size = (await stat(this.activeFile)).size
      if (this.size > 0) {
        const file = await open(this.activeFile, 'r')
        const last = Buffer.alloc(1)
        try { await file.read(last, 0, 1, this.size - 1) } finally { await file.close() }
        // Preserve a crash-truncated tail for reporting, but never concatenate a new record to it.
        if (last[0] !== 10 || this.size > this.maxFileBytes) await this.rotate()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Finishes archives left by a crash mid-compression and migrates the old layout.
    this.scheduleArchiving()
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
  private get maxArchiveBytes(): number { return this.options.maxArchiveBytes ?? 64 * 1024 * 1024 }
  private get activeFile(): string { return join(this.options.directory, ACTIVE_FILE) }

  private async rotate(): Promise<void> {
    try {
      await rename(this.activeFile, join(this.options.directory, `performance-${archiveStamp(new Date())}.jsonl`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.size = 0
    this.scheduleArchiving()
  }

  private scheduleArchiving(): void {
    this.archiving = this.archiving.then(() => this.archive()).catch(() => this.fail())
  }

  private async archive(): Promise<void> {
    const directory = this.options.directory
    const names = await readdir(directory)
    for (const name of names) if (name.startsWith('performance-') && name.endsWith('.gz.partial')) await rm(join(directory, name), { force: true })
    for (const name of names.filter(name => ARCHIVE_RE.test(name) && name.endsWith('.jsonl'))) {
      const source = join(directory, name)
      // Legacy rotated files have no timestamp in their name; their mtime is when they stopped growing.
      const base = /^performance-[1-3]\.jsonl$/.test(name) ? `performance-${archiveStamp((await stat(source)).mtime)}.jsonl` : name
      const target = join(directory, `${base}.gz`)
      const partial = `${target}.partial`
      await pipeline(createReadStream(source), createGzip(), createWriteStream(partial, { mode: 0o600 }))
      await rename(partial, target)
      await rm(source, { force: true })
    }
    // Oldest archives go first; the stamp sorts chronologically and legacy names are migrated above.
    const archives = (await readdir(directory)).filter(name => ARCHIVE_RE.test(name)).sort()
    const sizes = await Promise.all(archives.map(async name => (await stat(join(directory, name))).size))
    let total = sizes.reduce((sum, size) => sum + size, 0)
    for (let index = 0; index < archives.length && total > this.maxArchiveBytes; index++) {
      await rm(join(directory, archives[index]), { force: true })
      total -= sizes[index]
    }
  }

  private fail(): void {
    if (this.failed) return
    this.failed = true
    this.pending.length = 0
    this.pendingBytes = 0
    this.options.onError()
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
        await appendFile(this.activeFile, line, { mode: 0o600 })
        this.size += bytes
      }
    })().catch(() => this.fail()).finally(() => { this.writing = null })
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
    await this.archiving
  }
}
