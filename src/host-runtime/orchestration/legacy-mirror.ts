import type { LedgerEvent, LedgerSnapshot, LedgerStore } from '../../main/remote/session-ledger'
import type { EventSink } from './event-sink'
import { buildH1SnapshotFromDb } from './legacy-snapshot-builder'

const DEFAULT_IDLE_DELAY_MS = 250
const DEFAULT_MAX_PENDING_EVENTS = 2_048
const DEFAULT_MAX_BATCH_EVENTS = 32
const DEFAULT_MAX_SLICE_MS = 8

export interface LegacyMirrorWorkerOptions {
  sink: EventSink
  ledgerStore?: LedgerStore
  /** Builds an authoritative H1 snapshot from orchestration.db for atomic rewrite on failure or overflow. */
  createSnapshot?: () => LedgerSnapshot
  /** Debounced idle delay before flushing H1 mirror writes off the pre-first-token path. */
  idleDelayMs?: number
  /** Upper bound on queued mirror events before collapsing into an atomic snapshot rewrite. */
  maxPendingEvents?: number
  /** Maximum events drained per event-loop turn before yielding via `setImmediate`. */
  maxBatchEvents?: number
  /** Time budget (ms) per `#drain` slice before yielding via `setImmediate`. */
  maxSliceMs?: number
  onError?: (error: unknown) => void
  onH1FallbackUnavailable?: (error: unknown) => void
}

/**
 * P4-2 pure downstream H1 mirror (`plan §9`, `data §4.5`, W9 Round-3 B1-B3 fix).
 * - H1 is NEVER authoritative in `on` mode; `on` mode always rebuilds from `orchestration.db`.
 * - On ANY `append` failure (e.g. fsync ENOSPC after write, or short write), NEVER retries
 *   `append` for the same `seq` (avoiding duplicate seq / corrupt partial lines). Instead,
 *   atomically rewrites H1 from a DB-built snapshot (`tmp + fsync + rename + dir fsync`).
 * - If atomic snapshot rewrite also fails (e.g. persistent ENOSPC), marks H1 fallback
 *   unavailable in `orch_meta` + logs and stops mirroring; `on` mode continues unaffected.
 * - Drains in bounded slices (`maxBatchEvents` / `maxSliceMs`) yielding via `setImmediate`.
 */
export class LegacyMirrorWorker {
  readonly #sink: EventSink
  readonly #ledgerStore?: LedgerStore
  readonly #createSnapshot: () => LedgerSnapshot
  readonly #idleDelayMs: number
  readonly #maxPendingEvents: number
  readonly #maxBatchEvents: number
  readonly #maxSliceMs: number
  readonly #onError?: (error: unknown) => void
  readonly #onH1FallbackUnavailable?: (error: unknown) => void
  readonly #queue: LedgerEvent[] = []
  #pendingCompact: LedgerSnapshot | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #drainScheduled = false
  #closed = false
  #h1FallbackUnavailable = false
  #lastMirroredSeq = 0
  #waiters: Array<() => void> = []

  constructor(options: LegacyMirrorWorkerOptions) {
    this.#sink = options.sink
    this.#ledgerStore = options.ledgerStore
    this.#createSnapshot = options.createSnapshot ?? (() => buildH1SnapshotFromDb(options.sink))
    this.#idleDelayMs = Math.max(0, options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS)
    this.#maxPendingEvents = Math.max(1, options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS)
    this.#maxBatchEvents = Math.max(1, options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS)
    this.#maxSliceMs = Math.max(1, options.maxSliceMs ?? DEFAULT_MAX_SLICE_MS)
    this.#onError = options.onError
    this.#onH1FallbackUnavailable = options.onH1FallbackUnavailable
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

  /** Backward-compatible alias for `isH1FallbackUnavailable()`. */
  isFailedClosed(): boolean {
    return this.#h1FallbackUnavailable
  }

  #markH1FallbackUnavailable(error: unknown): void {
    if (this.#h1FallbackUnavailable) return
    this.#h1FallbackUnavailable = true
    this.#onError?.(error)
    this.#onH1FallbackUnavailable?.(error)
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#drainScheduled = false
    this.#pendingCompact = null
    this.#queue.length = 0
    if (!this.#sink.isWriteIndeterminate() && this.#sink.handle.db.open) {
      try {
        this.#sink.setMeta('h1_fallback_unavailable', '1')
        this.#sink.setMeta('h1_fallback_reason', error instanceof Error ? error.message : String(error))
      } catch {
        // Ignore meta update failure if sink fenced.
      }
    }
    this.#resolveWaiters()
  }

  #clearH1FallbackUnavailable(): void {
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
        // Atomic snapshot rewrite failed -> H1 fallback is unavailable; on mode continues unaffected.
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
        // B1 fix: NEVER retry `append` for the same seq (write may have succeeded before fsync
        // failed or written a short line). Atomically rewrite H1 from DB snapshot instead.
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

    if (!this.#sink.isWriteIndeterminate() && this.#sink.handle.db.open) {
      try {
        if (this.#lastMirroredSeq > 0) {
          const current = Number(this.#sink.getMeta('legacy_ledger_seq') ?? '0')
          if (this.#lastMirroredSeq > current) {
            this.#sink.setMeta('legacy_ledger_seq', String(this.#lastMirroredSeq))
          }
        }
      } catch (error) {
        this.#onError?.(error)
      }
    }
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
    this.#drainScheduled = false
    this.#pendingCompact = null
    this.#queue.length = 0
    this.#resolveWaiters()
  }
}
