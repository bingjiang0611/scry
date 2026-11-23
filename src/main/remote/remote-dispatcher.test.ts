import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SessionLedger, type LedgerEvent, type LedgerStore } from './session-ledger'
import { RemoteDispatcher, type RemoteExecutor, type RemoteExecutorInput } from './remote-dispatcher'
import { createRemoteRunBinding } from './remote-run-binding'

class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[]
  constructor(seed: LedgerEvent[] = []) { this.log = seed.map((e) => ({ ...e })) }
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return this.log.map((e) => ({ ...e })) }
  append(event: LedgerEvent): void { this.log.push({ ...event }) }
}

// A controllable executor whose completion the test resolves explicitly.
function deferredExecutor() {
  const calls: string[] = []
  const gates = new Map<string, { resolve(): void; reject(e: Error): void; input: RemoteExecutorInput }>()
  const executor: RemoteExecutor = {
    execute(input) {
      calls.push(input.runId)
      return new Promise<void>((resolve, reject) => gates.set(input.runId, { resolve, reject, input }))
    }
  }
  return { executor, calls, gates }
}

const kinds = (ledger: SessionLedger) => ledger.since(0).events.map((e) => e.kind)

describe('RemoteDispatcher', () => {
  it('dispatches a recorded intent exactly once and settles on executor success', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, calls, gates } = deferredExecutor()
    const dispatcher = new RemoteDispatcher({ ledger, executor })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })

    const started = dispatcher.pump()
    expect(started).toEqual([runId])
    expect(ledger.runState(runId)).toBe('dispatched') // durable dispatch precedes side effect
    gates.get(runId)!.input.progress('half way')
    gates.get(runId)!.resolve()
    await dispatcher.idle()

    expect(calls).toEqual([runId]) // exactly one invocation
    expect(kinds(ledger)).toEqual(['intent_recorded', 'run_dispatched', 'run_progress', 'run_settled'])
  })

  it('marks failed with the observed error, never fabricating success', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, gates } = deferredExecutor()
    const dispatcher = new RemoteDispatcher({ ledger, executor })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    dispatcher.pump()
    gates.get(runId)!.reject(new Error('provider exploded'))
    await dispatcher.idle()
    expect(ledger.runState(runId)).toBe('failed')
    const failed = ledger.since(0).events.find((e) => e.kind === 'run_failed')
    expect(failed?.detail).toContain('provider exploded')
  })

  it.each(['cancelled', 'interrupted'] as const)('publishes canonical %s to orchestration and keeps the v2 legacy reply', async (status) => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const start = createRemoteRunBinding({ startAppRun: async () => ({ status, recording: 'committed' }) })
    const onSettled = vi.fn()
    const dispatcher = new RemoteDispatcher({
      ledger, onSettled,
      executor: { execute: input => start({ ...input, routing: { cwd: '/w', providerId: 'codex', prompt: 'task' } }) }
    })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    expect(dispatcher.pump()).toEqual([runId])
    await dispatcher.idle()
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(runId, 'cancelled', undefined)
    expect(ledger.runState(runId)).toBe('settled')
    const events = ledger.since(0).events
    expect(events.at(-1)?.kind).toBe('run_settled')
    expect(JSON.parse(events.at(-2)?.detail ?? '')).toEqual({ event: 'settled', status })
  })

  it('records one durable evidence-gap marker when output persistence fails without failing the run', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, gates } = deferredExecutor()
    const dispatcher = new RemoteDispatcher({
      ledger,
      executor,
      outputSink: { append: () => { throw new Error('disk unavailable') } }
    })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    dispatcher.pump()
    gates.get(runId)!.input.output({ kind: 'output', text: 'first' })
    gates.get(runId)!.input.output({ kind: 'output', text: 'second' })
    gates.get(runId)!.resolve()
    await dispatcher.idle()

    expect(ledger.runState(runId)).toBe('settled')
    expect(ledger.since(0).events.filter((event) => event.detail === 'output_capture_failed')).toHaveLength(1)
  })

  it('invokes the executor only once under concurrent pumps', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, calls, gates } = deferredExecutor()
    const dispatcher = new RemoteDispatcher({ ledger, executor })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    const a = dispatcher.pump()
    const b = dispatcher.pump()
    expect(a.concat(b)).toEqual([runId]) // only one pump dispatched it
    expect(calls).toEqual([runId])
    gates.get(runId)!.resolve()
    await dispatcher.idle()
  })

  it('after a restart dispatches a recorded run but never re-runs a dispatched one', async () => {
    // Seed a persisted log: one recorded (awaiting dispatch) and one already
    // dispatched (its execution was interrupted; ambiguous, must not re-run).
    const recordedRun = randomUUID()
    const dispatchedRun = randomUUID()
    const recordedIntent = randomUUID()
    const dispatchedIntent = randomUUID()
    const log: LedgerEvent[] = [
      { seq: 1, at: 1, runId: dispatchedRun, kind: 'intent_recorded', intentId: dispatchedIntent },
      { seq: 2, at: 2, runId: dispatchedRun, kind: 'run_dispatched' },
      { seq: 3, at: 3, runId: recordedRun, kind: 'intent_recorded', intentId: recordedIntent }
    ]
    const ledger = new SessionLedger({ store: new MemoryLedgerStore(log) })
    const { executor, calls, gates } = deferredExecutor()
    const dispatcher = new RemoteDispatcher({ ledger, executor })

    const started = dispatcher.pump()
    expect(started).toEqual([recordedRun])
    expect(calls).toEqual([recordedRun]) // the interrupted dispatched run is left alone
    expect(ledger.runState(dispatchedRun)).toBe('dispatched')
    gates.get(recordedRun)!.resolve()
    await dispatcher.idle()
    expect(ledger.runState(recordedRun)).toBe('settled')
  })

  it('does not clobber a run the host cancelled during execution', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, gates } = deferredExecutor()
    const dispatcher = new RemoteDispatcher({ ledger, executor })
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    dispatcher.pump()
    ledger.markCancelled(runId) // trusted host cancels mid-flight
    gates.get(runId)!.resolve() // executor later reports success
    await dispatcher.idle()
    expect(ledger.runState(runId)).toBe('cancelled') // settle is refused, not forced
  })
})

