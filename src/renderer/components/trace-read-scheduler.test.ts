import { describe, expect, it } from 'vitest'
import { createTraceReadScheduler, type TraceReadEnvironment } from './trace-read-scheduler'
import { TRACE_REFRESH_FLOOR_MS } from './RemoteChatShared'

// A run that reports a burst inside the floor and then goes quiet must not wait
// for the next long-poll window: the skipped batch is read when the floor expires.
function environment(startAt = 0) {
  let now = startAt
  let hidden = false
  let nextHandle = 1
  const timers = new Map<number, { at: number; callback: () => void; repeat?: number }>()
  const env: TraceReadEnvironment = {
    now: () => now,
    isHidden: () => hidden,
    setTimeout: (callback, delay) => { const handle = nextHandle++; timers.set(handle, { at: now + delay, callback }); return handle },
    clearTimeout: (handle) => { timers.delete(handle) }
  }
  const advance = (ms: number): void => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0]
      if (!due) break
      const [handle, timer] = due
      now = timer.at
      if (timer.repeat) timers.set(handle, { ...timer, at: timer.at + timer.repeat })
      else timers.delete(handle)
      timer.callback()
    }
    now = target
  }
  return { env, advance, hide: () => { hidden = true }, show: () => { hidden = false }, timers: () => timers.size }
}

describe('trace read tail edge', () => {
  it('reads a batch skipped inside the floor when the floor expires, without another report', () => {
    const { env, advance } = environment()
    const reads: Array<{ runId: string; at: number }> = []
    const scheduler = createTraceReadScheduler((runId) => { reads.push({ runId, at: env.now() }) }, env)

    expect(scheduler.decide('run-a')).toBe('read-now')
    reads.push({ runId: 'run-a', at: env.now() })
    scheduler.markRead()
    advance(300)
    expect(scheduler.decide('run-a')).toBe('coalesced')
    // The run goes quiet for the full 15 s long-poll window.
    advance(15_000)

    expect(reads).toEqual([{ runId: 'run-a', at: 0 }, { runId: 'run-a', at: TRACE_REFRESH_FLOOR_MS }])
    scheduler.dispose()
  })

  it('reads a followed run on the floor while it is live, not when a poll happens', () => {
    const { env, advance } = environment()
    const reads: number[] = []
    const scheduler = createTraceReadScheduler(() => { reads.push(env.now()) }, env)

    scheduler.setLive('run-mac')
    advance(3_000)

    // First read when the run appears, then one per floor.
    expect(reads).toEqual([0, TRACE_REFRESH_FLOOR_MS, TRACE_REFRESH_FLOOR_MS * 2, TRACE_REFRESH_FLOOR_MS * 3])
    scheduler.setLive(undefined)
    advance(5_000)
    expect(reads).toHaveLength(4)
    scheduler.dispose()
  })

  it('stops when the run leaves the live set and after dispose', () => {
    const { env, advance, timers } = environment()
    let reads = 0
    const scheduler = createTraceReadScheduler(() => { reads += 1 }, env)
    scheduler.setLive('run-mac')
    advance(TRACE_REFRESH_FLOOR_MS)
    expect(reads).toBe(2)
    scheduler.setLive(undefined)
    expect(timers()).toBe(0)
    scheduler.dispose()
    advance(5_000)
    expect(reads).toBe(2)
  })

  it('keeps one read per floor when reports and live ticks overlap', () => {
    const { env, advance } = environment()
    const reads: number[] = []
    const scheduler = createTraceReadScheduler(() => { reads.push(env.now()) }, env)
    scheduler.setLive('run-a')
    for (let elapsed = 0; elapsed < 3_000; elapsed += 100) {
      if (scheduler.decide('run-a') === 'read-now') { reads.push(env.now()); scheduler.markRead() }
      advance(100)
    }
    // One floor check guards both paths: no two reads land closer than a floor.
    expect(reads.map((at, index) => (index === 0 ? at : at - reads[index - 1])))
      .toEqual(expect.arrayContaining([]))
    for (let index = 1; index < reads.length; index += 1) expect(reads[index] - reads[index - 1]).toBeGreaterThanOrEqual(TRACE_REFRESH_FLOOR_MS)
    expect(reads.length).toBeLessThanOrEqual(Math.ceil(3_000 / TRACE_REFRESH_FLOOR_MS) + 1)
    scheduler.dispose()
  })

  it('pauses while the page is hidden and reads on the next report', () => {
    const { env, advance, hide, show } = environment()
    const reads: number[] = []
    const scheduler = createTraceReadScheduler(() => { reads.push(env.now()) }, env)
    scheduler.setLive('run-a')
    hide()
    advance(5_000)
    expect(reads).toEqual([])
    show()
    advance(100)
    expect(scheduler.decide('run-a')).toBe('read-now')
    reads.push(env.now())
    scheduler.markRead()
    expect(reads).toEqual([5_100])
    scheduler.dispose()
  })
})

// A run that is not the one last read is read at once: a session that moves from
// run A to run B must not wait for A's floor to expire.
describe('run identity changes read at once', () => {
  it('reads a different run immediately, even inside the floor', () => {
    const { env } = environment()
    const scheduler = createTraceReadScheduler(() => undefined, env)
    expect(scheduler.decide('run-a')).toBe('read-now')
    scheduler.markRead()
    expect(scheduler.decide('run-a')).toBe('coalesced')
    expect(scheduler.decide('run-b')).toBe('read-now')
    scheduler.dispose()
  })
})

// One read at a time per run: a slow read must not overlap the next tick.
describe('single flight', () => {
  it('does not start a second read while the first is still in flight', async () => {
    const { env, advance } = environment()
    let calls = 0
    let resolve: () => void = () => {}
    const scheduler = createTraceReadScheduler(() => {
      calls += 1
      return new Promise<void>((done) => { resolve = done })
    }, env)
    scheduler.setLive('run-a')
    advance(300)
    expect(calls).toBe(1)
    advance(4_000)
    // Four floors passed while the first read hangs: still one call, one pending request.
    expect(calls).toBe(1)
    resolve()
    await Promise.resolve()
    advance(1_000)
    expect(calls).toBe(2)
    scheduler.dispose()
  })
})
