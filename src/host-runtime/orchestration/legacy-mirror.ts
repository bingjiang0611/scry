import type { LedgerEvent, LedgerSnapshot, LedgerStore } from '../../main/remote/session-ledger'
import type { EventSink } from './event-sink'

const DEFAULT_IDLE_DELAY_MS = 250
const DEFAULT_MAX_PENDING_EVENTS = 2_048
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 50
const DEFAULT_MAX_BATCH_EVENTS = 32
const DEFAULT_MAX_SLICE_MS = 8

export interface LegacyMirrorWorkerOptions {
  sink: EventSink
  ledgerStore: LedgerStore
  /** Synthesizes a full contiguous snapshot on queue overflow or write fault so seq never gaps. */
  createSnapshot?: () => LedgerSnapshot
  /** Debounced idle delay before flushing H1 mirror writes off the pre-first-token path. */
  idleDelayMs?: number
  /** Upper bound on queued mirror events before collapsing into an atomic snapshot or failing closed. */
  maxPendingEvents?: number
  /** Consecutive write failure cap before snapshot fallback or failing closed (never drops a seq). */
  maxRetries?: number
  retryDelayMs?: number
  /** Maximum events drained per event-loop turn before yielding via `setImmediate`. */
  maxBatchEvents?: number
  /** Time budget (ms) per `#drain` slice before yielding via `setImmediate`. */
  maxSliceMs?: number
  onError?: (error: unknown) => void
}

/**
 * P4-2 zero-drop, chunk-yielding, idle-flushed H1 mirror (`plan §9`, `data §4.5`).
 * - Never drops individual events: queue overflow collapses into an atomic snapshot via
 *   `createSnapshot` (or fails closed if unavailable), and persistent write errors (e.g. ENOSPC)
 *   fail closed after bounded retries so on-disk H1 stays a contiguous valid prefix (`seq` never gaps).
 * - Drains in bounded slices (`maxBatchEvents` / `maxSliceMs`) yielding via `setImmediate`.
 * - Runs off the pre-first-token hot path (idle debounce for non-terminal events).
 */
export class LegacyMirrorWorker {
  readonly #sink: EventSink
  readonly #ledgerStore: LedgerStore
  readonly #createSnapshot?: () => LedgerSnapshot
  readonly #idleDelayMs: number
  readonly #maxPendingEvents: number
  readonly #maxRetries: number
  readonly #retryDelayMs: number
  readonly #maxBatchEvents: number
  readonly #maxSliceMs: number
  readonly #onError?: (error: unknown) => void
  readonly #queue: LedgerEvent[] = []
  #pendingCompact: LedgerSnapshot | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #drainScheduled = false
  #closed = false
  #failedClosed = false
  #lastMirroredSeq = 0
  #consecutiveFailures = 0
  #waiters: Array<() => void> = []

