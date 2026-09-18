import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, chmodSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionLedger, SessionLedgerError, type LedgerEvent, type LedgerStore } from './session-ledger'
import { SessionLedgerFileStore } from './session-ledger-file'

function privateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-ledger-'))
  chmodSync(dir, 0o700)
  return dir
}

class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[]
  available = true
  failNextAppend = false
  failAfterAppend = false
  loadCalls = 0
  constructor(seed: LedgerEvent[] = []) { this.log = seed.map((e) => ({ ...e })) }
  assertAvailable(): void { if (!this.available) throw new Error('ledger_store_unavailable') }
  loadAll(): LedgerEvent[] {
    this.loadCalls++
    return this.log.map((e) => ({ ...e }))
  }
  append(event: LedgerEvent): void {
    if (this.failNextAppend) { this.failNextAppend = false; throw new Error('disk full') }
    this.log.push({ ...event })
    if (this.failAfterAppend) { this.failAfterAppend = false; throw new Error('receipt lost') }
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
    // The intentId is the idempotency key: a retry with a different candidate
    // runId still returns the original binding and creates no second run.
    const rebound = ledger.recordIntent({ intentId, runId: randomUUID() })
    expect(rebound.status).toBe('duplicate')
    expect(rebound.event.runId).toBe(runId)
    expect(ledger.describe().events).toBe(1)
    expect(store.loadCalls).toBe(1) // recovery only; duplicate checks stay incremental
    expectCode(() => ledger.recordIntent({ intentId, runId: randomUUID(), detail: 'different' }), 'intent_payload_conflict')
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
    // The store API cannot prove whether the failed append reached disk. Fence
    // this instance until a fresh recovery reconciles the durable bytes.
    expectCode(() => ledger.recordIntent({ intentId: randomUUID(), runId }), 'ledger_write_indeterminate')
    expectCode(() => ledger.runState(runId), 'ledger_write_indeterminate')
    const recovered = new SessionLedger({ store })
    const ok = recovered.recordIntent({ intentId: randomUUID(), runId })
    expect(ok.event.seq).toBe(1)
    expect(recovered.runState(runId)).toBe('recorded')
  })

  it('reconciles a lost append receipt only through fresh recovery', () => {
    const store = new MemoryLedgerStore()
    const runId = randomUUID()
    const ledger = new SessionLedger({ store })
    ledger.recordIntent({ intentId: randomUUID(), runId })
    store.failAfterAppend = true
    expect(() => ledger.markDispatched(runId)).toThrow('receipt lost')
    expectCode(() => ledger.markDispatched(runId), 'ledger_write_indeterminate')
    const recovered = new SessionLedger({ store })
    expect(recovered.runState(runId)).toBe('dispatched')
    expect(recovered.describe()).toEqual({ runs: 1, events: 2, lastSeq: 2 })
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
    const detailedRunId = randomUUID()
    expect(() => ledger.recordIntent({ intentId: randomUUID(), runId: detailedRunId, detail: 'z'.repeat(6_000) })).not.toThrow()
    ledger.markDispatched(detailedRunId)
    expectCode(() => ledger.markProgress(detailedRunId, 'z'.repeat(4_097)), 'invalid_detail')
    expectCode(() => ledger.recordIntent({ intentId: randomUUID(), runId: randomUUID(), detail: 'z'.repeat(1_200_001) }), 'invalid_detail')
  })
})

