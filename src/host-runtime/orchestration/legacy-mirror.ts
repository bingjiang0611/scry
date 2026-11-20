import type { LedgerEvent, LedgerSnapshot, LedgerStore } from '../../main/remote/session-ledger'
import type { EventSink } from './event-sink'

const DEFAULT_IDLE_DELAY_MS = 250
const DEFAULT_MAX_PENDING_EVENTS = 2_048
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 50

export interface LegacyMirrorWorkerOptions {
  sink: EventSink
  ledgerStore: LedgerStore
  /** Debounced idle delay before flushing H1 mirror writes off the pre-first-token path. */
  idleDelayMs?: number
  /** Upper bound on queued mirror events so disk faults never cause unbounded memory growth. */
  maxPendingEvents?: number
  /** Consecutive write failure cap before dropping a poisoned head item so mirror never stalls. */
  maxRetries?: number
  retryDelayMs?: number
  onError?: (error: unknown) => void
}

/**
 * P4-2 replayable, bounded, idle-flushed H1 mirror (`plan §9`, `data §4.5`).
 * Runs on an idle timer (never on the pre-first-token hot path), supports snapshot compaction
 * so >8,192 events never jam live or restarted daemons, caps memory under persistent disk faults,
 * and marks replayable `legacy.mirror` outbox rows `done` on flush.
 * Explicitly NOT a strict rollback guarantee (plan §9).
 */
export class LegacyMirrorWorker {
  readonly #sink: EventSink
  readonly #ledgerStore: LedgerStore
  readonly #idleDelayMs: number
  readonly #maxPendingEvents: number
  readonly #maxRetries: number
  readonly #retryDelayMs: number
  readonly #onError?: (error: unknown) => void
  readonly #queue: LedgerEvent[] = []
  #pendingCompact: LedgerSnapshot | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #closed = false
  #lastMirroredSeq = 0
  #consecutiveFailures = 0
  #waiters: Array<() => void> = []

  constructor(options: LegacyMirrorWorkerOptions) {
    this.#sink = options.sink
    this.#ledgerStore = options.ledgerStore
    this.#idleDelayMs = Math.max(0, options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS)
    this.#maxPendingEvents = Math.max(1, options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS)
    this.#maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES)
    this.#retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
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

  enqueue(event: LedgerEvent): void {
    if (this.#closed) return
    this.#queue.push(event)
    if (this.#queue.length > this.#maxPendingEvents) {
      this.#queue.splice(0, this.#queue.length - this.#maxPendingEvents)
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
    if (this.#closed) return
    this.#pendingCompact = snapshot
    let drop = 0
    while (drop < this.#queue.length && this.#queue[drop]!.seq <= snapshot.lastSeq) drop += 1
    if (drop > 0) this.#queue.splice(0, drop)
    this.#schedule(this.#idleDelayMs)
  }

  #schedule(delayMs: number): void {
    if (this.#closed || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#drain(false)
    }, delayMs)
    this.#timer.unref?.()
  }

  #drain(flushAll: boolean): void {
    if (this.#closed) {
      this.#resolveWaiters()
      return
    }
    let maxSeq = this.#lastMirroredSeq

    while (this.#pendingCompact) {
      const snap = this.#pendingCompact
      try {
        this.#ledgerStore.compact?.(snap)
        this.#pendingCompact = null
        this.#consecutiveFailures = 0
        maxSeq = Math.max(maxSeq, snap.lastSeq)
        this.#lastMirroredSeq = maxSeq
      } catch (error) {
        this.#consecutiveFailures += 1
        this.#onError?.(error)
        if (this.#consecutiveFailures >= this.#maxRetries) {
          this.#pendingCompact = null
          this.#consecutiveFailures = 0
        } else if (!flushAll) {
          this.#schedule(this.#retryDelayMs)
          return
        }
      }
    }

    while (this.#queue.length > 0) {
      const event = this.#queue[0]!
      if (event.seq <= this.#lastMirroredSeq) {
        this.#queue.shift()
        continue
      }
      try {
        if (this.#ledgerStore.shouldCompact?.(event) && this.#pendingCompact) {
          this.#ledgerStore.compact?.(this.#pendingCompact)
          this.#pendingCompact = null
        }
        this.#ledgerStore.append(event)
        this.#queue.shift()
        this.#consecutiveFailures = 0
        maxSeq = Math.max(maxSeq, event.seq)
        this.#lastMirroredSeq = maxSeq
      } catch (error) {
        this.#consecutiveFailures += 1
        this.#onError?.(error)
        if (this.#consecutiveFailures >= this.#maxRetries) {
          // Drop poisoned head item after bounded retries so later events and compactions progress.
          this.#queue.shift()
          this.#consecutiveFailures = 0
        } else if (!flushAll) {
          this.#schedule(this.#retryDelayMs)
          return
        }
      }
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
    if (this.pendingCount() > 0 || this.#timer) return
    const list = this.#waiters.splice(0)
    for (const resolve of list) resolve()
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.pendingCount() === 0) return
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
      setImmediate(() => this.#drain(true))
    })
  }

  async close(): Promise<void> {
    await this.flush()
    this.#closed = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#pendingCompact = null
    this.#queue.length = 0
    this.#resolveWaiters()
  }
}
