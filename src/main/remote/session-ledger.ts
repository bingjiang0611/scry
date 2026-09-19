import { createHash, randomUUID } from 'node:crypto'

// Durable remote-run lifecycle ledger. Events are committed before in-memory
// state advances; compaction checkpoints state and keeps a bounded event tail.

export type RunLifecycle =
  | 'recorded'
  | 'dispatched'
  | 'settled'
  | 'failed'
  | 'cancelled'

export type LedgerEventKind =
  | 'intent_recorded'
  | 'run_dispatched'
  | 'run_progress'
  | 'run_settled'
  | 'run_failed'
  | 'run_cancelled'

export interface LedgerEvent {
  seq: number
  at: number
  runId: string
  kind: LedgerEventKind
  intentId?: string
  detail?: string
}

export interface LedgerSnapshotRun {
  runId: string
  intentId: string
  lifecycle: RunLifecycle
  intentSeq: number
  intentAt: number
  intentDigest: string
  // Only an undispatched intent needs its full routing envelope after restart.
  intentDetail?: string
}

export interface LedgerSnapshot {
  version: 1
  lastSeq: number
  runs: LedgerSnapshotRun[]
  retainedEvents: LedgerEvent[]
}

export interface LedgerRecovery {
  snapshot?: LedgerSnapshot
  events: LedgerEvent[]
}

export interface LedgerStore {
  assertAvailable(): void
  loadAll(): LedgerEvent[]
  append(event: LedgerEvent): void
  loadRecovery?(): LedgerRecovery
  shouldCompact?(nextEvent: LedgerEvent): boolean
  compact?(snapshot: LedgerSnapshot): void
}

export interface SessionLedgerDependencies {
  store: LedgerStore
  clock?: () => number
  maxRuns?: number
  maxEvents?: number
  pageSize?: number
}

export interface RecordIntentInput {
  intentId: string
  runId: string
  detail?: string
}

export type IntentReceipt =
  | { status: 'recorded'; event: LedgerEvent }
  | { status: 'duplicate'; event: LedgerEvent }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_INTENT_DETAIL = 1_200_000
const MAX_EVENT_DETAIL = 4_096
const DEFAULT_MAX_RUNS = 100_000
const DEFAULT_MAX_EVENTS = 8192
const DEFAULT_PAGE = 256

export class SessionLedgerError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.name = 'SessionLedgerError'
    this.code = code
  }
}

const NEXT: Record<RunLifecycle, RunLifecycle[]> = {
  recorded: ['dispatched', 'cancelled'],
  dispatched: ['settled', 'failed', 'cancelled'],
  settled: [],
  failed: [],
  cancelled: []
}
const KIND_FOR: Record<Exclude<RunLifecycle, 'recorded'> | 'progress', LedgerEventKind> = {
  dispatched: 'run_dispatched',
  progress: 'run_progress',
  settled: 'run_settled',
  failed: 'run_failed',
  cancelled: 'run_cancelled'
}
const LIFECYCLES = new Set<RunLifecycle>(['recorded', 'dispatched', 'settled', 'failed', 'cancelled'])

interface RunEntry extends LedgerSnapshotRun {}

function detailDigest(detail: string | undefined): string {
  return createHash('sha256').update(detail === undefined ? 'undefined' : `string\0${detail}`).digest('hex')
}

export class SessionLedger {
  #store: LedgerStore
  #clock: () => number
  #maxRuns: number
  #maxEvents: number
  #pageSize: number
  #runs = new Map<string, RunEntry>()
  #byIntent = new Map<string, string>()
  #events: LedgerEvent[] = []
  #lastSeq = 0
  #minCursor = 0
  #writeIndeterminate = false

  constructor(deps: SessionLedgerDependencies) {
    this.#store = deps.store
    this.#clock = deps.clock ?? (() => Date.now())
    this.#maxRuns = deps.maxRuns ?? DEFAULT_MAX_RUNS
    this.#maxEvents = deps.maxEvents ?? DEFAULT_MAX_EVENTS
    this.#pageSize = deps.pageSize ?? DEFAULT_PAGE
    this.#recover()
  }

