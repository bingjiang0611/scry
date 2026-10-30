import { describe, expect, it } from 'vitest'
import type { RunTraceResyncResult } from '@shared/run-traces'
import { event, healthy, run, sessionFixture, tick } from './run-trace-stream-session.fixtures'

describe('run trace stream teardown and re-alignment', () => {
  it('never resurrects a settled run with an older running snapshot, and never confirms it', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    h.emit({
      kind: 'terminal', subscriptionId: 'sub-main-1', generation: 0,
      run: run('run-main', [event('run-main', 'snapshot-1'), event('run-main', 'turn-diff')], { done: true }),
      health: healthy
    })
    expect(h.states.at(-1)?.run?.done).toBe(true)
    // main 交回一份「还在运行」的旧快照：终态不能被盖回去。
    h.resyncResult.value = Promise.resolve({
      status: 'ok',
      run: run('run-main', [event('run-main', 'older')]),
      resyncId: 1,
      health: { ...healthy, generation: 1 }
    })
    h.emit({
      kind: 'health', subscriptionId: 'sub-main-1', generation: 0,
      health: { ...healthy, degraded: true, skippedEvents: 1, resyncRequired: true }
    })
    await tick()
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.done).toBe(true)
    expect(h.states.at(-1)?.run?.items.map((item) => item.id)).not.toContain('older')
    // 没有采纳这份快照就不能确认：否则等于宣布自己已经对齐了。
    expect(h.confirmed).toEqual([])
  })

  it('serializes re-alignment: a second health event waits instead of stacking requests', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    let settle = (_value: RunTraceResyncResult): void => undefined
    h.resyncResult.value = new Promise<RunTraceResyncResult>((resolve) => { settle = resolve })
    h.emit({
      kind: 'health', subscriptionId: 'sub-main-1', generation: 0,
      health: { ...healthy, degraded: true, skippedEvents: 1, resyncRequired: true }
    })
    h.emit({
      kind: 'health', subscriptionId: 'sub-main-1', generation: 0,
      health: { ...healthy, degraded: true, skippedEvents: 2, resyncRequired: true }
    })
    await tick()
    expect(h.resyncRequests.count).toBe(1)
    settle({ status: 'ok', run: run('run-main', [event('run-main', 'snapshot-2')]), resyncId: 1, health: { ...healthy, generation: 1 } })
    await tick()
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.items.map((item) => item.id)).toEqual(['snapshot-2'])
    expect(h.confirmed).toEqual([{ subscriptionId: 'sub-main-1', resyncId: 1 }])
  })

  it('ignores a re-alignment reply that arrives after the view went away', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    let settle = (_value: RunTraceResyncResult): void => undefined
    h.resyncResult.value = new Promise<RunTraceResyncResult>((resolve) => { settle = resolve })
    h.emit({
      kind: 'health', subscriptionId: 'sub-main-1', generation: 0,
      health: { ...healthy, degraded: true, skippedEvents: 1, resyncRequired: true }
    })
    await tick()
    h.session.stop()
    const before = h.states.length
    settle({ status: 'ok', run: run('run-main', [event('run-main', 'stale')]), resyncId: 1, health: { ...healthy, generation: 1 } })
    await tick()
    expect(h.states).toHaveLength(before)
    expect(h.confirmed).toEqual([])
  })

  it('unsubscribes and ignores late responses after stop', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    h.session.stop()
    expect(h.unsubscribeCalls).toEqual(['sub-main-1'])
    const before = h.states.length
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [event('run-main', 'late-1')], bytes: 10, generation: 0, batchId: 3 }
    })
    expect(h.session.drain()).toEqual([])
    expect(h.states).toHaveLength(before)
    // 迟到的回执仍然交给 main；由 main 的 generation/batch 台账拦住，不会误清额度。
    await h.port.ack('sub-main-1', { generation: 0, batchId: 3, bytes: 10 })
    expect(h.acks).toEqual([{ subscriptionId: 'sub-main-1', batchId: 3 }])
  })

  it('unsubscribes a subscription that resolved after the view already went away', async () => {
    const h = sessionFixture()
    h.session.start()
    h.session.stop()
    await tick()
    expect(h.unsubscribeCalls).toEqual(['sub-main-1', 'sub-main-1'])
  })
})
