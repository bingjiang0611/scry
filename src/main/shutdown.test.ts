import { describe, expect, it, vi } from 'vitest'
import { enforceShutdownDeadline, settleRunsForShutdown, type ShutdownRunControl } from './shutdown'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('settleRunsForShutdown', () => {
  it('force-kills every managed run when graceful cleanup misses the deadline', async () => {
    const blocked = deferred()
    const forceKill = vi.fn()
    const disposeProviders = vi.fn()
    const outcome = await enforceShutdownDeadline(blocked.promise, [{
      runId: 'run-stuck',
      getExternalSessionId: () => undefined,
      interrupt: vi.fn(),
      forceKill,
      cancelTurnDiff: vi.fn(),
      settled: blocked.promise
    }], disposeProviders, 5)
    expect(outcome).toBe('forced')
    expect(forceKill).toHaveBeenCalledOnce()
    expect(disposeProviders).toHaveBeenCalledOnce()
  })

  it('interrupts immediately even when transcript mirroring is blocked', async () => {
    const mirror = deferred()
    const settled = deferred()
    const interrupt = vi.fn()
    const shutdown = settleRunsForShutdown([{
      runId: 'run-blocked-mirror',
      getExternalSessionId: () => 'session-1',
      interrupt,
      cancelTurnDiff: vi.fn().mockResolvedValue(undefined),
      settled: settled.promise
    }], {
      cancelQuestion: vi.fn(),
      mirror: () => mirror.promise,
      disposeProviders: vi.fn()
    })

    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce())
    mirror.resolve()
    settled.resolve()
    await shutdown
  })

  it('waits for every terminal pipeline and isolates one run cleanup failure from the others', async () => {
    const first = deferred()
    const second = deferred()
    const cancelSecond = vi.fn().mockResolvedValue(undefined)
    const disposeProviders = vi.fn().mockResolvedValue(undefined)
    const controls: ShutdownRunControl[] = [
      {
        runId: 'run-a',
        getExternalSessionId: () => { throw new Error('getter failed') },
        interrupt: () => { throw new Error('interrupt failed') },
        cancelTurnDiff: async () => { throw new Error('cancel failed') },
        settled: first.promise
      },
      {
        runId: 'run-b',
        resume: 'session-b',
        getExternalSessionId: () => 'native-b',
        interrupt: vi.fn(),
        cancelTurnDiff: cancelSecond,
        settled: second.promise
      }
    ]
    let completed = false
    const shutdown = settleRunsForShutdown(controls, {
      cancelQuestion: vi.fn(),
      mirror: vi.fn(),
      disposeProviders
    }).then(() => { completed = true })

    await vi.waitFor(() => expect(cancelSecond).toHaveBeenCalledOnce())
    expect(disposeProviders).toHaveBeenCalledOnce()
    first.resolve()
    await Promise.resolve()
    expect(completed).toBe(false)
    second.resolve()
    await shutdown
    expect(completed).toBe(true)
  })
})
