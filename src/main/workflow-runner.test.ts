import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore } from './workflow-store'
import { WorkflowRunner, WorkflowSlots } from './workflow-runner'
import type { WorkflowPlanPreview } from '../shared/workflow'

const preview: WorkflowPlanPreview = {
  workflowId: 'workflow-runner-test', programRevision: 'revision-test', userGoal: 'test', workspace: '/tmp/workspace',
  orchestrator: { role: 'orchestrator', providerId: 'claude' },
  roles: [
    { role: 'worker', providerId: 'codex', requestedModel: { id: 'codex-fixture' }, actualModelStatus: 'unknown', startIndependentSession: 'available', observeTerminalOutput: 'available', confirmStopConvergence: 'available', state: 'available' },
    { role: 'reviewer', providerId: 'qoder', requestedModel: { id: 'qoder-fixture' }, actualModelStatus: 'unknown', startIndependentSession: 'available', observeTerminalOutput: 'available', confirmStopConvergence: 'available', state: 'available' }
  ],
  program: { schemaVersion: 1, workflowId: 'workflow-runner-test', programRevision: 'revision-test', userGoal: 'test', workspace: '/tmp/workspace',
    roles: [{ role: 'worker', providerId: 'codex', requestedModel: { id: 'codex-fixture' } }, { role: 'reviewer', providerId: 'qoder', requestedModel: { id: 'qoder-fixture' } }],
    body: { kind: 'parallel', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'worker-1', role: 'worker', prompt: 'worker' },
      { kind: 'call', blockId: 'reviewer-1', role: 'reviewer', prompt: 'reviewer' }
    ] }
  }, plannedCalls: 2, state: 'ready', unavailableReasons: [], observedAt: 1
}

describe('WorkflowRunner M0 scheduler', () => {
  it.each([false, true])('fences stop during initialization without racing its own execution record (failure=%s)', async failInitialization => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    class InitializingStore extends MemoryWorkflowStore {
      override async load(id: string) { await barrier; return super.load(id) }
      override async save(record: import('./workflow-store').WorkflowStoreRecord) {
        if (failInitialization) throw new Error('initial storage unavailable')
        await super.save(record)
      }
    }
    const store = new InitializingStore()
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'unexpected', status: 'completed' as const, settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, execute })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    const pending = runner.start(preview, approval)
    const completion = pending.then(value => ({ value }), error => ({ error }))
    const stop = runner.requestStop(preview.workflowId, 'stop-initializing')
    expect(execute).not.toHaveBeenCalled()
    release()
    expect(await stop).toBe(!failInitialization)
    const result = await completion
    if (failInitialization) expect(result).toHaveProperty('error')
    else {
      expect(result).toHaveProperty('value.state', 'stopped')
      expect((await store.load(preview.workflowId))?.stopRequests).toEqual([{ commandId: 'stop-initializing', requestedAt: expect.any(Number) }])
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('shares one slot across providers and records durable intent before dispatch', async () => {
    const store = new MemoryWorkflowStore()
    const starts: string[] = []
    const runner = new WorkflowRunner({
      store, slots: new WorkflowSlots(1),
      execute: (request) => {
        starts.push(request.role.providerId)
        return { result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, output: request.prompt, settled: true }), stop: () => true }
      }
    })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    const result = await runner.start(preview, approval)
    expect(starts).toEqual(['codex', 'qoder'])
    expect(result.attempts).toHaveLength(2)
    expect((await store.load(preview.workflowId))?.intents).toHaveLength(2)
  })

  it('does not release a slot or report success when provider settlement is unknown', async () => {
    const store = new MemoryWorkflowStore()
    const runner = new WorkflowRunner({
      store, slots: new WorkflowSlots(1),
      execute: () => ({ result: Promise.resolve({ runId: 'run-unknown', status: 'unknown' as const, settled: false }), stop: () => true })
    })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    const result = await runner.start(preview, approval)
    expect(result.state).toBe('unknown')
    expect(result.finalReportStatus).toBe('unavailable')
  })
})
