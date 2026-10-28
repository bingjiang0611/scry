import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore, type WorkflowPlanningIntent } from './workflow-store'
import { type WorkflowServiceOptions } from './workflow-service'
import { WorkflowDispatch, WorkflowSlots } from './workflow-runner'
import { descriptor, fixture, request, worker } from './workflow-service-fixture'

describe('workflow service planning receipts and dispatch evidence', () => {

  it('persists planner results before releasing shared capacity', async () => {
    let ready!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { ready = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    class DelayedStore extends MemoryWorkflowStore {
      override async savePlanningIntent(intent: WorkflowPlanningIntent) {
        await super.savePlanningIntent(intent)
        if (intent.status === 'running' && intent.result) { ready(); await barrier }
      }
    }
    const slots = new WorkflowSlots(1)
    const { service } = fixture(new DelayedStore(), { slots })
    const pending = service.planCommand(request)
    await entered
    let otherStarted = false
    const other = slots.withSlot(async () => { otherStarted = true }, 'other-root')
    expect(slots.active).toBe(1)
    expect(otherStarted).toBe(false)
    release()
    const preview = await pending
    await other
    expect(otherStarted).toBe(true)
    expect((await service.preview(preview.workflowId)).programRevision).toBe(preview.programRevision)
  })
  it('one command calls the planner once, including duplicate concurrent delivery', async () => {
    const { service, plan } = fixture()
    const [a, b] = await Promise.all([service.planCommand(request), service.planCommand(request)])
    expect(a.workflowId).toBe(b.workflowId)
    expect(plan).toHaveBeenCalledTimes(1)
    await expect(service.planCommand({ ...request, command: '/scry-workflow run different' })).rejects.toThrow('commandId')
  })
  it('a recovered planning receipt never charges for the same command again', async () => {
    const { service, store } = fixture()
    const a = await service.planCommand(request)
    const reopened = fixture(store)
    const b = await reopened.service.planCommand(request)
    expect(b.workflowId).toBe(a.workflowId)
    expect(reopened.plan).not.toHaveBeenCalled()
  })
  it.each(['before', 'after', 'untyped'] as const)('keeps dispatch budget and durable %s-dispatch evidence across restart', async phase => {
    const nativeRun = vi.fn()
    const execute: WorkflowServiceOptions['execute'] = () => {
      const dispatch = new WorkflowDispatch()
      const result = Promise.resolve().then(() => {
        if (phase === 'after') { dispatch.onProviderDispatchAttempt(); nativeRun() }
        // The same admission-looking text must not settle a post-dispatch or untyped rejection.
        throw new Error('Scry 精确记录仍有 1 轮待恢复')
      }).catch(error => { throw phase === 'untyped' ? error : dispatch.rejected(error) })
      return { runId: 'fixture', result, stop: () => true }
    }
    const first = fixture(undefined, { execute })
    const preview = await first.service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await first.service.approve(approval)
    const progress = await first.service.start(preview.workflowId, approval, 'start-proof')
    const notAttempted = phase === 'before'
    expect(nativeRun).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0)
    expect(progress.state).toBe(notAttempted ? 'failed' : 'unknown')
    expect(progress.dispatchAttempts).toBe(1)
    expect(first.slots.active).toBe(notAttempted ? 0 : 1)
    const record = (await first.store.load(preview.workflowId))!
    expect(record.intents).toHaveLength(1)
    expect(record.outcomes[0]).toMatchObject({ state: notAttempted ? 'failed' : 'unknown', settled: notAttempted })
    expect(record.outcomes[0].providerDispatch).toBe(notAttempted ? 'not_attempted' : undefined)
    expect(record.outcomes[0].actualModelStatus).toBe('unknown')
    expect(record.outcomes[0].archiveRef).toBeUndefined()
    const reopened = fixture(first.store)
    expect((await reopened.service.snapshot(preview.workflowId))?.state).toBe(progress.state)
    expect(reopened.slots.active).toBe(notAttempted ? 0 : 1)
    expect((await reopened.service.start(preview.workflowId, approval, 'start-proof')).dispatchAttempts).toBe(1)
    expect(reopened.execute).not.toHaveBeenCalled()
    if (notAttempted) {
      const next = await reopened.service.planCommand({ ...request, commandId: 'next-plan' })
      const nextApproval = { workflowId: next.workflowId, programRevision: next.programRevision, approvedAt: 2 }
      await reopened.service.approve(nextApproval)
      expect((await reopened.service.start(next.workflowId, nextApproval, 'next-start')).state).toBe('completed')
    }
  })
  it('persists a planner refusal before releasing its slot and never replans the receipt', async () => {
    const nativeRun = vi.fn()
    const dispatch = new WorkflowDispatch()
    const first = fixture(undefined, { plan: async () => { throw dispatch.rejected(new Error('admission refused')) } })
    await expect(first.service.planCommand(request)).rejects.toThrow('admission refused')
    const intents: WorkflowPlanningIntent[] = []
    for await (const intent of first.store.planningIntents()) intents.push(intent)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ status: 'failed', scopeSettled: true, providerDispatch: 'not_attempted' })
    expect(first.slots.active).toBe(0)
    expect(() => { dispatch.onProviderDispatchAttempt(); nativeRun() }).toThrow('admission refused')
    expect(nativeRun).not.toHaveBeenCalled()
    const reopened = fixture(first.store)
    expect((await reopened.service.list('/fixture')).unresolvedPlanning).toBe(0)
    expect(reopened.slots.active).toBe(0)
    await expect(reopened.service.planCommand(request)).rejects.toThrow('admission refused')
    expect(reopened.plan).not.toHaveBeenCalled()
  })
  it('retains planner capacity when persisting a proven refusal fails', async () => {
    class RefusalWriteFailure extends MemoryWorkflowStore {
      override async savePlanningIntent(intent: WorkflowPlanningIntent) {
        if (intent.providerDispatch === 'not_attempted') throw new Error('refusal fsync failed')
        await super.savePlanningIntent(intent)
      }
    }
    const dispatch = new WorkflowDispatch()
    const first = fixture(new RefusalWriteFailure(), { plan: async () => { throw dispatch.rejected(new Error('admission refused')) } })
    await expect(first.service.planCommand(request)).rejects.toThrow('refusal fsync failed')
    expect(first.slots.active).toBe(1)
    const reopened = fixture(first.store)
    expect((await reopened.service.list('/fixture')).unresolvedPlanning).toBe(1)
    expect(reopened.slots.active).toBe(1)
    expect(reopened.plan).not.toHaveBeenCalled()
  })
  it('unsettled outcomes retain capacity on EVERY restart, not just first recovery', async () => {
    const { service, store } = fixture()
    const preview = await service.planCommand(request)
    const record = (await store.load(preview.workflowId))!
    record.intents.push({ workflowId: preview.workflowId, programRevision: preview.programRevision, taskId: 'root:scan', attemptId: 'pending-attempt', role: 'worker', providerId: 'pi', createdAt: 1 })
    record.progress.dispatchAttempts = 1
    record.progress.slots = { limit: 256, inUse: 99, queued: 88 }
    await store.save(record)
    const first = fixture(store)
    const recovered = await first.service.snapshot(preview.workflowId)
    expect(recovered?.state).toBe('unknown')
    expect(first.slots.active).toBe(1)
    expect(recovered?.slots).toEqual({ limit: 2, inUse: 1, queued: 0 })
    expect((await first.service.list('/fixture')).records[0].slots).toEqual(recovered?.slots)
    const second = fixture(store)
    expect((await second.service.snapshot(preview.workflowId))?.state).toBe('unknown')
    expect((await second.service.snapshot(preview.workflowId))?.slots).toEqual(recovered?.slots)
    expect(second.slots.active).toBe(1)
    expect(second.execute).not.toHaveBeenCalled()
  })
  it('a completed plan can run a Pi worker and returns only its explicit report', async () => {
    const { service, execute } = fixture()
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: Date.now() }
    await service.approve(approval)
    const result = await service.start(preview.workflowId, approval, 'start-command')
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ role: worker })
    expect(result.finalReport).toBe('final')
    expect(result.state).toBe('completed')
  })
  it('a changed capability refuses dispatch even after a valid preview', async () => {
    let available = true
    const { service, execute } = fixture(undefined, { runControls: async role => ({ descriptor: descriptor(role.providerId), model: available, stop: available, identity: 'fixture-runtime', independentRun: available, terminalOutput: available, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }) })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: Date.now() }
    await service.approve(approval)
    available = false
    await expect(service.start(preview.workflowId, approval)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })
})
