import type { LedgerEvent, LedgerSnapshot, LedgerStore } from '../../main/remote/session-ledger'
import type { EventSink } from './event-sink'
import { buildH1SnapshotFromDb } from './legacy-snapshot-builder'

const DEFAULT_IDLE_DELAY_MS = 250
const DEFAULT_MAX_PENDING_EVENTS = 2_048
const DEFAULT_MAX_BATCH_EVENTS = 32
const DEFAULT_MAX_SLICE_MS = 8
const DEFAULT_FALLBACK_RETRY_MS = 30_000

export interface LegacyMirrorWorkerOptions {
  sink: EventSink
  ledgerStore?: LedgerStore
  /** Re-opens the H1 file store during periodic recovery if initial startup open failed. */
  reopenLedgerStore?: () => LedgerStore | undefined
  /** Builds an authoritative H1 snapshot from orchestration.db for atomic rewrite on failure or retry. */
  createSnapshot?: () => LedgerSnapshot
  /** Debounced idle delay before flushing H1 mirror writes off the pre-first-token path. */
  idleDelayMs?: number
  /** Upper bound on queued mirror events before collapsing into an atomic snapshot rewrite. */
  maxPendingEvents?: number
  /** Maximum events drained per event-loop turn before yielding via `setImmediate`. */
  maxBatchEvents?: number
  /** Time budget (ms) per `#drain` slice before yielding via `setImmediate`. */
  maxSliceMs?: number
  /** Periodic retry interval (ms) while `h1_fallback_unavailable` is active (default 30,000 ms). */
  fallbackRetryIntervalMs?: number
  onError?: (error: unknown) => void
  onH1FallbackUnavailable?: (error: unknown) => void
  onH1FallbackRecovered?: (lastSeq: number) => void
}

/**
 * P4-2 pure downstream H1 mirror (Decision H, `data §4.5`).
 * - H1 is NEVER authoritative in `on` mode; `on` mode always rebuilds from `orchestration.db`.
 * - First entry into `on` writes a valid initial snapshot immediately (even with 0 runs).
 * - On ANY `append` failure (e.g. fsync ENOSPC, short write), NEVER retries `append` for the same
 *   `seq`; instead atomically rewrites H1 from a DB snapshot (`tmp + fsync + rename + dir fsync`).
 * - If atomic snapshot rewrite also fails, sets `orch_meta.h1_fallback_unavailable='1'`, logs, and
 *   retries periodically in-process; clears the flag once a snapshot rewrite succeeds.
 */
export class LegacyMirrorWorker {
  readonly #sink: EventSink
  #ledgerStore?: LedgerStore
  readonly #reopenLedgerStore?: () => LedgerStore | undefined
  readonly #createSnapshot: () => LedgerSnapshot
  readonly #idleDelayMs: number
  readonly #maxPendingEvents: number
  readonly #maxBatchEvents: number
  readonly #maxSliceMs: number
  readonly #fallbackRetryIntervalMs: number
  readonly #onError?: (error: unknown) => void
  readonly #onH1FallbackUnavailable?: (error: unknown) => void
  readonly #onH1FallbackRecovered?: (lastSeq: number) => void
  readonly #queue: LedgerEvent[] = []
  #pendingCompact: LedgerSnapshot | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #drainScheduled = false
  #closed = false
  #h1FallbackUnavailable = false
  #h1FallbackReason: string | null = null
  #lastMirroredSeq = 0
  #waiters: Array<() => void> = []

