import type { LedgerEvent, LedgerStore } from '../../main/remote/session-ledger'
import type { EventSink } from './event-sink'

export interface LegacyMirrorWorkerOptions {
  sink: EventSink
  ledgerStore: LedgerStore
  onError?: (error: unknown) => void
}

/**
 * P4-2 async post-commit H1 mirror (`plan §9`, `data §4.5`).
 * Appends mirrored lifecycle events to `SessionLedgerFileStore` off the pre-first-token
 * critical path and idempotently advances `orch_meta.legacy_ledger_seq`.
 * Explicitly NOT a strict rollback guarantee (plan §9).
 */
export class LegacyMirrorWorker {
  readonly #sink: EventSink
  readonly #ledgerStore: LedgerStore
  readonly #onError?: (error: unknown) => void
  readonly #queue: LedgerEvent[] = []
  #scheduled = false
  #closed = false
  #lastMirroredSeq = 0
  #waiters: Array<() => void> = []

  constructor(options: LegacyMirrorWorkerOptions) {
    this.#sink = options.sink
    this.#ledgerStore = options.ledgerStore
    this.#onError = options.onError
    try {
      const existing = Number(this.#sink.getMeta('legacy_ledger_seq') ?? '0')
      if (Number.isFinite(existing) && existing > 0) this.#lastMirroredSeq = existing
    } catch {
      // Ignore if sink already fenced.
    }
  }

  enqueue(event: LedgerEvent): void {
    if (this.#closed) return
    this.#queue.push(event)
    if (!this.#scheduled) {
      this.#scheduled = true
      setImmediate(() => this.#drain())
    }
  }

  #drain(): void {
    this.#scheduled = false
    if (this.#closed) {
      this.#resolveWaiters()
      return
    }
    let maxSeq = this.#lastMirroredSeq
    while (this.#queue.length > 0) {
      const event = this.#queue.shift()!
      if (event.seq <= this.#lastMirroredSeq) continue
      try {
        this.#ledgerStore.append(event)
        maxSeq = Math.max(maxSeq, event.seq)
        this.#lastMirroredSeq = maxSeq
      } catch (error) {
        this.#onError?.(error)
        break
      }
    }
    if (maxSeq > 0 && !this.#sink.isWriteIndeterminate() && this.#sink.handle.db.open) {
      try {
        const current = Number(this.#sink.getMeta('legacy_ledger_seq') ?? '0')
        if (maxSeq > current) this.#sink.setMeta('legacy_ledger_seq', String(maxSeq))
      } catch (error) {
        this.#onError?.(error)
      }
    }
    this.#resolveWaiters()
  }

  #resolveWaiters(): void {
    if (this.#queue.length > 0 || this.#scheduled) return
    const list = this.#waiters.splice(0)
    for (const resolve of list) resolve()
  }

  async flush(): Promise<void> {
    if (this.#queue.length === 0 && !this.#scheduled) return
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
      if (!this.#scheduled) {
        this.#scheduled = true
        setImmediate(() => this.#drain())
      }
    })
  }

  async close(): Promise<void> {
    await this.flush()
    this.#closed = true
    this.#queue.length = 0
    this.#resolveWaiters()
  }
}
