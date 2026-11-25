import { describe, expect, it } from 'vitest'
import { applyStreamBatch, mergeStreamSnapshot, mergeStreamTerminal, planRunTraceStream } from './run-trace-stream'
import { TRACE_LIVE_HEALTHY, TRACE_LIVE_UNAVAILABLE } from './hooks/useAgentSession-helpers'
import { deferSubscribe, delta, event, healthy, run, sessionFixture, tick } from './run-trace-stream-session.fixtures'

describe('run trace stream session', () => {
  it('seeds from the authoritative snapshot and applies deltas on top', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [event('run-main', 'live-1')], bytes: 10, generation: 0, batchId: 0 }
    })
    h.flushAndCommit()
    expect(h.session.drain()).toEqual([])
    const latest = h.states.at(-1)
    expect(latest?.run?.items.map((item) => item.id)).toEqual(['snapshot-1', 'live-1'])
    expect(h.acks).toEqual([{ subscriptionId: 'sub-main-1', batchId: 0 }])
  })

  it('keeps deltas that arrive before the snapshot instead of dropping them', async () => {
    const h = sessionFixture()
    const release = deferSubscribe(h, {
      status: 'subscribed', subscriptionId: 'sub-main-1', run: run('run-main', [event('run-main', 'snapshot-1')]), health: healthy
    })
    h.session.start()
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [event('run-main', 'early-1')], bytes: 10, generation: 0, batchId: 0 }
    })
    expect(h.session.drain()).toEqual([])
    release()
    await tick()
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.items.map((item) => item.id)).toEqual(['snapshot-1', 'early-1'])
    expect(h.acks).toEqual([{ subscriptionId: 'sub-main-1', batchId: 0 }])
  })

  it('acknowledges a batch exactly once, and only after the commit barrier', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [event('run-main', 'live-1')], bytes: 10, generation: 0, batchId: 7 }
    })
    expect(h.acks).toEqual([])
    h.flushAndCommit()
    expect(h.acks).toEqual([{ subscriptionId: 'sub-main-1', batchId: 7 }])
    h.flushAndCommit()
    expect(h.acks).toHaveLength(1)
  })

  it('ignores batches that belong to another subscription', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    h.emit({
      kind: 'trace', subscriptionId: 'sub-other-1', generation: 0,
      batch: { events: [event('run-main', 'foreign-1')], bytes: 10, generation: 0, batchId: 0 }
    })
    h.flushAndCommit()
    expect(h.acks).toEqual([])
    expect(h.states.at(-1)?.run?.items.map((item) => item.id)).toEqual(['snapshot-1'])
  })

  it('reports an unavailable or limited stream honestly instead of pretending to run', async () => {
    for (const status of ['unavailable', 'limit'] as const) {
      const h = sessionFixture()
      h.subscribeResult.value = Promise.resolve({ status })
      h.session.start()
      await tick()
      expect(h.states.at(-1)?.status).toBe(status)
      expect(h.states.at(-1)?.run).toBeUndefined()
      expect(h.terminal).toEqual([null])
    }
  })

  it('flushes the final batch before terminal and keeps the stream readable until the view goes away', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [event('run-main', 'turn-diff')], bytes: 10, generation: 0, batchId: 1 }
    })
    h.emit({
      kind: 'terminal', subscriptionId: 'sub-main-1', generation: 0,
      run: run('run-main', [event('run-main', 'snapshot-1'), event('run-main', 'turn-diff')], { done: true }),
      health: healthy
    })
    expect(h.session.drain()).toEqual([])
    expect(h.unsubscribeCalls).toEqual([])
    expect(h.states.at(-1)?.run?.items.map((item) => item.id)).toEqual(['snapshot-1', 'turn-diff'])
    expect(h.states.at(-1)?.run?.done).toBe(true)
    expect(h.states.at(-1)?.status).toBe('idle')
    expect(h.terminal.map((value) => value?.runId)).toEqual(['run-main'])
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [event('run-main', 'session-diff')], bytes: 10, generation: 0, batchId: 2 }
    })
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.items.map((item) => item.id)).toEqual(['snapshot-1', 'turn-diff', 'session-diff'])
    h.session.stop()
    expect(h.unsubscribeCalls).toEqual(['sub-main-1'])
  })

  it('keeps degradation until the re-aligned snapshot is committed and confirmed', async () => {
    const h = sessionFixture()
    h.resyncResult.value = Promise.resolve({
      status: 'ok',
      run: run('run-main', [event('run-main', 'snapshot-2')]),
      resyncId: 1,
      health: { ...healthy, generation: 1, degraded: true, skippedEvents: 5, resyncRequired: true }
    })
    h.session.start()
    await tick()
    h.emit({
      kind: 'health', subscriptionId: 'sub-main-1', generation: 0,
      health: { ...healthy, degraded: true, skippedEvents: 5, resyncRequired: true }
    })
    await tick()
    expect(h.states.at(-1)?.run?.items.map((item) => item.id)).toEqual(['snapshot-2'])
    expect(h.states.at(-1)?.health).toMatchObject({ degraded: true, skippedEvents: 5 })
    expect(h.confirmed).toEqual([])
    h.flushAndCommit()
    expect(h.confirmed).toEqual([{ subscriptionId: 'sub-main-1', resyncId: 1 }])

    const missing = sessionFixture()
    missing.subscribeResult.value = Promise.resolve({
      status: 'subscribed', subscriptionId: 'sub-main-1', run: run('run-main', []), health: healthy
    })
    missing.resyncResult.value = Promise.resolve({ status: 'missing' })
    missing.session.start()
    await tick()
    missing.emit({
      kind: 'health', subscriptionId: 'sub-main-1', generation: 0,
      health: { ...healthy, degraded: true, skippedEvents: 2, resyncRequired: true }
    })
    await tick()
    expect(missing.states.at(-1)?.health).toMatchObject({ degraded: true, skippedEvents: 2 })
    expect(missing.confirmed).toEqual([])
  })

  it('routes question, closing and stop progress for this run only', async () => {
    const h = sessionFixture()
    h.session.start()
    await tick()
    h.emit({
      kind: 'question', subscriptionId: 'sub-main-1', generation: 0,
      request: { runId: 'run-main', questionId: 'q-1', questions: [] }
    })
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.pendingQuestions?.map((item) => item.questionId)).toEqual(['q-1'])
    h.emit({ kind: 'questionClosed', subscriptionId: 'sub-main-1', generation: 0, runId: 'run-main', questionId: 'q-1' })
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.pendingQuestions).toEqual([])
    const requestedAt = '2026-01-01T00:00:00.000Z'
    h.emit({
      kind: 'stopState', subscriptionId: 'sub-main-1', generation: 0,
      state: {
        runId: 'run-main', providerId: 'claude', runtimeProvider: 'claude_sdk', phase: 'interrupt_requested',
        requestedAt, updatedAt: requestedAt, providerSettled: false, window: { gracefulMs: 1_000, forceKillMs: 2_000 }
      }
    })
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.stopState?.phase).toBe('interrupt_requested')
    h.emit({
      kind: 'question', subscriptionId: 'sub-main-1', generation: 0,
      request: { runId: 'run-child', questionId: 'q-2', questions: [] }
    })
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.pendingQuestions).toEqual([])
  })

  it('replays every scoped event that arrives before the subscribe reply, in arrival order', async () => {
    const h = sessionFixture()
    const release = deferSubscribe(h, {
      status: 'subscribed',
      subscriptionId: 'sub-main-1',
      run: run('run-main', [event('run-main', 'snapshot-1')]),
      health: healthy
    })
    h.session.start()
    const requestedAt = '2026-01-01T00:00:00.000Z'
    h.emit({ kind: 'question', subscriptionId: 'sub-main-1', generation: 0, request: { runId: 'run-main', questionId: 'q-1', questions: [] } })
    h.emit({
      kind: 'stopState', subscriptionId: 'sub-main-1', generation: 0,
      state: {
        runId: 'run-main', providerId: 'claude', runtimeProvider: 'claude_sdk', phase: 'interrupt_requested',
        requestedAt, updatedAt: requestedAt, providerSettled: false, window: { gracefulMs: 1_000, forceKillMs: 2_000 }
      }
    })
    h.emit({ kind: 'questionClosed', subscriptionId: 'sub-main-1', generation: 0, runId: 'run-main', questionId: 'q-1' })
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [event('run-main', 'live-1')], bytes: 10, generation: 0, batchId: 3 }
    })
    h.emit({
      kind: 'terminal', subscriptionId: 'sub-main-1', generation: 0,
      run: run('run-main', [event('run-main', 'snapshot-1'), event('run-main', 'live-1')], { done: true }),
      health: healthy
    })
    expect(h.states.filter((state) => state.status !== 'connecting')).toEqual([])

    release()
    await tick()
    h.flushAndCommit()
    const latest = h.states.at(-1)
    expect(latest?.run?.done).toBe(true)
    expect(latest?.status).toBe('idle')
    expect(latest?.run?.pendingQuestions).toEqual([])
    expect(latest?.run?.stopState?.phase).toBe('interrupt_requested')
    expect(latest?.run?.items.map((item) => item.id)).toEqual(['snapshot-1', 'live-1'])
    expect(h.terminal.map((value) => value?.runId)).toEqual(['run-main'])
    expect(h.acks).toEqual([{ subscriptionId: 'sub-main-1', batchId: 3 }])
  })

  it('does not append a coalesced delta twice when the snapshot already contains it', async () => {
    const h = sessionFixture()
    h.subscribeResult.value = Promise.resolve({
      status: 'subscribed',
      subscriptionId: 'sub-main-1',
      run: run('run-main', [delta('run-main', 'd-1', 'A')]),
      health: healthy
    })
    h.resyncResult.value = Promise.resolve({
      status: 'ok',
      run: run('run-main', [delta('run-main', 'd-1', 'AB')]),
      resyncId: 1,
      health: { ...healthy, generation: 1 }
    })
    h.session.start()
    await tick()
    expect(h.states.at(-1)?.run?.items[0].text).toBe('A')
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 0,
      batch: { events: [delta('run-main', 'd-2', 'B')], bytes: 10, generation: 0, batchId: 0 }
    })
    h.emit({
      kind: 'health', subscriptionId: 'sub-main-1', generation: 0,
      health: { ...healthy, degraded: true, skippedEvents: 1, resyncRequired: true }
    })
    await tick()
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.items[0].text).toBe('AB')
    h.emit({
      kind: 'trace', subscriptionId: 'sub-main-1', generation: 1,
      batch: { events: [delta('run-main', 'd-3', 'C')], bytes: 10, generation: 1, batchId: 1 }
    })
    h.flushAndCommit()
    expect(h.states.at(-1)?.run?.items[0].text).toBe('ABC')
  })
})