  constructor(options: LegacyMirrorWorkerOptions) {
    this.#sink = options.sink
    this.#ledgerStore = options.ledgerStore
    this.#reopenLedgerStore = options.reopenLedgerStore
    this.#createSnapshot = options.createSnapshot ?? (() => buildH1SnapshotFromDb(options.sink))
    this.#idleDelayMs = Math.max(0, options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS)
    this.#maxPendingEvents = Math.max(1, options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS)
    this.#maxBatchEvents = Math.max(1, options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS)
    this.#maxSliceMs = Math.max(1, options.maxSliceMs ?? DEFAULT_MAX_SLICE_MS)
    this.#fallbackRetryIntervalMs = Math.max(10, options.fallbackRetryIntervalMs ?? DEFAULT_FALLBACK_RETRY_MS)
    this.#onError = options.onError
    this.#onH1FallbackUnavailable = options.onH1FallbackUnavailable
    this.#onH1FallbackRecovered = options.onH1FallbackRecovered
    try {
      const existing = Number(this.#sink.getMeta('legacy_ledger_seq') ?? '0')
      if (Number.isFinite(existing) && existing > 0) this.#lastMirroredSeq = existing
    } catch {
      // Ignore if sink already fenced.
    }
    if (!this.#ledgerStore) {
      this.#markH1FallbackUnavailable(new Error('h1_ledger_store_unavailable'))
    }
  }

  pendingCount(): number {
    return this.#queue.length + (this.#pendingCompact ? 1 : 0)
  }

  isH1FallbackUnavailable(): boolean {
    return this.#h1FallbackUnavailable
  }

  h1FallbackReason(): string | null {
    return this.#h1FallbackReason
  }

  /** Backward-compatible alias for `isH1FallbackUnavailable()`. */
  isFailedClosed(): boolean {
    return this.#h1FallbackUnavailable
  }

  /**
   * Synchronously writes the startup H1 snapshot (Decision H: H1 must be a valid file immediately
   * upon entering `on` mode, even with 0 runs). If the write fails, degrades to
   * `h1_fallback_unavailable` with periodic retry while allowing `on` mode to continue.
   */
  writeInitialSnapshot(snapshot: LedgerSnapshot): boolean {
    if (this.#closed) return false
    if (!this.#ledgerStore?.compact) {
      this.#markH1FallbackUnavailable(new Error('h1_ledger_store_unavailable'))
      return false
    }
    try {
      const frozen = structuredClone(snapshot)
      this.#ledgerStore.compact(frozen)
      this.#lastMirroredSeq = Math.max(this.#lastMirroredSeq, frozen.lastSeq)
      this.#advanceLegacyMeta(frozen.lastSeq)
      this.#clearH1FallbackUnavailable()
      return true
    } catch (error) {
      this.#markH1FallbackUnavailable(error)
      return false
    }
  }

  #advanceLegacyMeta(seq: number): void {
    if (seq <= 0 || this.#sink.isWriteIndeterminate() || !this.#sink.handle.db.open) return
    try {
      const current = Number(this.#sink.getMeta('legacy_ledger_seq') ?? '0')
      if (seq > (Number.isFinite(current) ? current : 0)) {
        this.#sink.setMeta('legacy_ledger_seq', String(seq))
      }
    } catch {
      // Ignore if sink fenced.
    }
  }

  #scheduleFallbackRetry(): void {
    if (this.#closed || !this.#h1FallbackUnavailable || this.#retryTimer) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      this.#tryRecoverFallback()
    }, this.#fallbackRetryIntervalMs)
    this.#retryTimer.unref?.()
  }

  #tryRecoverFallback(): boolean {
    if (this.#closed || !this.#h1FallbackUnavailable) return false
    if (this.#sink.isWriteIndeterminate() || !this.#sink.handle.db.open) {
      this.#scheduleFallbackRetry()
      return false
    }
    if (!this.#ledgerStore && this.#reopenLedgerStore) {
      try {
        this.#ledgerStore = this.#reopenLedgerStore()
      } catch (error) {
        this.#updateFallbackReason(error)
        this.#scheduleFallbackRetry()
        return false
      }
    }
    if (!this.#ledgerStore?.compact) {
      this.#scheduleFallbackRetry()
      return false
    }
    try {
      const snap = structuredClone(this.#createSnapshot())
      this.#ledgerStore.compact(snap)
      this.#h1FallbackUnavailable = false
      this.#h1FallbackReason = null
      this.#lastMirroredSeq = Math.max(this.#lastMirroredSeq, snap.lastSeq)
      this.#advanceLegacyMeta(snap.lastSeq)
      this.#clearH1FallbackUnavailable()
      this.#onH1FallbackRecovered?.(snap.lastSeq)
      return true
    } catch (error) {
      this.#updateFallbackReason(error)
      this.#scheduleFallbackRetry()
      return false
    }
  }

  #updateFallbackReason(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error)
    this.#h1FallbackReason = reason
    if (!this.#sink.isWriteIndeterminate() && this.#sink.handle.db.open) {
      try {
        this.#sink.setMeta('h1_fallback_unavailable', '1')
        this.#sink.setMeta('h1_fallback_reason', reason)
      } catch {
        // Ignore if sink fenced.
      }
    }
  }

  #markH1FallbackUnavailable(error: unknown): void {
    const wasUnavailable = this.#h1FallbackUnavailable
    this.#h1FallbackUnavailable = true
    this.#h1FallbackReason = error instanceof Error ? error.message : String(error)
    if (!wasUnavailable) {
      this.#onError?.(error)
      this.#onH1FallbackUnavailable?.(error)
    }
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#drainScheduled = false
    this.#pendingCompact = null
    this.#queue.length = 0
    this.#updateFallbackReason(error)
    this.#scheduleFallbackRetry()
    this.#resolveWaiters()
  }

  #clearH1FallbackUnavailable(): void {
    this.#h1FallbackUnavailable = false
    this.#h1FallbackReason = null
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    if (!this.#sink.isWriteIndeterminate() && this.#sink.handle.db.open) {
      try {
        if (this.#sink.getMeta('h1_fallback_unavailable') === '1') {
          this.#sink.setMeta('h1_fallback_unavailable', '0')
          this.#sink.setMeta('h1_fallback_reason', '')
        }
      } catch {
        // Ignore if sink fenced.
      }
    }
  }

