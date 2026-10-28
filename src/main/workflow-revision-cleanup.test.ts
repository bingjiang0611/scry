import { stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WorkflowProviderExecutionResult } from './workflow-runner-contracts'
import { approval, call, fixture } from './workflow-revision.fixture'

describe('revision fixture owned-resource closure', () => {
  it.each(['original', 'replacement'] as const)('stops and joins %s execution before deleting checkpoint files', async owner => {
    const f = await fixture(false, false, true, { kind: 'sequence', blockId: 'root', blocks: [call('work'), { kind: 'return', blockId: 'finish', ref: { nodeId: 'work' } }] })
    const controller = owner === 'original' ? f.service : f.makeService()
    if (owner === 'replacement') f.service.close()
    let entered!: () => void, stopped!: () => void, finish!: (result: WorkflowProviderExecutionResult) => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const stopRequested = new Promise<void>(resolve => { stopped = resolve })
    const result = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    f.execute.mockImplementation(() => { entered(); return { result, stop: () => { stopped(); return true } } })
    await controller.approve(approval(f.preview))
    const running = controller.start(f.preview.workflowId, approval(f.preview))
    await ready
    const cleaning = f.cleanup()
    try {
      // No timer/sleep: old cleanup resolves without requesting stop. The real
      // cleanup must instead reach the registered stop while retaining files.
      expect(await Promise.race([stopRequested.then(() => 'stop'), cleaning.then(() => 'deleted')])).toBe('stop')
      expect((await stat(f.directory)).isDirectory()).toBe(true)
      finish({ runId: 'fixture-cleanup', status: 'stopped', settled: true })
      await cleaning
      await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await running).state).toBe('stopped')
    } finally {
      finish({ runId: 'fixture-cleanup', status: 'stopped', settled: true })
      await Promise.allSettled([running, cleaning])
    }
  })
})
