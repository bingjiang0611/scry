import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SessionLedger, SessionLedgerError, type LedgerEvent, type LedgerStore } from './session-ledger'

class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[]
  available = true
  failNextAppend = false
  constructor(seed: LedgerEvent[] = []) { this.log = seed.map((e) => ({ ...e })) }
  assertAvailable(): void { if (!this.available) throw new Error('ledger_store_unavailable') }
  loadAll(): LedgerEvent[] { return this.log.map((e) => ({ ...e })) }
  append(event: LedgerEvent): void {
    if (this.failNextAppend) { this.failNextAppend = false; throw new Error('disk full') }
    this.log.push({ ...event })
  }
}

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); throw new Error('expected throw ' + code) }
  catch (error) {
    expect(error).toBeInstanceOf(SessionLedgerError)
    expect((error as SessionLedgerError).code).toBe(code)
  }
}

describe('SessionLedger', () => {
  it('records an intent as durable but NOT executed, at seq 1', () => {
    const store = new MemoryLedgerStore()
    const ledger = new SessionLedger({ store })
    const runId = randomUUID()
    const intentId = randomUUID()
    const receipt = ledger.recordIntent({ intentId, runId, detail: 'build the thing' })
    expect(receipt.status).toBe('recorded')
    expect(receipt.event.seq).toBe(1)
    expect(receipt.event.kind).toBe('intent_recorded')
    expect(ledger.runState(runId)).toBe('recorded')
    expect(ledger.describe()).toEqual({ runs: 1, events: 1, lastSeq: 1 })
  })

  it('fences duplicate intents: a retry returns the original and never double-creates', () => {
    const store = new MemoryLedgerStore()
    const ledger = new SessionLedger({ store })
    const runId = randomUUID()
    const intentId = randomUUID()
    const first = ledger.recordIntent({ intentId, runId })
    const retry = ledger.recordIntent({ intentId, runId })
    expect(retry.status).toBe('duplicate')
    expect(retry.event.seq).toBe(first.event.seq)
    expect(ledger.describe().events).toBe(1)
    // Same intent id can never be re-pointed at a different run.
    expectCode(() => ledger.recordIntent({ intentId, runId: randomUUID() }), 'intent_run_mismatch')
    // A fresh intent may not reuse an existing run id.
    expectCode(() => ledger.recordIntent({ intentId: randomUUID(), runId }), 'run_already_exists')
  })

  it('enforces a truthful lifecycle and rejects illegal transitions', () => {
    const store = new MemoryLedgerStore()
    const ledger = new SessionLedger({ store })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    expectCode(() => ledger.markSettled(runId), 'illegal_transition') // cannot settle before dispatch
    ledger.markDispatched(runId)
    ledger.markProgress(runId, 'edited 2 files')
    expect(ledger.runState(runId)).toBe('dispatched')
    ledger.markSettled(runId)
    expect(ledger.runState(runId)).toBe('settled')
    expectCode(() => ledger.markProgress(runId), 'illegal_transition') // terminal is terminal
    expectCode(() => ledger.markDispatched(randomUUID()), 'unknown_run')
  })

  it('serves a monotonic multi-client cursor and validates it', () => {
    const store = new MemoryLedgerStore()
    const ledger = new SessionLedger({ store, pageSize: 2 })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    ledger.markDispatched(runId)
    ledger.markProgress(runId, 'a')
    ledger.markSettled(runId)
    const first = ledger.since(0)
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]) // bounded page
    const second = ledger.since(first.cursor)
    expect(second.events.map((e) => e.seq)).toEqual([3, 4])
    expect(ledger.since(second.cursor).events).toEqual([]) // caught up
    expectCode(() => ledger.since(-1), 'invalid_cursor')
    expectCode(() => ledger.since(99), 'invalid_cursor')
    expectCode(() => ledger.since(1.5), 'invalid_cursor')
  })

  it('recovers durable state after a restart and keeps the intent fence', () => {
    const store = new MemoryLedgerStore()
    const ledger = new SessionLedger({ store })
    const finishedRun = randomUUID()
    const openIntent = randomUUID()
    const openRun = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId: finishedRun })
    ledger.markDispatched(finishedRun)
    ledger.markSettled(finishedRun)
    ledger.recordIntent({ intentId: openIntent, runId: openRun })
    ledger.markDispatched(openRun) // recorded+dispatched but not terminal

    // Restart over the SAME persisted log.
    const revived = new SessionLedger({ store: new MemoryLedgerStore(store.log) })
    expect(revived.describe()).toEqual({ runs: 2, events: 5, lastSeq: 5 })
    expect(revived.runState(finishedRun)).toBe('settled')
    expect(revived.runState(openRun)).toBe('dispatched') // open run survives, not silently completed
    // Re-submitting the open intent after restart is a duplicate: no double dispatch.
    const replay = revived.recordIntent({ intentId: openIntent, runId: openRun })
    expect(replay.status).toBe('duplicate')
    expect(revived.describe().events).toBe(5)
    // New work continues at the correct next sequence.
    const next = revived.recordIntent({ intentId: randomUUID(), runId: randomUUID() })
    expect(next.event.seq).toBe(6)
  })

  it('fails closed on a corrupt persisted log', () => {
    const good: LedgerEvent = { seq: 1, at: 1, runId: randomUUID(), kind: 'intent_recorded', intentId: randomUUID() }
    // Sequence gap.
    expectCode(() => new SessionLedger({ store: new MemoryLedgerStore([{ ...good, seq: 2 }]) }), 'ledger_log_corrupt')
    // Transition referencing an unknown run.
    expectCode(() => new SessionLedger({ store: new MemoryLedgerStore([{ seq: 1, at: 1, runId: randomUUID(), kind: 'run_settled' }]) }), 'ledger_log_corrupt')
    // Malformed shape.
    expectCode(() => new SessionLedger({ store: new MemoryLedgerStore([{ ...good, runId: 'not-a-uuid' }]) }), 'ledger_log_corrupt')
  })

  it('fences a failed durable append without advancing in-memory state', () => {
    const store = new MemoryLedgerStore()
    const ledger = new SessionLedger({ store })
    const runId = randomUUID()
    store.failNextAppend = true
    expect(() => ledger.recordIntent({ intentId: randomUUID(), runId })).toThrow('disk full')
    expect(ledger.describe()).toEqual({ runs: 0, events: 0, lastSeq: 0 })
    expect(store.log).toHaveLength(0)
    // After the transient failure, recording succeeds at seq 1 (no gap).
    const ok = ledger.recordIntent({ intentId: randomUUID(), runId })
    expect(ok.event.seq).toBe(1)
    expect(ledger.runState(runId)).toBe('recorded')
  })

  it('enforces capacity and store availability', () => {
    const runsStore = new MemoryLedgerStore()
    const runsLedger = new SessionLedger({ store: runsStore, maxRuns: 1 })
    runsLedger.recordIntent({ intentId: randomUUID(), runId: randomUUID() })
    expectCode(() => runsLedger.recordIntent({ intentId: randomUUID(), runId: randomUUID() }), 'ledger_capacity_exceeded')

    const eventsStore = new MemoryLedgerStore()
    const eventsLedger = new SessionLedger({ store: eventsStore, maxEvents: 1 })
    const runId = randomUUID()
    eventsLedger.recordIntent({ intentId: randomUUID(), runId })
    expectCode(() => eventsLedger.markDispatched(runId), 'ledger_capacity_exceeded')

    const downStore = new MemoryLedgerStore()
    const downLedger = new SessionLedger({ store: downStore })
    downStore.available = false
    expect(() => downLedger.recordIntent({ intentId: randomUUID(), runId: randomUUID() })).toThrow('ledger_store_unavailable')
  })

  it('validates identifiers and detail bounds', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    expectCode(() => ledger.recordIntent({ intentId: 'x', runId: randomUUID() }), 'invalid_intent_id')
    expectCode(() => ledger.recordIntent({ intentId: randomUUID(), runId: 'x' }), 'invalid_run_id')
    expectCode(() => ledger.recordIntent({ intentId: randomUUID(), runId: randomUUID(), detail: 'z'.repeat(4097) }), 'invalid_detail')
  })
})
