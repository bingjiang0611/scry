import { describe, expect, it, vi } from 'vitest'
import { settleRunsForShutdown, type ShutdownRunControl } from './shutdown'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('settleRunsForShutdown', () => {
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