  #recover(): void {
    this.#store.assertAvailable()
    const recovery = this.#store.loadRecovery?.() ?? { events: this.#store.loadAll() }
    if (recovery.snapshot) this.#recoverSnapshot(recovery.snapshot)
    if (!Array.isArray(recovery.events)) throw new SessionLedgerError('ledger_log_corrupt')
    for (const event of recovery.events) {
      this.#validateShape(event)
      if (event.seq !== this.#lastSeq + 1) throw new SessionLedgerError('ledger_log_corrupt')
      this.#apply(event, { recovering: true })
      this.#lastSeq = event.seq
      this.#events.push(event)
    }
    this.#refreshMinCursor()
  }

  #recoverSnapshot(snapshot: LedgerSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.lastSeq) || snapshot.lastSeq < 0 ||
        !Array.isArray(snapshot.runs) || snapshot.runs.length > this.#maxRuns || !Array.isArray(snapshot.retainedEvents)) {
      throw new SessionLedgerError('ledger_log_corrupt')
    }
    let previousSeq = 0
    for (const event of snapshot.retainedEvents) {
      this.#validateShape(event)
      if (event.seq <= previousSeq || event.seq > snapshot.lastSeq) throw new SessionLedgerError('ledger_log_corrupt')
      previousSeq = event.seq
    }
    for (const value of snapshot.runs) {
      if (!value || typeof value !== 'object' || !UUID.test(value.runId) || !UUID.test(value.intentId) ||
          !LIFECYCLES.has(value.lifecycle) || !Number.isSafeInteger(value.intentSeq) || value.intentSeq < 1 || value.intentSeq > snapshot.lastSeq ||
          !Number.isFinite(value.intentAt) || !DIGEST.test(value.intentDigest) ||
          (value.intentDetail !== undefined && (typeof value.intentDetail !== 'string' || value.intentDetail.length > MAX_INTENT_DETAIL)) ||
          (value.lifecycle === 'recorded' && detailDigest(value.intentDetail) !== value.intentDigest) ||
          this.#runs.has(value.runId) || this.#byIntent.has(value.intentId)) throw new SessionLedgerError('ledger_log_corrupt')
      const entry = { ...value }
      this.#runs.set(entry.runId, entry)
      this.#byIntent.set(entry.intentId, entry.runId)
    }
    this.#lastSeq = snapshot.lastSeq
    this.#events = snapshot.retainedEvents.map((event) => ({ ...event }))
  }

  #validateShape(event: unknown): asserts event is LedgerEvent {
    if (typeof event !== 'object' || event === null) throw new SessionLedgerError('ledger_log_corrupt')
    const candidate = event as Record<string, unknown>
    if (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 1) throw new SessionLedgerError('ledger_log_corrupt')
    if (!Number.isFinite(candidate.at)) throw new SessionLedgerError('ledger_log_corrupt')
    if (typeof candidate.runId !== 'string' || !UUID.test(candidate.runId)) throw new SessionLedgerError('ledger_log_corrupt')
    if (typeof candidate.kind !== 'string' || !Object.values(KIND_FOR).includes(candidate.kind as LedgerEventKind) && candidate.kind !== 'intent_recorded') throw new SessionLedgerError('ledger_log_corrupt')
    const maxDetail = candidate.kind === 'intent_recorded' ? MAX_INTENT_DETAIL : MAX_EVENT_DETAIL
    if (candidate.detail !== undefined && (typeof candidate.detail !== 'string' || candidate.detail.length > maxDetail)) throw new SessionLedgerError('ledger_log_corrupt')
    if (candidate.intentId !== undefined && (typeof candidate.intentId !== 'string' || !UUID.test(candidate.intentId))) throw new SessionLedgerError('ledger_log_corrupt')
  }

  #apply(event: LedgerEvent, { recovering }: { recovering: boolean }): void {
    if (event.kind === 'intent_recorded') {
      if (typeof event.intentId !== 'string') { if (recovering) throw new SessionLedgerError('ledger_log_corrupt'); return }
      if (this.#runs.has(event.runId) || this.#byIntent.has(event.intentId)) {
        if (recovering) throw new SessionLedgerError('ledger_log_corrupt')
        return
      }
      const entry: RunEntry = {
        runId: event.runId,
        intentId: event.intentId,
        lifecycle: 'recorded',
        intentSeq: event.seq,
        intentAt: event.at,
        intentDigest: detailDigest(event.detail),
        ...(event.detail !== undefined ? { intentDetail: event.detail } : {})
      }
      this.#runs.set(event.runId, entry)
      this.#byIntent.set(event.intentId, event.runId)
      return
    }
    const entry = this.#runs.get(event.runId)
    if (!entry) { if (recovering) throw new SessionLedgerError('ledger_log_corrupt'); return }
    const target: RunLifecycle | 'progress' =
      event.kind === 'run_dispatched' ? 'dispatched'
      : event.kind === 'run_progress' ? 'progress'
      : event.kind === 'run_settled' ? 'settled'
      : event.kind === 'run_failed' ? 'failed'
      : 'cancelled'
    if (target === 'progress') {
      if (entry.lifecycle !== 'dispatched') { if (recovering) throw new SessionLedgerError('ledger_log_corrupt'); return }
      return
    }
    if (!NEXT[entry.lifecycle].includes(target)) { if (recovering) throw new SessionLedgerError('ledger_log_corrupt'); return }
    entry.lifecycle = target
    delete entry.intentDetail
  }

  #refreshMinCursor(): void {
    this.#minCursor = this.#events.length > 0 ? this.#events[0].seq - 1 : this.#lastSeq
  }

  #snapshot(): LedgerSnapshot {
    const retainCount = Math.min(this.#events.length, Math.max(this.#pageSize * 2, 32), Math.floor(this.#maxEvents / 2))
    const retainedEvents = retainCount > 0 ? this.#events.slice(-retainCount) : []
    return {
      version: 1,
      lastSeq: this.#lastSeq,
      runs: [...this.#runs.values()].map((entry) => ({ ...entry })),
      retainedEvents
    }
  }

  #assertDeterminate(): void {
    if (this.#writeIndeterminate) throw new SessionLedgerError('ledger_write_indeterminate')
  }

  #compact(): void {
    if (!this.#store.compact) throw new SessionLedgerError('ledger_capacity_exceeded')
    const snapshot = this.#snapshot()
    try {
      this.#store.compact(snapshot)
    } catch (error) {
      this.#writeIndeterminate = true
      throw error
    }
    this.#events = snapshot.retainedEvents
    this.#refreshMinCursor()
  }

  #emit(event: Omit<LedgerEvent, 'seq' | 'at'>): LedgerEvent {
    this.#assertDeterminate()
    this.#store.assertAvailable()
    const full: LedgerEvent = { ...event, seq: this.#lastSeq + 1, at: this.#clock() }
    if (this.#events.length >= this.#maxEvents || this.#store.shouldCompact?.(full)) this.#compact()
    try {
      this.#store.append(full)
    } catch (error) {
      this.#writeIndeterminate = true
      throw error
    }
    this.#apply(full, { recovering: false })
    this.#lastSeq = full.seq
    this.#events.push(full)
    this.#refreshMinCursor()
    return full
  }

  recordIntent(input: RecordIntentInput): IntentReceipt {
    this.#assertDeterminate()
    if (!UUID.test(input.intentId ?? '')) throw new SessionLedgerError('invalid_intent_id')
    if (!UUID.test(input.runId ?? '')) throw new SessionLedgerError('invalid_run_id')
    if (input.detail !== undefined && (typeof input.detail !== 'string' || input.detail.length > MAX_INTENT_DETAIL)) throw new SessionLedgerError('invalid_detail')
    if (this.#byIntent.has(input.intentId)) {
      const runId = this.#byIntent.get(input.intentId)!
      const entry = this.#runs.get(runId)
      if (!entry) throw new SessionLedgerError('ledger_log_corrupt')
      if (entry.intentDigest !== detailDigest(input.detail)) throw new SessionLedgerError('intent_payload_conflict')
      return {
        status: 'duplicate',
        event: {
          seq: entry.intentSeq, at: entry.intentAt, runId: entry.runId,
          kind: 'intent_recorded', intentId: entry.intentId,
          ...(entry.intentDetail !== undefined ? { detail: entry.intentDetail } : {})
        }
      }
    }
    if (this.#runs.has(input.runId)) throw new SessionLedgerError('run_already_exists')
    if (this.#runs.size >= this.#maxRuns) throw new SessionLedgerError('ledger_capacity_exceeded')
    return { status: 'recorded', event: this.#emit({ runId: input.runId, kind: 'intent_recorded', intentId: input.intentId, detail: input.detail }) }
  }

  #transition(runId: string, target: Exclude<RunLifecycle, 'recorded'> | 'progress', detail?: string): LedgerEvent {
    this.#assertDeterminate()
    if (!UUID.test(runId ?? '')) throw new SessionLedgerError('invalid_run_id')
    if (detail !== undefined && (typeof detail !== 'string' || detail.length > MAX_EVENT_DETAIL)) throw new SessionLedgerError('invalid_detail')
    const entry = this.#runs.get(runId)
    if (!entry) throw new SessionLedgerError('unknown_run')
    if (target === 'progress') {
      if (entry.lifecycle !== 'dispatched') throw new SessionLedgerError('illegal_transition')
    } else if (!NEXT[entry.lifecycle].includes(target)) throw new SessionLedgerError('illegal_transition')
    return this.#emit({ runId, kind: KIND_FOR[target], detail })
  }

  markDispatched(runId: string): LedgerEvent { return this.#transition(runId, 'dispatched') }
  markProgress(runId: string, detail?: string): LedgerEvent { return this.#transition(runId, 'progress', detail) }
  markSettled(runId: string): LedgerEvent { return this.#transition(runId, 'settled') }
  markFailed(runId: string, detail?: string): LedgerEvent { return this.#transition(runId, 'failed', detail) }
  markCancelled(runId: string): LedgerEvent { return this.#transition(runId, 'cancelled') }

  since(cursor: number): { events: LedgerEvent[]; cursor: number; reset?: { requested: number; availableFrom: number } } {
    this.#assertDeterminate()
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.#lastSeq) throw new SessionLedgerError('invalid_cursor')
    const requested = cursor
    const reset = cursor < this.#minCursor ? { requested, availableFrom: this.#minCursor } : undefined
    const effectiveCursor = reset ? this.#minCursor : cursor
    if (effectiveCursor === this.#lastSeq) return { events: [], cursor: effectiveCursor, ...(reset ? { reset } : {}) }
    const events = this.#events.filter((event) => event.seq > effectiveCursor).slice(0, this.#pageSize)
    const nextCursor = events.length > 0 ? events[events.length - 1].seq : effectiveCursor
    return { events, cursor: nextCursor, ...(reset ? { reset } : {}) }
  }

  runState(runId: string): RunLifecycle | undefined {
    this.#assertDeterminate()
    return this.#runs.get(runId)?.lifecycle
  }

  recordedIntents(): Array<{ runId: string; detail?: string }> {
    this.#assertDeterminate()
    const pending: Array<{ runId: string; detail?: string }> = []
    for (const entry of this.#runs.values()) {
      if (entry.lifecycle === 'recorded') pending.push({ runId: entry.runId, detail: entry.intentDetail })
    }
    return pending
  }

  describe(): { runs: number; events: number; lastSeq: number } {
    return { runs: this.#runs.size, events: this.#lastSeq, lastSeq: this.#lastSeq }
  }

  static newIntentId(): string { return randomUUID() }
  static newRunId(): string { return randomUUID() }
}
