import { describe, expect, it, vi } from 'vitest'
import { dispatchMessage, isDispatchMode, type DispatchDeps } from './dispatch-mode'

function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps & { submit: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async () => ({ runId: 'run-new' }))
  const stop = vi.fn(() => true)
  return {
    submit,
    stop,
    liveRunId: () => 'run-live',
    steer: vi.fn(async () => ({ status: 'accepted' as const })),
    ...overrides
  } as never
}

// D2: the four dispatch modes are one decision, and each one keeps the rule it builds on:
// queue waits, steer uses the run's own evidence, restart never overtakes the run it replaces.

describe('D2: dispatch modes', () => {
  it('accepts only the four modes', () => {
    expect(['immediate', 'queue', 'steer', 'restart'].every(isDispatchMode)).toBe(true)
    expect(isDispatchMode('immediate ')).toBe(false)
    expect(isDispatchMode(undefined)).toBe(false)
  })

  it('immediate submits with the immediate claim', async () => {
    const d = deps()
    await expect(dispatchMessage('immediate', d)).resolves.toEqual({ status: 'submitted', runId: 'run-new', mode: 'immediate' })
    expect(d.submit).toHaveBeenCalledWith('immediate')
  })

  it('queue submits behind the live run', async () => {
    const d = deps()
    await expect(dispatchMessage('queue', d)).resolves.toEqual({ status: 'submitted', runId: 'run-new', mode: 'queue' })
    expect(d.submit).toHaveBeenCalledWith('queued')
  })

  it('steer delivers into the live run and reports its evidence', async () => {
    const d = deps()
    await expect(dispatchMessage('steer', d)).resolves.toEqual({ status: 'steered' })
    expect(d.steer).toHaveBeenCalledWith('run-live')
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('a rejected steer never becomes a new run', async () => {
    const d = deps({ steer: vi.fn(async () => ({ status: 'rejected' as const, message: '已结束' })) })
    await expect(dispatchMessage('steer', d)).resolves.toMatchObject({ status: 'rejected', reason: 'steer_rejected', message: '已结束' })
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('restart stops the live run before it queues the replacement', async () => {
    const order: string[] = []
    const d = deps({
      stop: vi.fn((runId: string) => { order.push(`stop:${runId}`); return true }),
      submit: vi.fn(async (claimMode: string) => { order.push(`submit:${claimMode}`); return { runId: 'run-new' } })
    })
    await expect(dispatchMessage('restart', d)).resolves.toEqual({ status: 'stopped_and_queued', runId: 'run-new', stoppedRunId: 'run-live' })
    expect(order).toEqual(['stop:run-live', 'submit:queued'])
  })

  it('does not queue a replacement when the stop was refused', async () => {
    const d = deps({ stop: vi.fn(() => false) })
    await expect(dispatchMessage('restart', d)).resolves.toMatchObject({ status: 'rejected', reason: 'stop_rejected' })
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('steer and restart need a live run', async () => {
    const d = deps({ liveRunId: () => undefined })
    await expect(dispatchMessage('steer', d)).resolves.toMatchObject({ status: 'rejected', reason: 'no_live_run' })
    await expect(dispatchMessage('restart', d)).resolves.toMatchObject({ status: 'rejected', reason: 'no_live_run' })
  })
})