// B1: dispatch order and attempts come from the durable outbox, not from scanning every intent.
function memoryOutbox(seed: Array<{ effectId: string; runId: string | null; kind?: string; expiresAt?: number }>) {
  const rows = seed.map((row) => ({
    effectId: row.effectId,
    kind: row.kind ?? 'provider.run.start',
    runId: row.runId,
    payload: JSON.stringify({ runId: row.runId }),
    attempts: 0,
    state: 'pending' as 'pending' | 'done' | 'failed' | 'voided',
    expiresAt: row.expiresAt
  }))
  const settled: string[] = []
  return {
    rows,
    settled,
    claim(owner: string, now: number) {
      void owner
      const expired = rows.filter((r) => r.state === 'pending' && r.expiresAt !== undefined && r.expiresAt <= now)
      for (const row of expired) row.state = 'voided'
      const row = rows.find((r) => r.state === 'pending' && (r.expiresAt === undefined || r.expiresAt > now))
      if (!row) return { expired: expired.map((r) => ({ effectId: r.effectId, runId: r.runId })) }
      row.state = 'done'
      row.attempts += 1
      settled.push(`claim:${row.effectId}`)
      return {
        expired: expired.map((r) => ({ effectId: r.effectId, runId: r.runId })),
        effect: { effectId: row.effectId, kind: row.kind, runId: row.runId, payload: row.payload, attempts: row.attempts }
      }
    },
    succeed(effectId: string) {
      settled.push(`succeed:${effectId}`)
      return true
    },
    fail(effectId: string) {
      settled.push(`fail:${effectId}`)
      return true
    },
    retry(effectId: string) {
      settled.push(`retry:${effectId}`)
      return { status: 'retry' as const, delayMs: 100 }
    },
    defer(effectId: string) {
      settled.push(`defer:${effectId}`)
      return true
    }
  }
}

describe('RemoteDispatcher outbox-driven dispatch (B1)', () => {
  it('claims only the durable outbox row and settles it once dispatched', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, calls, gates } = deferredExecutor()
    const outbox = memoryOutbox([{ effectId: 'eff-1', runId: null }])
    const runId = randomUUID()
    outbox.rows[0]!.runId = runId
    ledger.recordIntent({ intentId: randomUUID(), runId })
    const dispatcher = new RemoteDispatcher({ ledger, executor, outbox })

    expect(dispatcher.pump()).toEqual([runId])
    expect(ledger.runState(runId)).toBe('dispatched')
    expect(outbox.settled).toEqual(['claim:eff-1', 'succeed:eff-1'])
    // A second pump cannot claim the same effect again.
    expect(dispatcher.pump()).toEqual([])
    gates.get(runId)!.resolve()
    await dispatcher.idle()
    expect(calls).toEqual([runId])
    expect(ledger.runState(runId)).toBe('settled')
  })

  it('cancels the run whose effect expired instead of dropping it silently', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor } = deferredExecutor()
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    const outbox = memoryOutbox([{ effectId: 'eff-expired', runId, expiresAt: Date.now() - 1 }])
    const dispatcher = new RemoteDispatcher({ ledger, executor, outbox })

    expect(dispatcher.pump()).toEqual([])
    expect(ledger.runState(runId)).toBe('cancelled')
  })

  it('parks a run-start effect that has no run instead of leaking a lease', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor } = deferredExecutor()
    const outbox = memoryOutbox([{ effectId: 'eff-orpan', runId: null }])
    const dispatcher = new RemoteDispatcher({ ledger, executor, outbox })

    expect(dispatcher.pump()).toEqual([])
    expect(outbox.settled).toEqual(['claim:eff-orpan', 'fail:eff-orpan'])
  })
})
