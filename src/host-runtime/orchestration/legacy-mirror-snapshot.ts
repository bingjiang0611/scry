import { createHash } from 'node:crypto'
import type {
  LedgerEvent,
  LedgerRecovery,
  LedgerSnapshot,
  LedgerSnapshotRun,
  RunLifecycle
} from '../../main/remote/session-ledger'

const RETAIN_TAIL_EVENTS = 512

function detailDigest(detail: string | undefined): string {
  return createHash('sha256')
    .update(detail === undefined ? 'undefined' : `string\0${detail}`)
    .digest('hex')
}

const NEXT_LIFECYCLE: Partial<Record<LedgerEvent['kind'], RunLifecycle>> = {
  run_dispatched: 'dispatched',
  run_settled: 'settled',
  run_failed: 'failed',
  run_cancelled: 'cancelled'
}

export class MemoryLedgerSnapshotTracker {
  readonly #runs = new Map<string, LedgerSnapshotRun>()
  #retained: LedgerEvent[] = []
  #lastSeq = 0

  constructor(initial: LedgerRecovery) {
    if (initial.snapshot) {
      this.applyCompact(initial.snapshot)
    }
    for (const event of initial.events) {
      this.apply(event)
    }
  }

  applyCompact(snapshot: LedgerSnapshot): void {
    const frozen = structuredClone(snapshot)
    this.#runs.clear()
    for (const run of frozen.runs) {
      this.#runs.set(run.runId, run)
    }
    this.#lastSeq = frozen.lastSeq
    this.#retained = frozen.retainedEvents.slice(-RETAIN_TAIL_EVENTS)
  }

  apply(event: LedgerEvent): void {
    this.#lastSeq = Math.max(this.#lastSeq, event.seq)
    if (event.kind === 'intent_recorded' && event.intentId) {
      this.#runs.set(event.runId, {
        runId: event.runId,
        intentId: event.intentId,
        lifecycle: 'recorded',
        intentSeq: event.seq,
        intentAt: event.at,
        intentDigest: detailDigest(event.detail),
        ...(event.detail !== undefined ? { intentDetail: event.detail } : {})
      })
    } else {
      const next = NEXT_LIFECYCLE[event.kind]
      if (next) {
        const existing = this.#runs.get(event.runId)
        if (existing) {
          existing.lifecycle = next
          delete existing.intentDetail
        }
      }
    }
    this.#retained.push({ ...event })
    if (this.#retained.length > RETAIN_TAIL_EVENTS) {
      this.#retained.splice(0, this.#retained.length - RETAIN_TAIL_EVENTS)
    }
  }

  createSnapshot(): LedgerSnapshot {
    return {
      version: 1,
      lastSeq: this.#lastSeq,
      runs: [...this.#runs.values()].map((entry) => ({ ...entry })),
      retainedEvents: this.#retained.map((event) => ({ ...event }))
    }
  }
}
