import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SessionLedger, type LedgerEvent } from './session-ledger'
import { RemoteDispatcher } from './remote-dispatcher'
import { createRemoteRunBinding } from './remote-run-binding'
import { MemoryLedgerStore, deferredExecutor, memoryOutbox } from './remote-dispatcher.fixtures'

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

  it('runs a stop effect through the effect executor instead of the run executor', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, calls } = deferredExecutor()
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    const outbox = memoryOutbox([{ effectId: 'eff-stop', runId, kind: 'provider.run.stop' }])
    const executed: string[] = []
    const dispatcher = new RemoteDispatcher({
      ledger,
      executor,
      outbox,
      effectExecutor: (effect) => {
        executed.push(`${effect.kind}:${effect.runId}`)
        return 'done'
      }
    })

    expect(dispatcher.pump()).toEqual([])
    expect(executed).toEqual([`provider.run.stop:${runId}`])
    expect(calls).toEqual([])
    expect(outbox.settled).toEqual(['claim:eff-stop', 'succeed:eff-stop'])
    // The stop path never marks the run dispatched: only the worker's outcome decides that.
    expect(ledger.runState(runId)).toBe('recorded')
  })

  it('fails an effect kind with no executor so it cannot sit in the queue forever', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor } = deferredExecutor()
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    const outbox = memoryOutbox([{ effectId: 'eff-write', runId, kind: 'conversation.writeback' }])
    const dispatcher = new RemoteDispatcher({ ledger, executor, outbox })

    expect(dispatcher.pump()).toEqual([])
    expect(outbox.settled).toEqual(['claim:eff-write', 'fail:eff-write'])
  })

  it('retries a stop effect whose executor asks for another pass', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor } = deferredExecutor()
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    const outbox = memoryOutbox([{ effectId: 'eff-stop', runId, kind: 'provider.run.stop' }])
    const dispatcher = new RemoteDispatcher({
      ledger,
      executor,
      outbox,
      effectExecutor: () => 'retry'
    })

    dispatcher.pump()
    expect(outbox.settled).toEqual(['claim:eff-stop', 'retry:eff-stop'])
  })

  // R1: a held row used to be the permanent head of the queue, so every other session starved.
  it('R1: a held run does not stop another session from dispatching', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, calls, gates } = deferredExecutor()
    const heldRun = randomUUID()
    const freeRun = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId: heldRun })
    ledger.recordIntent({ intentId: randomUUID(), runId: freeRun })
    const outbox = memoryOutbox([
      { effectId: 'eff-held', runId: heldRun },
      { effectId: 'eff-free', runId: freeRun }
    ])
    const dispatcher = new RemoteDispatcher({
      ledger,
      executor,
      outbox,
      beforeDispatch: (runId) =>
        runId === heldRun ? { ok: false, action: 'requeue', reason: 'queue_held', retryAfterMs: 500 } : { ok: true }
    })

    expect(dispatcher.pump()).toEqual([freeRun])
    expect(calls).toEqual([freeRun])
    // The held row was deferred once, not reclaimed in a loop for every pass.
    expect(outbox.settled.filter((entry) => entry === 'defer:eff-held')).toHaveLength(1)
    expect(outbox.settled).toContain('succeed:eff-free')
    gates.get(freeRun)!.resolve()
    dispatcher.dispose()
  })

  // R5: the outbox row is committed before the submit finishes writing the ledger intent, so a pump in
  // that window used to see "no such ledger run", read it as a fence conflict and drop the intent.
  it('R5: an outbox row whose ledger intent is not written yet is retried, not dropped', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, calls } = deferredExecutor()
    const runId = randomUUID()
    const outbox = memoryOutbox([{ effectId: 'eff-new', runId }])
    const dispatcher = new RemoteDispatcher({ ledger, executor, outbox })

    expect(dispatcher.pump()).toEqual([])
    expect(outbox.settled).toEqual(['claim:eff-new', 'retry:eff-new'])
    expect(calls).toEqual([])
    // The row is still claimable, so the dispatch happens once the intent is durably recorded.
    ledger.recordIntent({ intentId: randomUUID(), runId })
    outbox.rows[0]!.availableAt = undefined
    expect(dispatcher.pump()).toEqual([runId])
    expect(ledger.runState(runId)).toBe('dispatched')
    dispatcher.dispose()
  })

  // R6: the claim happens before `beforeDispatch` runs, so a throw there left the row `running` under a
  // lease that no settle path knew about. The intent was never dispatched and never failed either.
  it('R6: a throwing beforeDispatch returns the row instead of leaking its lease', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor, calls } = deferredExecutor()
    const runId = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId })
    const outbox = memoryOutbox([{ effectId: 'eff-boom', runId }])
    const dispatcher = new RemoteDispatcher({
      ledger,
      executor,
      outbox,
      beforeDispatch: () => { throw new Error('authority_unavailable') }
    })

    expect(dispatcher.pump()).toEqual([])
    expect(outbox.settled).toEqual(['claim:eff-boom', 'retry:eff-boom'])
    expect(calls).toEqual([])
    expect(ledger.runState(runId)).toBe('recorded')
    dispatcher.dispose()
  })

  it('never scans the in-memory intent list once a durable outbox is wired', () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const { executor } = deferredExecutor()
    const outbox = memoryOutbox([{ effectId: 'eff-1', runId: null }])
    const runId = randomUUID()
    outbox.rows[0]!.runId = runId
    ledger.recordIntent({ intentId: randomUUID(), runId })
    // B1: the dispatch path must not depend on an in-memory scan of recorded intents.
    ;(ledger as unknown as { recordedIntents: () => unknown }).recordedIntents = () => {
      throw new Error('dispatch must not read the in-memory intent list')
    }
    const dispatcher = new RemoteDispatcher({ ledger, executor, outbox })
    expect(dispatcher.pump()).toEqual([runId])
  })
})

