import { describe, expect, it, vi } from 'vitest'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { MemoryWorkflowStore, type WorkflowStoreRecord } from './workflow-store'
import type { WorkflowServiceOptions } from './workflow-service'
import { WorkflowDispatch, type WorkflowProviderExecutionResult } from './workflow-runner'
import { descriptor, fixture, ParentCheckpointStore, request } from './workflow-service-fixture'

describe('workflow service receipts, capabilities and recovery', () => {
  it('retries one proven refusal through the canonical chain and deduplicates concurrent and cold commands', async () => {
    let refused = true
    const execute = vi.fn<WorkflowServiceOptions['execute']>(() => ({ result: refused
      ? Promise.reject(new WorkflowDispatch().rejected(new Error('fixture preflight')))
      : Promise.resolve({ runId: 'retried', status: 'completed', settled: true, output: 'retried output' }), stop: () => true }))
    const f = fixture(undefined, { execute })
    const preview = await f.service.planCommand(request), approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await f.service.approve(approval)
    expect((await f.service.start(preview.workflowId, approval)).state).toBe('failed')
    const before = (await f.store.load(preview.workflowId))!, failed = before.outcomes[0]
    const target = { taskId: failed.taskId, attemptId: failed.attemptId, expectedRevision: before.progress.revision! }
    refused = false
    await f.service.approve(approval)
    const results = await Promise.all([f.service.retry(preview.workflowId, approval, target, 'retry-command'), f.service.retry(preview.workflowId, approval, target, 'retry-command')])
    expect(results.map(result => result.state)).toEqual(['completed', 'completed'])
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await f.store.load(preview.workflowId))?.intents).toHaveLength(2)
    const cold = fixture(f.store)
    expect((await cold.service.retry(preview.workflowId, approval, target, 'retry-command')).dispatchAttempts).toBe(2)
    expect(cold.execute).not.toHaveBeenCalled()
    await expect(cold.service.retry(preview.workflowId, approval, { ...target, attemptId: 'other' }, 'retry-command')).rejects.toThrow()
  })

  it('revalidates the frozen runtime before claiming a retry segment', async () => {
    const f = fixture(undefined, { execute: () => ({ result: Promise.reject(new WorkflowDispatch().rejected(new Error('fixture preflight'))), stop: () => true }) })
    const preview = await f.service.planCommand(request), approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await f.service.approve(approval)
    await f.service.start(preview.workflowId, approval)
    const before = (await f.store.load(preview.workflowId))!, outcome = before.outcomes[0]
    const changed = fixture(f.store, { runControls: async role => ({ descriptor: descriptor(role.providerId), model: true, stop: true, identity: 'changed-runtime', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }) })
    await changed.service.approve(approval)
    await expect(changed.service.retry(preview.workflowId, approval, { taskId: outcome.taskId, attemptId: outcome.attemptId, expectedRevision: before.progress.revision! }, 'retry-changed')).rejects.toThrow()
    expect(await f.store.load(preview.workflowId)).toEqual(before)
    expect(changed.execute).not.toHaveBeenCalled()
  })
  it('returns nothing_to_resume without planning, probing capabilities or creating an empty root', async () => {
    const runControls = vi.fn<WorkflowServiceOptions['runControls']>(), f = fixture(new MemoryWorkflowStore(), { runControls })
    const approval = { workflowId: 'missing-history', programRevision: 'missing-revision', approvedAt: 1 }
    expect(await f.service.resume(approval.workflowId, approval, 'resume-missing')).toEqual({ state: 'nothing_to_resume', progress: null })
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(runControls).not.toHaveBeenCalled()
    expect(await f.store.load(approval.workflowId)).toBeUndefined()
    expect(await f.service.findPreview(approval.workflowId)).toBeUndefined()
  })
  it('does not let a cached missing-history receipt bypass approval identity validation', async () => {
    const f = fixture(), approval = { workflowId: 'missing-history', programRevision: 'missing-revision', approvedAt: 1 }
    await f.service.resume(approval.workflowId, approval, 'resume-missing')
    await expect(f.service.resume(approval.workflowId, { ...approval, workflowId: 'other-history' }, 'resume-missing')).rejects.toThrow('冻结程序已变化')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('does not clear another unknown run or its reserved capacity when missing history is resumed', async () => {
    const f = fixture(new MemoryWorkflowStore(), { execute: () => ({ result: Promise.resolve({ runId: 'unknown-native', status: 'unknown', settled: false }), stop: () => true }) })
    const preview = await f.service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await f.service.approve(approval)
    expect((await f.service.start(preview.workflowId, approval)).state).toBe('unknown')
    const original = await f.store.load(preview.workflowId)
    expect(f.slots.active).toBe(1)
    expect(await f.service.resume('missing-history', { workflowId: 'missing-history', programRevision: 'missing-revision', approvedAt: 1 }, 'resume-missing')).toEqual({ state: 'nothing_to_resume', progress: null })
    expect(await f.store.load(preview.workflowId)).toEqual(original)
    expect(f.slots.active).toBe(1)
    expect(await f.store.load('missing-history')).toBeUndefined()
  })
  it('reconciles a cold unknown attempt only from an exact App terminal receipt before manual restart', async () => {
    const first = fixture(new MemoryWorkflowStore(), { execute: () => ({ result: Promise.resolve({ runId: 'unknown-native', status: 'unknown', settled: false }), stop: () => true }) })
    const preview = await first.service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await first.service.approve(approval)
    expect((await first.service.start(preview.workflowId, approval)).state).toBe('unknown')
    const before = (await first.store.load(preview.workflowId))!, outcome = before.outcomes[0]!
    expect(outcome.settled).toBe(false)
    before.execution!.owner = { pid: 999_999, instanceId: 'closed-owner', state: 'active' }
    await first.store.save(before)

    const restartEvidence = vi.fn<NonNullable<WorkflowServiceOptions['restartEvidence']>>(async input => ({ state: 'settled', attemptId: input.attemptId,
      taskId: input.taskId, runId: `workflow-${input.attemptId}`, settledAt: 2, source: 'app_run_terminal', reason: 'reply_lost' }))
    const cold = fixture(first.store, { restartEvidence })
    const recovered = (await cold.service.snapshot(preview.workflowId))!
    const recoveredOutcome = (await first.store.load(preview.workflowId))!.outcomes.find(value => value.attemptId === outcome.attemptId)!
    expect(recoveredOutcome).toMatchObject({ state: 'unknown', settled: true, error: expect.stringContaining('业务结果仍未知') })
    expect(cold.slots.reserved).toBe(0)

    await cold.service.approve(approval)
    const result = await cold.service.restartStalled(preview.workflowId, approval, {
      taskId: outcome.taskId, attemptId: outcome.attemptId, expectedRevision: recovered.revision!
    }, 'restart-from-terminal-receipt')
    expect(result.state).toBe('completed')
    expect(cold.execute).toHaveBeenCalledOnce()
    expect(restartEvidence).toHaveBeenCalledTimes(2)
  })

  it('continues through the same Service/Runner chain and deduplicates concurrent and cold resume receipts', async () => {
    const store = new ParentCheckpointStore(), first = fixture(store)
    const preview = await first.service.planCommand(request), approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await first.service.approve(approval)
    await expect(first.service.start(preview.workflowId, approval)).rejects.toThrow('checkpoint failure')
    expect(first.execute).toHaveBeenCalledTimes(1)
    store.fail = false
    const second = fixture(store)
    await second.service.approve(approval)
    const results = await Promise.all([second.service.resume(preview.workflowId, approval, 'resume-command'), second.service.resume(preview.workflowId, approval, 'resume-command')])
    expect(results.map(result => result.progress?.state)).toEqual(['completed', 'completed'])
    expect(second.execute).not.toHaveBeenCalled()
    expect((await store.load(preview.workflowId))?.execution?.segments).toHaveLength(2)
    const third = fixture(store)
    expect((await third.service.resume(preview.workflowId, approval, 'resume-command')).progress?.state).toBe('completed')
    expect(third.execute).not.toHaveBeenCalled()
    expect((await store.load(preview.workflowId))?.execution?.segments).toHaveLength(2)
  })

  it('rechecks the frozen runtime after approval and before claiming a continuation', async () => {
    const store = new ParentCheckpointStore(), first = fixture(store)
    const preview = await first.service.planCommand(request), approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await first.service.approve(approval)
    await expect(first.service.start(preview.workflowId, approval)).rejects.toThrow('checkpoint failure')
    store.fail = false
    let identity = 'fixture-runtime'
    const second = fixture(store, { runControls: async role => ({ descriptor: descriptor(role.providerId), model: true, stop: true, identity, independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }) })
    await second.service.approve(approval)
    identity = 'changed-runtime'
    await expect(second.service.resume(preview.workflowId, approval, 'resume-stale-runtime')).rejects.toThrow()
    expect(second.execute).not.toHaveBeenCalled()
    expect((await store.load(preview.workflowId))?.execution?.segments).toHaveLength(1)
  })
  it('observes stop write failures while asynchronous journal enumeration is still pending', async () => {
    let finish!: (result: WorkflowProviderExecutionResult) => void
    let entered!: () => void
    const running = new Promise<void>(resolve => { entered = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    class FailedStopStore extends MemoryWorkflowStore {
      override async save(record: WorkflowStoreRecord) {
        if (record.stopRequests?.length) throw new Error('fixture stop write failed')
        await super.save(record)
      }
      override async *planningIntents() {
        await nextTurn()
        yield* super.planningIntents()
      }
    }
    const { service } = fixture(new FailedStopStore(), { execute: () => { entered(); return { result: terminal, stop: () => true } } })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval).catch(error => error)
    await running
    try {
      expect((await service.prepareForShutdown({ timeoutMs: 200 })).state).toBe('storage_failure')
    } finally {
      finish({ runId: 'fixture', status: 'completed', output: 'done', settled: true })
      await pending
    }
  })

})
