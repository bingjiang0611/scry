import { randomUUID } from 'node:crypto'

// Host-side G1 application service: a durable, append-only ledger of remote
// session (run) lifecycle events with a server-authoritative monotonic cursor.
//
// This module is a pure state machine over an injected append-only store. It is
// NOT wired into live IPC, the network, or the RunRegistry yet; a trusted host
// controller must drive it. It exists to make the G1 invariants testable in
// isolation before touching the production Electron surface.
//
// Truthful state semantics (CLAUDE.md 证据不能说谎 / 生命周期不是多次调用):
//   - A remote task submission is a durable *intent*, recorded exactly once. An
//     intent being `recorded` is NOT execution: the host executor must later be
//     observed to dispatch/settle it. These are distinct lifecycle states and
//     are never collapsed.
//   - The cursor is the server sequence number, not wall time; every subscriber
//     reads strictly-increasing events after its own cursor.
//   - Durable intent fence: re-submitting the same intentId returns the existing
//     record and never creates a second run, so a client retry (or a crash and
//     replay) cannot double-dispatch.
//   - Crash recovery replays the persisted log; a recorded-but-not-terminal run
//     survives (its fence still holds) and is never silently completed.

export type RunLifecycle =
  | 'recorded'   // intent durably accepted; NOT executed
  | 'dispatched' // host executor acknowledged and started the run
  | 'settled'    // terminal success observed
  | 'failed'     // terminal failure observed
  | 'cancelled'  // cancellation observed

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

export interface LedgerStore {
  // Throw if the durable log cannot currently be trusted; the caller fences.
  assertAvailable(): void
  // The full ordered log, or throw. Used once at construction for recovery.
  loadAll(): LedgerEvent[]
  // Durably append exactly one event (return only after it is persisted).
  append(event: LedgerEvent): void
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
// The durable intent carries the complete validated remote routing envelope,
// including base64 attachments. Keep this aligned with host-controller's
// 700 KiB decoded attachment budget plus base64/JSON overhead. The file store
// still applies its independent 8 MiB record bound.
const MAX_INTENT_DETAIL = 1_200_000
const MAX_EVENT_DETAIL = 4_096
const DEFAULT_MAX_RUNS = 512
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

// Legal successor states. A terminal state accepts no further transition, and a
// run cannot be settled/failed before it is dispatched.
const NEXT: Record<RunLifecycle, RunLifecycle[]> = {
  recorded: ['dispatched', 'cancelled'],
  // Dispatch is strictly once: a second markDispatched is illegal, so the
  // dispatcher can rely on the durable recorded->dispatched transition as its
  // one-probe-per-intent fence. Progress is a separate, non-mutating event.
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

interface RunEntry {
  runId: string
  intentId: string
  lifecycle: RunLifecycle
}

export class SessionLedger {
  #store: LedgerStore
  #clock: () => number
  #maxRuns: number
  #maxEvents: number
  #pageSize: number
  #runs = new Map<string, RunEntry>()
  #byIntent = new Map<string, string>()
  #intentEvents = new Map<string, LedgerEvent>()
  #lastSeq = 0
  #count = 0

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
    const log = this.#store.loadAll()
    if (!Array.isArray(log)) throw new SessionLedgerError('ledger_log_corrupt')
    for (const event of log) {
      this.#validateShape(event)
      // Persisted logs are append-only: a gap or non-monotonic seq means the log
      // is untrustworthy. Fail closed rather than guessing the true order.
      if (event.seq !== this.#lastSeq + 1) throw new SessionLedgerError('ledger_log_corrupt')
      this.#apply(event, { recovering: true })
      this.#lastSeq = event.seq
      this.#count++
    }
  }

  #validateShape(event: unknown): asserts event is LedgerEvent {
    if (typeof event !== 'object' || event === null) throw new SessionLedgerError('ledger_log_corrupt')
    const candidate = event as Record<string, unknown>
    if (!Number.isInteger(candidate.seq) || (candidate.seq as number) < 1) throw new SessionLedgerError('ledger_log_corrupt')
    if (!Number.isFinite(candidate.at)) throw new SessionLedgerError('ledger_log_corrupt')
    if (typeof candidate.runId !== 'string' || !UUID.test(candidate.runId)) throw new SessionLedgerError('ledger_log_corrupt')
    if (typeof candidate.kind !== 'string') throw new SessionLedgerError('ledger_log_corrupt')
    const maxDetail = candidate.kind === 'intent_recorded' ? MAX_INTENT_DETAIL : MAX_EVENT_DETAIL
    if (candidate.detail !== undefined && (typeof candidate.detail !== 'string' || candidate.detail.length > maxDetail)) throw new SessionLedgerError('ledger_log_corrupt')
    if (candidate.intentId !== undefined && (typeof candidate.intentId !== 'string' || !UUID.test(candidate.intentId))) throw new SessionLedgerError('ledger_log_corrupt')
  }

  // Apply an already-shape-checked event to in-memory state. During recovery a
  // logically illegal sequence means the persisted log is corrupt; during live
  // operation the public methods have already validated the transition.
  #apply(event: LedgerEvent, { recovering }: { recovering: boolean }): void {
    if (event.kind === 'intent_recorded') {
      if (typeof event.intentId !== 'string') { if (recovering) throw new SessionLedgerError('ledger_log_corrupt'); return }
      if (this.#runs.has(event.runId) || this.#byIntent.has(event.intentId)) {
        if (recovering) throw new SessionLedgerError('ledger_log_corrupt')
        return
      }
      this.#runs.set(event.runId, { runId: event.runId, intentId: event.intentId, lifecycle: 'recorded' })
      this.#byIntent.set(event.intentId, event.runId)
      this.#intentEvents.set(event.intentId, event)
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
      return // progress does not change lifecycle
    }
    if (!NEXT[entry.lifecycle].includes(target)) { if (recovering) throw new SessionLedgerError('ledger_log_corrupt'); return }
    entry.lifecycle = target
  }

