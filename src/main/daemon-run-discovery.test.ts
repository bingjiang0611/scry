import { describe, expect, it, vi } from 'vitest'
import { DaemonRunDiscovery } from './daemon-run-discovery'

// P3f E3: a run this window did not start (a phone's, a conversation another window
// sent) appears without the renderer asking. A notice names it; the daemon's live list
// decides whether it belongs on screen, exactly as agent:activeRuns already does.

function setup(live: string[], tracked: string[] = []) {
  const trackedSet = new Set(tracked)
  let release: (() => void) | undefined
  const liveRuns = vi.fn(async () => {
    await new Promise<void>((resolve) => { release = resolve })
    return { runs: live.map((runId) => ({ runId })) }
  })
  const follow = vi.fn(async (input: { runId: string; seq?: number }) => { trackedSet.add(input.runId); return { runId: input.runId, bound: true } })
  const discovery = new DaemonRunDiscovery({ liveRuns, isTracking: (runId) => trackedSet.has(runId), follow })
  return { discovery, liveRuns, follow, answer: () => release?.() }
}

describe('daemon run discovery', () => {
  it('follows a live run it hears of, from where the run starts', async () => {
    const { discovery, liveRuns, follow, answer } = setup(['phone-run'])
    discovery.notice('phone-run', 41)
    answer()
    await vi.waitFor(() => expect(follow).toHaveBeenCalledWith({ runId: 'phone-run', seq: 41 }))
    expect(liveRuns).toHaveBeenCalledTimes(1)
  })

  it('asks the daemon once for a burst of notices, and once more for those that came during the answer', async () => {
    const { discovery, liveRuns, follow, answer } = setup(['a', 'b'])
    discovery.notice('a', 1)
    discovery.notice('a', 1)
    discovery.notice('b', 2)
    expect(liveRuns).toHaveBeenCalledTimes(1)
    answer()
    await vi.waitFor(() => expect(liveRuns).toHaveBeenCalledTimes(2))
    answer()
    await vi.waitFor(() => expect(follow).toHaveBeenCalledTimes(2))
    expect(follow.mock.calls.map(([input]) => input.runId).sort()).toEqual(['a', 'b'])
  })

  it('leaves alone a run that already finished, and one this window already follows', async () => {
    const { discovery, liveRuns, follow, answer } = setup(['live-elsewhere'], ['mine'])
    discovery.notice('mine', 3)
    expect(liveRuns).not.toHaveBeenCalled()
    discovery.notice('finished', 4)
    answer()
    await vi.waitFor(() => expect(follow).toHaveBeenCalledTimes(1))
    // Not named by a notice, but live and on nobody's screen: it belongs there too.
    expect(follow).toHaveBeenCalledWith({ runId: 'live-elsewhere' })
  })

  it('keeps going after a failed check', async () => {
    const warn = vi.fn()
    const follow = vi.fn(async () => ({ runId: 'x', bound: true }))
    const liveRuns = vi.fn()
      .mockRejectedValueOnce(new Error('daemon_not_running'))
      .mockResolvedValueOnce({ runs: [{ runId: 'x' }] })
    const discovery = new DaemonRunDiscovery({ liveRuns, isTracking: () => false, follow, onWarn: warn })
    discovery.notice('x')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    discovery.notice('x')
    await vi.waitFor(() => expect(follow).toHaveBeenCalledWith({ runId: 'x' }))
  })
})
