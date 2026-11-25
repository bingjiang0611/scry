import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SessionLedger } from './session-ledger'
import { RemoteDispatcher } from './remote-dispatcher'
import { MemoryLedgerStore, deferredExecutor, memoryOutbox } from './remote-dispatcher.fixtures'

it('R1: wakes each deferred session at its own deadline', () => {
  vi.useFakeTimers()
  const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
  const { executor, calls } = deferredExecutor()
  const rows = [100, 500].map(delay => ({ effectId: `effect-${delay}`, runId: randomUUID(), delay }))
  for (const { runId } of rows) ledger.recordIntent({ intentId: randomUUID(), runId })
  const start = Date.now()
  const dispatcher = new RemoteDispatcher({ ledger, executor, outbox: memoryOutbox(rows),
    beforeDispatch(runId) {
      const delay = rows.find(row => row.runId === runId)!.delay
      return Date.now() >= start + delay ? { ok: true } :
        { ok: false, action: 'requeue', reason: 'queue_held', retryAfterMs: delay }
    }
  })
  try {
    expect(dispatcher.pump()).toEqual([])
    vi.advanceTimersByTime(100)
    expect(calls).toEqual([rows[0]!.runId])
    vi.advanceTimersByTime(400)
    expect(calls).toEqual(rows.map(row => row.runId))
  } finally {
    dispatcher.dispose()
    vi.useRealTimers()
  }
})