  #emit(event: Omit<LedgerEvent, 'seq' | 'at'>): LedgerEvent {
    this.#store.assertAvailable()
    if (this.#count >= this.#maxEvents) throw new SessionLedgerError('ledger_capacity_exceeded')
    const full: LedgerEvent = { ...event, seq: this.#lastSeq + 1, at: this.#clock() }
    // Durably append BEFORE mutating in-memory state: if append throws, the
    // caller sees the failure and in-memory state is not advanced past the log.
    this.#store.append(full)
    this.#apply(full, { recovering: false })
    this.#lastSeq = full.seq
    this.#count++
    return full
  }

  // Durably record a remote task submission. Idempotent on intentId: a retry
  // returns the original record and never creates a second run. Recording is
  // NOT execution.
  recordIntent(input: RecordIntentInput): IntentReceipt {
    if (!UUID.test(input.intentId ?? '')) throw new SessionLedgerError('invalid_intent_id')
    if (!UUID.test(input.runId ?? '')) throw new SessionLedgerError('invalid_run_id')
    if (input.detail !== undefined && (typeof input.detail !== 'string' || input.detail.length > MAX_INTENT_DETAIL)) throw new SessionLedgerError('invalid_detail')
    // The intentId is the idempotency key: the first recording binds the runId,
    // and any retry returns that original binding. The candidate runId passed on
    // a retry is an artifact of a stateless caller and is intentionally ignored.
    if (this.#byIntent.has(input.intentId)) {
      const existing = this.#firstEventFor(input.intentId)
      if (existing.detail !== input.detail) throw new SessionLedgerError('intent_payload_conflict')
      return { status: 'duplicate', event: existing }
    }
    if (this.#runs.has(input.runId)) throw new SessionLedgerError('run_already_exists')
    if (this.#runs.size >= this.#maxRuns) throw new SessionLedgerError('ledger_capacity_exceeded')
    const event = this.#emit({ runId: input.runId, kind: 'intent_recorded', intentId: input.intentId, detail: input.detail })
    return { status: 'recorded', event }
  }

  #firstEventFor(intentId: string): LedgerEvent {
    const event = this.#intentEvents.get(intentId)
    if (event) return event
    throw new SessionLedgerError('ledger_log_corrupt')
  }

  #transition(runId: string, target: Exclude<RunLifecycle, 'recorded'> | 'progress', detail?: string): LedgerEvent {
    if (!UUID.test(runId ?? '')) throw new SessionLedgerError('invalid_run_id')
    if (detail !== undefined && (typeof detail !== 'string' || detail.length > MAX_EVENT_DETAIL)) throw new SessionLedgerError('invalid_detail')
    const entry = this.#runs.get(runId)
    if (!entry) throw new SessionLedgerError('unknown_run')
    if (target === 'progress') {
      if (entry.lifecycle !== 'dispatched') throw new SessionLedgerError('illegal_transition')
    } else if (!NEXT[entry.lifecycle].includes(target)) {
      throw new SessionLedgerError('illegal_transition')
    }
    return this.#emit({ runId, kind: KIND_FOR[target], detail })
  }

  markDispatched(runId: string): LedgerEvent { return this.#transition(runId, 'dispatched') }
  markProgress(runId: string, detail?: string): LedgerEvent { return this.#transition(runId, 'progress', detail) }
  markSettled(runId: string): LedgerEvent { return this.#transition(runId, 'settled') }
  markFailed(runId: string, detail?: string): LedgerEvent { return this.#transition(runId, 'failed', detail) }
  markCancelled(runId: string): LedgerEvent { return this.#transition(runId, 'cancelled') }

  // Multi-client subscription: return events strictly after `cursor` (bounded),
  // plus the cursor to pass next time. `cursor` must be a real prior sequence.
  since(cursor: number): { events: LedgerEvent[]; cursor: number } {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.#lastSeq) throw new SessionLedgerError('invalid_cursor')
    if (cursor === this.#lastSeq) return { events: [], cursor }
    const log = this.#store.loadAll()
    const events = log.filter((event) => event.seq > cursor).slice(0, this.#pageSize)
    const nextCursor = events.length > 0 ? events[events.length - 1].seq : cursor
    return { events, cursor: nextCursor }
  }

  runState(runId: string): RunLifecycle | undefined {
    return this.#runs.get(runId)?.lifecycle
  }

  // Runs still awaiting their first dispatch, with the intent detail, so a
  // trusted dispatcher can drive exactly-once execution (including after a
  // restart). A run already past 'recorded' is intentionally not returned: an
  // interrupted dispatched run is ambiguous and must never be silently re-run.
  recordedIntents(): Array<{ runId: string; detail?: string }> {
    const pending: Array<{ runId: string; detail?: string }> = []
    for (const entry of this.#runs.values()) {
      if (entry.lifecycle !== 'recorded') continue
      const first = this.#store.loadAll().find((event) => event.intentId === entry.intentId)
      pending.push({ runId: entry.runId, detail: first?.detail })
    }
    return pending
  }

  describe(): { runs: number; events: number; lastSeq: number } {
    return { runs: this.#runs.size, events: this.#count, lastSeq: this.#lastSeq }
  }

  static newIntentId(): string { return randomUUID() }
  static newRunId(): string { return randomUUID() }
}
