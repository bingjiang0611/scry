import { describe, expect, it, vi } from 'vitest'
import { checkpointLocalOps } from './checkpoints'

const ops = (rollback: (input: unknown) => unknown) =>
  checkpointLocalOps({ checkpoints: { rollback } } as never)['agent:rollbackRun']

// D5: the op only validates the request; the service decides which worktrees may be reset.

describe('checkpoint rollback op', () => {
  it('forwards a run id and reason', async () => {
    const rollback = vi.fn(async () => ({ status: 'restored', ref: 'r', tree: 't' }))
    const result = await ops(rollback)({ runId: 'run-1', reason: 'user' }) as { status: string }
    expect(result.status).toBe('restored')
    expect(rollback).toHaveBeenCalledWith({ runId: 'run-1', reason: 'user' })
  })

  it('refuses an id that could name another ref or a missing service', async () => {
    const rollback = vi.fn()
    await expect(ops(rollback)({ runId: '../heads/main' })).rejects.toThrow('invalid_run_id')
    await expect(ops(rollback)({})).rejects.toThrow('invalid_run_id')
    await expect(checkpointLocalOps({} as never)['agent:rollbackRun']({ runId: 'run-1' }))
      .rejects.toThrow('checkpoint_unavailable')
    expect(rollback).not.toHaveBeenCalled()
  })
})