describe('SessionLedgerFileStore', () => {
  it('durably persists the log and recovers exact state across a restart', () => {
    const dir = privateDir()
    try {
      const store = new SessionLedgerFileStore(dir)
      const ledger = new SessionLedger({ store })
      const runId = randomUUID()
      const intentId = randomUUID()
      ledger.recordIntent({ intentId, runId })
      ledger.markDispatched(runId)
      ledger.markSettled(runId)
      store.close()

      // A brand-new store + ledger over the same directory rebuilds state.
      const revivedStore = new SessionLedgerFileStore(dir)
      const revived = new SessionLedger({ store: revivedStore })
      expect(revived.describe()).toEqual({ runs: 1, events: 3, lastSeq: 3 })
      expect(revived.runState(runId)).toBe('settled')
      // Fence survives real persistence: replaying the intent is a duplicate.
      expect(revived.recordIntent({ intentId, runId }).status).toBe('duplicate')
      revivedStore.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('compacts to an atomic checkpoint, preserves dedup, and reports stale cursors', () => {
    const dir = privateDir()
    const intentId = randomUUID()
    const runId = randomUUID()
    try {
      const store = new SessionLedgerFileStore(dir)
      const ledger = new SessionLedger({ store, maxEvents: 4, pageSize: 1 })
      ledger.recordIntent({ intentId, runId, detail: 'route' })
      ledger.markDispatched(runId)
      ledger.markProgress(runId, 'one')
      ledger.markProgress(runId, 'two')
      ledger.markProgress(runId, 'three')
      expect(ledger.describe()).toEqual({ runs: 1, events: 5, lastSeq: 5 })
      expect(ledger.since(0)).toMatchObject({ cursor: 3, reset: { requested: 0, availableFrom: 2 }, events: [{ seq: 3 }] })
      expect(ledger.since(2).events[0]?.seq).toBe(3)
      expect(statSync(join(dir, 'session-ledger.snapshot.json')).mode & 0o777).toBe(0o600)
      store.close()

      const revivedStore = new SessionLedgerFileStore(dir)
      const revived = new SessionLedger({ store: revivedStore, maxEvents: 4, pageSize: 1 })
      expect(revived.runState(runId)).toBe('dispatched')
      expect(revived.recordIntent({ intentId, runId, detail: 'route' }).status).toBe('duplicate')
      expectCode(() => revived.recordIntent({ intentId, runId, detail: 'changed' }), 'intent_payload_conflict')
      revived.markSettled(runId)
      revivedStore.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ignores a pre-checkpoint log prefix left by a compaction crash window', () => {
    const dir = privateDir()
    const intentId = randomUUID()
    const runId = randomUUID()
    try {
      const store = new SessionLedgerFileStore(dir)
      const ledger = new SessionLedger({ store, maxEvents: 3, pageSize: 1 })
      const original = [
        ledger.recordIntent({ intentId, runId, detail: 'route' }).event,
        ledger.markDispatched(runId),
        ledger.markProgress(runId, 'one')
      ]
      ledger.markProgress(runId, 'after-checkpoint')
      store.close()
      const tail = readFileSync(join(dir, 'session-ledger.log'), 'utf8')
      writeFileSync(join(dir, 'session-ledger.log'), original.map((event) => JSON.stringify(event)).join('\n') + '\n' + tail, { mode: 0o600 })

      const revivedStore = new SessionLedgerFileStore(dir)
      const revived = new SessionLedger({ store: revivedStore, maxEvents: 3, pageSize: 1 })
      expect(revived.describe()).toEqual({ runs: 1, events: 4, lastSeq: 4 })
      expect(revived.runState(runId)).toBe('dispatched')
      revivedStore.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('durably truncates a torn tail before the next append', () => {
    const dir = privateDir()
    let revivedStore: SessionLedgerFileStore | undefined
    try {
      const store = new SessionLedgerFileStore(dir)
      const runId = randomUUID()
      new SessionLedger({ store }).recordIntent({ intentId: randomUUID(), runId })
      store.close()
      // Simulate a crash mid-append: a partial line with no trailing newline.
      appendFileSync(join(dir, 'session-ledger.log'), '{"seq":2,"at":1,"ru')
      revivedStore = new SessionLedgerFileStore(dir)
      const revived = new SessionLedger({ store: revivedStore })
      expect(revived.describe()).toEqual({ runs: 1, events: 1, lastSeq: 1 })
      expect(revived.runState(runId)).toBe('recorded')
      // Recovery must repair the file itself. A later valid append and another
      // restart must stay readable rather than concatenate onto the fragment.
      revived.markDispatched(runId)
      revivedStore.close()
      revivedStore = undefined
      revivedStore = new SessionLedgerFileStore(dir)
      const restarted = new SessionLedger({ store: revivedStore })
      expect(restarted.runState(runId)).toBe('dispatched')
      expect(restarted.describe()).toEqual({ runs: 1, events: 2, lastSeq: 2 })
    } finally { revivedStore?.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails closed on a corrupt non-final line and on a non-private directory', () => {
    const dir = privateDir()
    try {
      // A complete but non-parseable middle line is real corruption.
      writeFileSync(join(dir, 'session-ledger.log'), 'not-json\n{"seq":2}\n', { mode: 0o600 })
      expect(() => new SessionLedgerFileStore(dir).loadAll()).toThrow('ledger_file_corrupt')
    } finally { rmSync(dir, { recursive: true, force: true }) }

    const open = mkdtempSync(join(tmpdir(), 'scry-ledger-open-'))
    chmodSync(open, 0o755)
    try { expect(() => new SessionLedgerFileStore(open)).toThrow('ledger_directory_not_private') }
    finally { rmSync(open, { recursive: true, force: true }) }
  })

  it('never allows two live leases on the same directory', () => {
    const dir = privateDir()
    let first: SessionLedgerFileStore | undefined
    try {
      first = new SessionLedgerFileStore(dir)
      expect(() => new SessionLedgerFileStore(dir)).toThrow()
    } finally { first?.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an append before it makes the ledger unreadable on restart', () => {
    const dir = privateDir()
    let store: SessionLedgerFileStore | undefined
    try {
      store = new SessionLedgerFileStore(dir)
      const path = join(dir, 'session-ledger.log')
      writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 - 8), { mode: 0o600 })
      const before = statSync(path).size
      expect(() => store!.append({ seq: 1, at: 1, runId: randomUUID(), kind: 'intent_recorded', intentId: randomUUID() })).toThrow('ledger_file_too_large')
      expect(statSync(path).size).toBe(before)
    } finally { store?.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects use after close', () => {
    const dir = privateDir()
    try {
      const store = new SessionLedgerFileStore(dir)
      store.close()
      expect(() => store.append({ seq: 1, at: 1, runId: randomUUID(), kind: 'intent_recorded', intentId: randomUUID() })).toThrow('ledger_store_closed')
      expect(() => store.loadAll()).toThrow('ledger_store_closed')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
