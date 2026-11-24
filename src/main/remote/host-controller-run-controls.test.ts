import { expect, it, vi } from 'vitest'
import { stopRun, type RunControlDeps } from './host-controller-run-controls'

// B1 turned stop into a queued `provider.run.stop` effect. This test pins the other half of that
// contract: whoever queues the effect must also pump, or the stop never reaches the provider and
// the run (plus the session queue behind it) stays live forever.

function deps(overrides: Partial<RunControlDeps>): RunControlDeps {
  return {
    authorizeDevice: () => {},
    isRemoteRun: () => true,
    macRun: () => { throw new Error('not a mac run') },
    interactions: { answer: () => ({ status: 'answered' }) } as never,
    stops: new Map(),
    ledger: { markProgress: () => {} } as never,
    ...overrides
  } as RunControlDeps
}

it('pumps the outbox after a stop is accepted', () => {
  const pump = vi.fn()
  const onRunStop = vi.fn(() => ({ status: 'requested' as const }))
  const orchestration = { onRunStop, isWriteIndeterminate: () => false }
  const result = stopRun(deps({ orchestration: orchestration as never, pump }), 'peer', { runId: 'run-1' })
  expect(result).toEqual({ status: 'requested' })
  expect(onRunStop).toHaveBeenCalledTimes(1)
  expect(pump).toHaveBeenCalledTimes(1)
})

it('does not pump when the stop was not accepted', () => {
  const pump = vi.fn()
  const onRunStop = vi.fn(() => ({ status: 'not_running' as const }))
  stopRun(deps({ orchestration: { onRunStop } as never, pump }), 'peer', { runId: 'run-1' })
  expect(pump).not.toHaveBeenCalled()
})