// R2: a ledger that refuses the dispatch fence must not be read as "someone else dispatched it".
describe('RemoteDispatcher dispatch fence conflict', () => {
  it('R2: a refused fence with a recorded run records a terminal instead of succeeding', () => {
    const lines: string[] = []
    const ledger = {
      runState: () => 'recorded',
      markDispatched: () => { throw new Error('ledger_refused') },
      intentDetail: () => JSON.stringify({ providerId: 'codex', cwd: '/w', prompt: 'queued' }),
      recordedIntents: () => []
    } as unknown as SessionLedger
    const outbox = memoryOutbox([{ effectId: 'eff-queued', runId: randomUUID() }])
    const dispatcher = new RemoteDispatcher({
      ledger,
      executor: { execute: () => Promise.resolve() },
      outbox,
      onSettled: (runId, lifecycle, detail) => { lines.push(`${runId}:${lifecycle}:${detail}`) }
    })

    expect(dispatcher.pump()).toEqual([])
    expect(outbox.settled).toEqual(['claim:eff-queued', 'fail:eff-queued'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/:failed:dispatch_fence_conflict$/)
  })

  it('R2: a refused fence for a run the ledger already dispatched stays a silent success', () => {
    const ledger = {
      runState: () => 'dispatched',
      markDispatched: () => { throw new Error('already_dispatched') },
      intentDetail: () => JSON.stringify({ providerId: 'codex', cwd: '/w', prompt: 'queued' }),
      recordedIntents: () => []
    } as unknown as SessionLedger
    const outbox = memoryOutbox([{ effectId: 'eff-queued', runId: randomUUID() }])
    const dispatcher = new RemoteDispatcher({ ledger, executor: { execute: () => Promise.resolve() }, outbox })

    expect(dispatcher.pump()).toEqual([])
    expect(outbox.settled).toEqual(['claim:eff-queued', 'succeed:eff-queued'])
  })
})

// C4: the restart note belongs to exactly one turn of a session. The dispatcher asks for the rewrite
// before executing, so the executor sees the note once and the next turn does not.
describe('RemoteDispatcher restart note', () => {
  it('rewrites the detail for one turn and leaves the next turn alone', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const seen: (string | undefined)[] = []
    let note: string | undefined = '（宿主重启提示）后台任务已取消'
    const dispatcher = new RemoteDispatcher({
      ledger,
      rewriteDetail: (_runId, detail) => {
        const current = note
        note = undefined
        if (!current || !detail) return detail
        return JSON.stringify({ ...JSON.parse(detail), prompt: `${current}\n\n${JSON.parse(detail).prompt}` })
      },
      executor: {
        execute(input) {
          seen.push(JSON.parse(input.detail ?? '{}').prompt)
          return Promise.resolve()
        }
      }
    })
    const detail = JSON.stringify({ providerId: 'codex', cwd: '/w', prompt: '继续修测试' })
    const first = randomUUID()
    const second = randomUUID()
    ledger.recordIntent({ intentId: randomUUID(), runId: first, detail })
    dispatcher.pump()
    await dispatcher.idle()
    ledger.recordIntent({ intentId: randomUUID(), runId: second, detail })
    dispatcher.pump()
    await dispatcher.idle()

    expect(seen[0]).toBe('（宿主重启提示）后台任务已取消\n\n继续修测试')
    expect(seen[1]).toBe('继续修测试')
  })

  it('dispatches unchanged when the rewrite throws', async () => {
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const seen: (string | undefined)[] = []
    const dispatcher = new RemoteDispatcher({
      ledger,
      rewriteDetail: () => { throw new Error('note unavailable') },
      executor: { execute: (input) => { seen.push(input.detail); return Promise.resolve() } }
    })
    const runId = randomUUID()
    const detail = JSON.stringify({ providerId: 'codex', cwd: '/w', prompt: 'tasks' })
    ledger.recordIntent({ intentId: randomUUID(), runId, detail })
    dispatcher.pump()
    await dispatcher.idle()
    expect(seen).toEqual([detail])
    expect(ledger.runState(runId)).toBe('settled')
  })
})
