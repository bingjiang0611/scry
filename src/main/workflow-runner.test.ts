import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore } from './workflow-store'
import { WorkflowRunner, WorkflowSlots, type WorkflowProviderExecutionRequest } from './workflow-runner'
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

  it('does not advance a sequence or publish a final report after a blocked call', async () => {
    const store = new MemoryWorkflowStore()
    const plan = structuredClone(preview)
    plan.program.body = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'blocked-worker', role: 'worker', prompt: 'worker' },
      { kind: 'call', blockId: 'must-not-dispatch', role: 'reviewer', prompt: 'reviewer' },
      { kind: 'return', blockId: 'final', ref: { nodeId: 'must-not-dispatch' } }
    ] }
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => ({
      result: Promise.resolve({ runId: request.attemptId,
        status: request.taskId.endsWith(':blocked-worker') ? 'blocked' as const : 'completed' as const,
        output: 'must not become a final report after the blocked predecessor', settled: true }),
      stop: () => true
    }))
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store, slots, execute })
    const approval = { workflowId: plan.workflowId, programRevision: plan.programRevision, approvedAt: 1 }
    runner.approve(plan, approval)
    const result = await runner.start(plan, approval)
    expect(result.state).toBe('blocked')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.dispatchAttempts).toBe(1)
    expect(result.finalReportStatus).toBe('unavailable')
    expect(result.finalReport).toBeUndefined()
    const saved = await store.load(plan.workflowId)
    expect(saved?.intents).toHaveLength(1)
    expect(saved?.outcomes).toHaveLength(1)
    expect(saved?.outcomes[0]).toMatchObject({ nodeId: 'blocked-worker', state: 'blocked', settled: true })
    expect(slots.active).toBe(0)
  })

  it.each([
    { output: '{"accepted":false}', state: 'completed', calls: 2 },
    { output: '{}', state: 'failed', calls: 1 },
    { output: '{"accepted":"false"}', state: 'failed', calls: 1 },
    { output: '{"accepted":false,"extra":true}', state: 'failed', calls: 1 },
    { output: '```json\n{"accepted":false}\n```', state: 'failed', calls: 1 },
    { output: undefined, state: 'failed', calls: 1 }
  ])('requires the frozen output schema before admitting a successor ($output)', async ({ output, state, calls }) => {
    const store = new MemoryWorkflowStore()
    const plan = structuredClone(preview)
    plan.program.body = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'structured', role: 'worker', prompt: 'review',
        outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] } },
      { kind: 'call', blockId: 'summary', role: 'reviewer', prompt: 'summarize', inputRefs: [{ nodeId: 'structured' }] },
      { kind: 'return', blockId: 'final', ref: { nodeId: 'summary' } }
    ] }
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => ({
      result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const,
        output: request.taskId.endsWith(':structured') ? output : 'verified summary', settled: true }),
      stop: () => true
    }))
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store, slots, execute })
    const approval = { workflowId: plan.workflowId, programRevision: plan.programRevision, approvedAt: 1 }
    runner.approve(plan, approval)
    const result = await runner.start(plan, approval)
    expect(result.state).toBe(state)
    expect(execute).toHaveBeenCalledTimes(calls)
    expect(result.dispatchAttempts).toBe(calls)
    expect(slots.active).toBe(0)
    expect(execute.mock.calls[0][0].prompt).toContain('"required":["accepted"]')
    const saved = await store.load(plan.workflowId)
    if (state === 'completed') {
      expect(execute.mock.calls[1][0].prompt).toContain('{"accepted":false}')
      expect(result.finalReport).toBe('verified summary')
    } else {
      expect(result.finalReportStatus).toBe('unavailable')
      expect(saved?.outcomes[0]).toMatchObject({ state: 'failed', settled: true })
      expect(saved?.outcomes[0].error).toBeTruthy()
      expect(saved?.outcomes[0].output).toBe(output)
      expect(saved?.intents).toHaveLength(1)
    }
  })

  it('does not turn an output-contract failure into proof of physical settlement', async () => {
    const store = new MemoryWorkflowStore()
    const plan = structuredClone(preview)
    plan.program.body = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'structured', role: 'worker', prompt: 'review', outputSchema: { type: 'boolean' } },
      { kind: 'return', blockId: 'final', ref: { nodeId: 'structured' } }
    ] }
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store, slots, execute: () => ({
      result: Promise.resolve({ runId: 'unsettled', status: 'completed', output: 'not JSON', settled: false }),
      stop: () => true
    }) })
    const approval = { workflowId: plan.workflowId, programRevision: plan.programRevision, approvedAt: 1 }
    runner.approve(plan, approval)
    const result = await runner.start(plan, approval)
    expect(result.state).toBe('unknown')
    expect(result.attempts[0]).toMatchObject({ state: 'failed', settled: false })
    expect(slots.active).toBe(1)
    expect(result.finalReportStatus).toBe('unavailable')
  })

  it('publishes bounded live evidence through the canonical attempt observer without persisting it', async () => {
    const store = new MemoryWorkflowStore()
    const plan = structuredClone(preview)
    plan.program.roles.forEach(role => { role.providerId = 'pi' })
    let publish!: (snapshot: import('../shared/workflow').WorkflowProgress) => void
    let finish!: (result: import('./workflow-runner').WorkflowProviderExecutionResult) => void
    const observed = new Promise<import('../shared/workflow').WorkflowProgress>(resolve => { publish = resolve })
    const terminal = new Promise<import('./workflow-runner').WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    const runner = new WorkflowRunner({
      store,
      execute: request => {
        request.onObservation?.({ source: 'pi_native', kind: 'tool_started', toolCallId: 'same-id' })
        request.onObservation?.({ source: 'pi_native', kind: 'model_progress', channel: 'text' })
        return { result: terminal, stop: () => true }
      },
      onProgress: snapshot => {
        if (snapshot.live?.attempts.some(attempt => attempt.activeToolIds.includes('same-id') && attempt.modelProgressCount === 1)) publish(snapshot)
      }
    })
    const approval = { workflowId: plan.workflowId, programRevision: plan.programRevision, approvedAt: 1 }
    runner.approve(plan, approval)
    const pending = runner.start(plan, approval)
    try {
      const snapshot = await observed
      expect(snapshot.live).toMatchObject({ coverage: 'partial', automaticStall: 'unsupported' })
      expect(snapshot.live?.attempts[0]).toMatchObject({ runId: expect.stringContaining('workflow-'), modelProgressCount: 1 })
      expect((await store.load(plan.workflowId))?.progress.live).toBeUndefined()
    } finally {
      finish({ runId: 'fixture', status: 'completed', output: 'done', settled: true })
      await pending
    }
  })

  it('returns current ephemeral evidence through snapshot, without writing on model deltas', async () => {
    let observe!: NonNullable<import('./workflow-runner').WorkflowProviderExecutionRequest['onObservation']>
    let ready!: () => void
    let finish!: (result: import('./workflow-runner').WorkflowProviderExecutionResult) => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const terminal = new Promise<import('./workflow-runner').WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    const plan = structuredClone(preview)
    plan.program.roles.forEach(role => { role.providerId = 'pi' })
    const store = new MemoryWorkflowStore()
    const writes = vi.spyOn(store, 'save')
    const runner = new WorkflowRunner({ store, slots: new WorkflowSlots(1), execute: request => {
      observe = request.onObservation!
      ready()
      return { result: terminal, stop: () => true }
    } })
    const approval = { workflowId: plan.workflowId, programRevision: plan.programRevision, approvedAt: 1 }
    runner.approve(plan, approval)
    const pending = runner.start(plan, approval)
    await started
    try {
      const count = writes.mock.calls.length
      observe({ source: 'pi_native', kind: 'tool_started', toolCallId: 'live-tool' })
      expect(runner.snapshot(plan.workflowId)?.live?.status).toBe('tool_wait')
      for (let index = 0; index < 1000; index++) observe({ source: 'pi_native', kind: 'model_progress', channel: 'text' })
      expect(writes).toHaveBeenCalledTimes(count)
      expect((await store.load(plan.workflowId))?.progress.live).toBeUndefined()
    } finally {
      runner.stop(plan.workflowId)
      finish({ runId: 'fixture', status: 'stopped', settled: true })
      await pending
    }
  })

  it('closes live observation on proven settlement even while the outcome commit is blocked', async () => {
    let ready!: () => void
    let committing!: () => void
    let release!: () => void
    let finish!: (result: import('./workflow-runner').WorkflowProviderExecutionResult) => void
    let observe!: NonNullable<import('./workflow-runner').WorkflowProviderExecutionRequest['onObservation']>
    const started = new Promise<void>(resolve => { ready = resolve })
    const saving = new Promise<void>(resolve => { committing = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const terminal = new Promise<import('./workflow-runner').WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    class CommitStore extends MemoryWorkflowStore {
      override async save(record: import('./workflow-store').WorkflowStoreRecord) {
        if (record.outcomes.length) { committing(); await barrier }
        await super.save(record)
      }
    }
    const plan = structuredClone(preview)
    plan.program.roles.forEach(role => { role.providerId = 'pi' })
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store: new CommitStore(), slots, execute: request => {
      observe = request.onObservation!
      ready()
      return { result: terminal, stop: () => true }
    } })
    const approval = { workflowId: plan.workflowId, programRevision: plan.programRevision, approvedAt: 1 }
    runner.approve(plan, approval)
    const pending = runner.start(plan, approval)
    await started
    observe({ source: 'pi_native', kind: 'tool_started', toolCallId: 'finished-tool' })
    runner.stop(plan.workflowId)
    finish({ runId: 'fixture', status: 'stopped', settled: true })
    await saving
    try {
      const snapshot = runner.snapshot(plan.workflowId)!
      expect(snapshot.live).toMatchObject({ status: 'unavailable', attempts: [] })
      observe({ source: 'pi_native', kind: 'model_progress', channel: 'text' })
      expect(runner.snapshot(plan.workflowId)?.live?.revision).toBe(snapshot.live?.revision)
      expect(slots.active).toBe(1)
    } finally {
      release()
      await pending
    }
    expect(slots.active).toBe(0)
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