  constructor(options: LegacyMirrorWorkerOptions) {
    this.#sink = options.sink
    this.#ledgerStore = options.ledgerStore
    this.#createSnapshot = options.createSnapshot
    this.#idleDelayMs = Math.max(0, options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS)
    this.#maxPendingEvents = Math.max(1, options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS)
    this.#maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES)
    this.#retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    this.#maxBatchEvents = Math.max(1, options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS)
    this.#maxSliceMs = Math.max(1, options.maxSliceMs ?? DEFAULT_MAX_SLICE_MS)
    this.#onError = options.onError
    try {
      const existing = Number(this.#sink.getMeta('legacy_ledger_seq') ?? '0')
      if (Number.isFinite(existing) && existing > 0) this.#lastMirroredSeq = existing
    } catch {
      // Ignore if sink already fenced.
    }
  }

  pendingCount(): number {
    return this.#queue.length + (this.#pendingCompact ? 1 : 0)
  }

  isFailedClosed(): boolean {
    return this.#failedClosed
  }

  #failClosed(error: unknown): void {
    if (this.#failedClosed) return
    this.#failedClosed = true
    this.#onError?.(error)
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#drainScheduled = false
    // Clear pending memory buffers WITHOUT writing any higher seq to disk so the persisted H1 log
    // stays a valid contiguous prefix up to #lastMirroredSeq and never triggers ledger_log_corrupt.
    this.#pendingCompact = null
    this.#queue.length = 0
    this.#resolveWaiters()
  }

  enqueue(event: LedgerEvent): void {
    if (this.#closed || this.#failedClosed) return
    this.#queue.push(event)
    if (this.#queue.length > this.#maxPendingEvents) {
      if (this.#createSnapshot && this.#ledgerStore.compact) {
        try {
          const snap = structuredClone(this.#createSnapshot())
          this.#pendingCompact = snap
          this.#queue.length = 0
        } catch (error) {
          this.#failClosed(error)
          return
        }
      } else {
        this.#failClosed(new Error('legacy_mirror_queue_overflow'))
        return
      }
    }
    const isTerminal =
      event.kind === 'run_settled' || event.kind === 'run_failed' || event.kind === 'run_cancelled'
    if (isTerminal) {
      if (this.#timer) {
        clearTimeout(this.#timer)
        this.#timer = null
      }
      this.#schedule(0)
    } else {
      this.#schedule(this.#idleDelayMs)
    }
  }

  /** Enqueues a compacted H1 snapshot and drops all queued events superseded by `snapshot.lastSeq`. */
  enqueueCompact(snapshot: LedgerSnapshot): void {
    if (this.#closed || this.#failedClosed) return
    this.#pendingCompact = structuredClone(snapshot)
    let drop = 0
    while (drop < this.#queue.length && this.#queue[drop]!.seq <= snapshot.lastSeq) drop += 1
    if (drop > 0) this.#queue.splice(0, drop)
    this.#schedule(this.#idleDelayMs)
  }

  #schedule(delayMs: number): void {
    if (this.#closed || this.#failedClosed || this.#timer || this.#drainScheduled) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#drain(false)
    }, delayMs)
    this.#timer.unref?.()
  }

  #scheduleNextSlice(flushAll: boolean): void {
    if (this.#closed || this.#failedClosed || this.#drainScheduled) return
    this.#drainScheduled = true
    setImmediate(() => {
      this.#drainScheduled = false
      this.#drain(flushAll)
    })
  }

  #drain(flushAll: boolean): void {
    if (this.#closed || this.#failedClosed) {
      this.#resolveWaiters()
      return
    }
    let maxSeq = this.#lastMirroredSeq
    const sliceStart = performance.now()
    let processed = 0

    if (this.#pendingCompact) {
      const snap = this.#pendingCompact
      try {
        this.#ledgerStore.compact?.(snap)
        this.#pendingCompact = null
        this.#consecutiveFailures = 0
        maxSeq = Math.max(maxSeq, snap.lastSeq)
        this.#lastMirroredSeq = maxSeq
        processed += 1
      } catch (error) {
        this.#consecutiveFailures += 1
        this.#onError?.(error)
        if (this.#consecutiveFailures >= this.#maxRetries) {
          this.#failClosed(error)
          return
        }
        if (flushAll) this.#scheduleNextSlice(true)
        else this.#schedule(this.#retryDelayMs)
        return
      }
    }

    while (this.#queue.length > 0 && processed < this.#maxBatchEvents) {
      const event = this.#queue[0]!
      if (event.seq <= this.#lastMirroredSeq) {
        this.#queue.shift()
        continue
      }
      try {
        this.#ledgerStore.append(event)
        this.#queue.shift()
        this.#consecutiveFailures = 0
        maxSeq = Math.max(maxSeq, event.seq)
        this.#lastMirroredSeq = maxSeq
        processed += 1
      } catch (error) {
        this.#consecutiveFailures += 1
        this.#onError?.(error)
        if (this.#consecutiveFailures >= this.#maxRetries) {
          // Never drop a single event and write a higher seq! Attempt one atomic snapshot
          // compaction if available; otherwise fail closed preserving a contiguous prefix.
          if (this.#createSnapshot && this.#ledgerStore.compact) {
            try {
              const snap = structuredClone(this.#createSnapshot())
              this.#ledgerStore.compact(snap)
              this.#pendingCompact = null
              let drop = 0
              while (drop < this.#queue.length && this.#queue[drop]!.seq <= snap.lastSeq) drop += 1
              if (drop > 0) this.#queue.splice(0, drop)
              this.#consecutiveFailures = 0
              maxSeq = Math.max(maxSeq, snap.lastSeq)
              this.#lastMirroredSeq = maxSeq
              processed += 1
              break
            } catch (compactError) {
              this.#failClosed(compactError)
              return
            }
          }
          this.#failClosed(error)
          return
        }
        if (flushAll) this.#scheduleNextSlice(true)
        else this.#schedule(this.#retryDelayMs)
        return
      }
      if (performance.now() - sliceStart >= this.#maxSliceMs) break
    }

    if (this.pendingCount() > 0) {
      this.#scheduleNextSlice(flushAll)
      return
    }

    if (!this.#sink.isWriteIndeterminate() && this.#sink.handle.db.open) {
      try {
        if (maxSeq > 0) {
          const current = Number(this.#sink.getMeta('legacy_ledger_seq') ?? '0')
          if (maxSeq > current) this.#sink.setMeta('legacy_ledger_seq', String(maxSeq))
        }
        this.#sink.handle.db
          .prepare("UPDATE orch_outbox SET state = 'done', completed_at = ? WHERE kind = 'legacy.mirror' AND state = 'pending'")
          .run(Date.now())
      } catch (error) {
        this.#onError?.(error)
      }
    }
    this.#resolveWaiters()
  }

  #resolveWaiters(): void {
    if (!this.#failedClosed && (this.pendingCount() > 0 || this.#timer || this.#drainScheduled)) return
    const list = this.#waiters.splice(0)
    for (const resolve of list) resolve()
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#failedClosed || this.pendingCount() === 0) return
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
      this.#scheduleNextSlice(true)
    })
  }

  async close(): Promise<void> {
    await this.flush()
    this.#closed = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#drainScheduled = false
    this.#pendingCompact = null
    this.#queue.length = 0
    this.#resolveWaiters()
  }
}