  enqueue(event: LedgerEvent): void {
    if (this.#closed || this.#h1FallbackUnavailable) return
    this.#queue.push(event)
    if (this.#queue.length > this.#maxPendingEvents) {
      if (this.#ledgerStore?.compact) {
        try {
          const snap = structuredClone(this.#createSnapshot())
          this.#pendingCompact = snap
          this.#queue.length = 0
        } catch (error) {
          this.#markH1FallbackUnavailable(error)
          return
        }
      } else {
        this.#markH1FallbackUnavailable(new Error('legacy_mirror_queue_overflow'))
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

  /** Enqueues an atomic H1 snapshot rewrite and drops queued events superseded by `snapshot.lastSeq`. */
  enqueueCompact(snapshot: LedgerSnapshot): void {
    if (this.#closed || this.#h1FallbackUnavailable) return
    this.#pendingCompact = structuredClone(snapshot)
    let drop = 0
    while (drop < this.#queue.length && this.#queue[drop]!.seq <= snapshot.lastSeq) drop += 1
    if (drop > 0) this.#queue.splice(0, drop)
    this.#schedule(this.#idleDelayMs)
  }

  #schedule(delayMs: number): void {
    if (this.#closed || this.#h1FallbackUnavailable || this.#timer || this.#drainScheduled) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#drain(false)
    }, delayMs)
    this.#timer.unref?.()
  }

  #scheduleNextSlice(flushAll: boolean): void {
    if (this.#closed || this.#h1FallbackUnavailable || this.#drainScheduled) return
    this.#drainScheduled = true
    setImmediate(() => {
      this.#drainScheduled = false
      this.#drain(flushAll)
    })
  }

  #atomicRewriteFromDb(): boolean {
    if (!this.#ledgerStore?.compact) {
      this.#markH1FallbackUnavailable(new Error('legacy_mirror_compact_unsupported'))
      return false
    }
    try {
      const snap = structuredClone(this.#createSnapshot())
      this.#ledgerStore.compact(snap)
      this.#pendingCompact = null
      let drop = 0
      while (drop < this.#queue.length && this.#queue[drop]!.seq <= snap.lastSeq) drop += 1
      if (drop > 0) this.#queue.splice(0, drop)
      this.#lastMirroredSeq = Math.max(this.#lastMirroredSeq, snap.lastSeq)
      this.#advanceLegacyMeta(this.#lastMirroredSeq)
      this.#clearH1FallbackUnavailable()
      return true
    } catch (rewriteError) {
      this.#markH1FallbackUnavailable(rewriteError)
      return false
    }
  }

  #drain(flushAll: boolean): void {
    if (this.#closed || this.#h1FallbackUnavailable || !this.#ledgerStore) {
      this.#resolveWaiters()
      return
    }
    const sliceStart = performance.now()
    let processed = 0

    if (this.#pendingCompact) {
      const snap = this.#pendingCompact
      try {
        this.#ledgerStore.compact?.(snap)
        this.#pendingCompact = null
        this.#lastMirroredSeq = Math.max(this.#lastMirroredSeq, snap.lastSeq)
        this.#clearH1FallbackUnavailable()
        processed += 1
      } catch (error) {
        this.#onError?.(error)
        this.#markH1FallbackUnavailable(error)
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
        this.#lastMirroredSeq = Math.max(this.#lastMirroredSeq, event.seq)
        processed += 1
      } catch (error) {
        this.#onError?.(error)
        if (!this.#atomicRewriteFromDb()) return
        processed += 1
        break
      }
      if (performance.now() - sliceStart >= this.#maxSliceMs) break
    }

    if (this.pendingCount() > 0) {
      this.#scheduleNextSlice(flushAll)
      return
    }

    this.#advanceLegacyMeta(this.#lastMirroredSeq)
    this.#resolveWaiters()
  }

  #resolveWaiters(): void {
    if (!this.#h1FallbackUnavailable && (this.pendingCount() > 0 || this.#timer || this.#drainScheduled)) return
    const list = this.#waiters.splice(0)
    for (const resolve of list) resolve()
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#h1FallbackUnavailable || this.pendingCount() === 0) return
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
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    this.#drainScheduled = false
    this.#pendingCompact = null
    this.#queue.length = 0
    this.#resolveWaiters()
  }
}