describe('run trace stream merging', () => {
  it('keeps local evidence when a later snapshot is a strict prefix', () => {
    const local = run('run-main', [event('run-main', 'a', 'hello'), event('run-main', 'b')])
    const snapshot = run('run-main', [event('run-main', 'a', 'hel')])
    const merged = mergeStreamSnapshot(local, snapshot)
    expect(merged.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(merged.items[0].text).toBe('hello')
  })

  it('does not fabricate a run when a batch arrives without a baseline', () => {
    expect(applyStreamBatch(undefined, [event('run-main', 'a')])).toBeUndefined()
  })

  it('marks a terminal merge as done without dropping late evidence', () => {
    const local = run('run-main', [event('run-main', 'a'), event('run-main', 'diff')])
    const terminal = run('run-main', [event('run-main', 'a')], { done: true })
    const merged = mergeStreamTerminal(local, terminal)
    expect(merged.done).toBe(true)
    expect(merged.items.map((item) => item.id)).toEqual(['a', 'diff'])
  })
})

describe('run trace stream policy', () => {
  it('never asks for a subscription without a visible run', () => {
    expect(planRunTraceStream(undefined, true, true)).toEqual({ kind: 'idle' })
    expect(planRunTraceStream('run-main', false, true)).toEqual({ kind: 'idle' })
    expect(planRunTraceStream('run-main', true, true)).toEqual({ kind: 'connect', runId: 'run-main' })
  })

  it('reports an explicit unavailable stream instead of pretending a missing bridge is healthy', () => {
    expect(planRunTraceStream('run-main', true, false)).toEqual({ kind: 'unavailable' })
    expect(TRACE_LIVE_UNAVAILABLE).toEqual({ degraded: true, skippedEvents: 0 })
  })

  it('keeps the same healthy default as the legacy channel', () => {
    expect(TRACE_LIVE_HEALTHY).toEqual({ degraded: false, skippedEvents: 0 })
  })
})
