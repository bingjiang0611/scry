import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MacRunView } from './host-controller-types'
import { AUTHORIZED, boundController, pairedPeer } from './host-controller-device-fixtures'

// The live-runs long poll wakes on a change or on its fallback tick. A device that
// sends its history query along re-reads that version on every pass, so the tick
// rate is a real per-device cost, not just an internal timer.
const QUERY = { providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'ext-live' }
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) await close()
})

function macSource(runs: MacRunView[]) {
  const listeners = new Set<() => void>()
  return {
    list: () => runs,
    stop: vi.fn((runId: string) => runs.some((run) => run.runId === runId)),
    answer: vi.fn(() => true),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    change(next: MacRunView[]) {
      runs.splice(0, runs.length, ...next)
      for (const listener of [...listeners]) listener()
    }
  }
}

describe('live-runs long poll work per idle window', () => {
  it('reads the joined history version a bounded number of times in a 20 s idle window', async () => {
    vi.useFakeTimers()
    const readHistoryVersion = vi.fn(async () => ({ version: 'v1', readMode: 'indexed' as const }))
    const fixture = await boundController({ readHistoryVersion })
    cleanup.push(fixture.close)
    const { peer } = await pairedPeer(fixture.identity, fixture.controller)
    const first = await fixture.controller.liveRuns(peer, { waitMs: 0, history: { query: QUERY } })
    expect(first.historyVersion?.version).toBe('v1')
    const passesBefore = readHistoryVersion.mock.calls.length

    // One empty window: nothing changes, so every pass is pure re-checking.
    const waiting = fixture.controller.liveRuns(peer, { revision: first.revision, waitMs: 20_000, history: { query: QUERY, known: 'v1' } })
    await vi.advanceTimersByTimeAsync(19_500)
    const passes = readHistoryVersion.mock.calls.length - passesBefore
    // 250 ms would be ~78 passes; a 1 s fallback tick is ~20. The bound keeps the
    // second from silently turning back into the first.
    expect(passes).toBeLessThanOrEqual(25)
    await vi.advanceTimersByTimeAsync(600)
    await expect(waiting).resolves.toMatchObject({ historyVersion: { version: 'v1' } })
  })

  it('wakes a waiting device on a Mac-side change instead of waiting for the tick', async () => {
    const source = macSource([])
    const fixture = await boundController({ macRuns: source })
    cleanup.push(fixture.close)
    const { peer } = await pairedPeer(fixture.identity, fixture.controller)
    const live = await fixture.controller.liveRuns(peer, { waitMs: 0 })
    expect(live.runs).toEqual([])

    const started = Date.now()
    const waiting = fixture.controller.liveRuns(peer, { revision: live.revision, waitMs: 10_000 })
    // A Mac run appears while the device is parked in the long poll.
    source.change([{ runId: 'run-abc123-9', providerId: 'claude', cwd: AUTHORIZED, prompt: 'mac task', questions: [], stopping: false }])
    const woke = await waiting
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(woke.runs.map((run) => [run.origin, run.runId])).toEqual([['mac', 'run-abc123-9']])
    expect(source.subscribe).toHaveBeenCalledTimes(1)
  })

  it('wakes the device when a Mac run binds its native session id', async () => {
    const source = macSource([{ runId: 'run-abc123-7', providerId: 'claude', cwd: AUTHORIZED, prompt: 'mac task', questions: [], stopping: false }])
    const fixture = await boundController({ macRuns: source })
    cleanup.push(fixture.close)
    const { peer } = await pairedPeer(fixture.identity, fixture.controller)
    const live = await fixture.controller.liveRuns(peer, { waitMs: 0 })
    expect(live.runs[0]?.externalSessionId).toBeUndefined()

    const started = Date.now()
    const waiting = fixture.controller.liveRuns(peer, { revision: live.revision, waitMs: 10_000 })
    // The binding the run-session publisher performs: the id appears, then the
    // registry signal fires. Without the signal this waits for the fallback tick.
    source.change([{ runId: 'run-abc123-7', providerId: 'claude', cwd: AUTHORIZED, prompt: 'mac task', externalSessionId: 'native-1', questions: [], stopping: false }])
    const woke = await waiting
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(woke.runs[0]?.externalSessionId).toBe('native-1')
  })
})
