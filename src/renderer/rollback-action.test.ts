import { describe, expect, it } from 'vitest'
import { rollbackDecision, rollbackOutcome } from './rollback-action'
import { ROLLBACK_COPY } from './constants/rollback-copy'

// D5: rollback overwrites a worktree, so the entry refuses with a reason instead of guessing, and a
// call whose outcome is unclear must never be presented as success.
describe('rollbackDecision', () => {
  it('allows a focused run with a checkpoint when the host is available and idle', () => {
    expect(rollbackDecision({ runId: 'r1', hasCheckpoint: true, available: true, busy: false })).toEqual({ allowed: true })
  })

  it.each([
    [{ runId: null, hasCheckpoint: true, available: true, busy: false }, ROLLBACK_COPY.noRun],
    [{ runId: 'r1', hasCheckpoint: false, available: true, busy: false }, ROLLBACK_COPY.noCheckpoint],
    [{ runId: 'r1', hasCheckpoint: true, available: false, busy: false }, ROLLBACK_COPY.unavailable],
    [{ runId: 'r1', hasCheckpoint: true, available: true, busy: true }, ROLLBACK_COPY.working]
  ])('refuses %o with its reason', (context, reason) => {
    expect(rollbackDecision(context)).toEqual({ allowed: false, reason })
  })
})

describe('rollbackOutcome', () => {
  it('reports done only on the host\'s restored status', () => {
    expect(rollbackOutcome({ status: 'restored', ref: 'refs/scry/checkpoints/r1', tree: 'abc' })).toEqual({ status: 'done' })
  })

  it('reports a refusal with the host reason', () => {
    expect(rollbackOutcome({ status: 'unavailable', reason: 'checkpoint_missing' }))
      .toEqual({ status: 'refused', message: ROLLBACK_COPY.refused('checkpoint_missing') })
  })

  it('treats a shapeless answer or a call error as unknown, never as done', () => {
    expect(rollbackOutcome({ error: 'econnreset' }).status).toBe('unknown')
    expect(rollbackOutcome(null).status).toBe('unknown')
    expect(rollbackOutcome({ status: 'restored!' }).status).toBe('unknown')
  })
})
