import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowPlanningIntent, type WorkflowStoreRecord } from './workflow-store'
import { WORKFLOW_MAX_STOP_REQUESTS } from '../shared/workflow'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowDispatch, WorkflowSlots, type WorkflowProviderExecutionResult } from './workflow-runner'

const role = { role: 'orchestrator' as const, providerId: 'codex' as const }
const worker = { role: 'worker' as const, providerId: 'pi' as const, agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } }
const request = { commandId: 'plan-command', command: '/scry-workflow run inspect', workspace: '/fixture', orchestrator: role, roles: [worker] }
const output = JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'call', blockId: 'scan', role: 'worker', prompt: 'inspect' },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'scan' } }
] } })
function descriptor(id: ProviderId): ProviderDescriptor {
  return { id, label: id, runtimeProvider: id === 'pi' ? 'pi_rpc' : 'codex_cli', transport: 'fixture', available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
}
function fixture(store = new MemoryWorkflowStore(), changes: Partial<WorkflowServiceOptions> = {}) {
  const plan = vi.fn(async () => ({ output }))
  const execute = vi.fn<WorkflowServiceOptions['execute']>(() => ({ result: Promise.resolve({ runId: 'fixture', status: 'completed' as const, output: 'final', archiveRef: 'fixture/archive', settled: true }), stop: () => true }))
  const slots = new WorkflowSlots(2)
  const service = new WorkflowService({ store, slots, providerRegistered: () => true,
    runControls: async role => ({ descriptor: descriptor(role.providerId), model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true }), plan, execute, ...changes })
  return { service, plan, execute, slots, store }
}

describe('workflow service receipts, capabilities and recovery', () => {
  it('commits stop intent before signalling, coalesces duplicate commands, and retains capacity until settlement', async () => {
    let entered!: () => void
    let release!: () => void
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    const saving = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const running = new Promise<void>(resolve => { started = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    class StopStore extends MemoryWorkflowStore {
      override async save(record: WorkflowStoreRecord) {
        if (record.stopRequests?.length === 1) { entered(); await barrier }
        await super.save(record)
      }
    }
    const stop = vi.fn(() => true)
    const { service, store, slots } = fixture(new StopStore(), { execute: () => { started(); return { result: terminal, stop } } })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval, 'start-stop-test')
    await running
    const first = service.stop(preview.workflowId, 'stop-one')
    const duplicate = service.stop(preview.workflowId, 'stop-one')
    try {
      expect(stop).not.toHaveBeenCalled()
      await saving
      expect(stop).not.toHaveBeenCalled()
      expect(slots.active).toBe(1)
      release()
      expect(await Promise.all([first, duplicate])).toEqual([true, true])
      expect(stop).toHaveBeenCalledTimes(1)
      expect((await store.load(preview.workflowId))?.stopRequests).toEqual([{ commandId: 'stop-one', requestedAt: expect.any(Number) }])
      expect((await service.snapshot(preview.workflowId))?.stopRequestedAt).toEqual(expect.any(Number))
      expect(slots.active).toBe(1)
      expect(await service.stop(preview.workflowId, 'stop-two')).toBe(true)
      expect(await service.stop(preview.workflowId, 'stop-one')).toBe(true)
      expect(stop).toHaveBeenCalledTimes(2)
      await expect(service.stop('other-workflow', 'stop-one')).rejects.toThrow('commandId')
    } finally {
      release()
      finish({ runId: 'fixture', status: 'stopped', settled: true })
      await pending
    }
    expect(slots.active).toBe(0)
  })

  it('does not signal or continue dispatch when the stop intent cannot be saved', async () => {
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    const running = new Promise<void>(resolve => { started = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    class StopStore extends MemoryWorkflowStore {
      failStop = true
      override async save(record: WorkflowStoreRecord) {
        if (this.failStop && record.stopRequests?.length) throw new Error('stop storage unavailable')
        await super.save(record)
      }
    }
    const store = new StopStore()
    const stop = vi.fn(() => true)
    const execute = vi.fn<WorkflowServiceOptions['execute']>(() => { started(); return { result: terminal, stop } })
    const plan = async () => ({ output: JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first' },
      { kind: 'call', blockId: 'second', role: 'worker', prompt: 'must not dispatch' },
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'second' } }
    ] } }) })
    const { service, slots } = fixture(store, { plan, execute })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval)
    await running
    try {
      await expect(service.stop(preview.workflowId, 'stop-failed')).rejects.toThrow('stop storage unavailable')
      // Evict the failed volatile receipt using unrelated completed lookups.
      // Its in-memory journal candidate must not become a false durable ACK.
      for (let index = 0; index < 256; index++) expect(await service.stop('missing-workflow', `unrelated-${index}`)).toBe(false)
      await expect(service.stop(preview.workflowId, 'stop-failed')).rejects.toThrow('持久化')
      expect(stop).not.toHaveBeenCalled()
      expect(slots.active).toBe(1)
    } finally {
      store.failStop = false
      finish({ runId: 'fixture', status: 'completed', output: 'late output', settled: true })
      expect((await pending).state).toBe('stopped')
    }
    expect(execute).toHaveBeenCalledTimes(1)
    expect(slots.active).toBe(0)
  })

  it('restores a persisted stop receipt without replaying its signal or clearing unknown capacity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-workflow-stop-receipt-'))
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    const running = new Promise<void>(resolve => { started = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    class StopStore extends FileWorkflowStore {
      failAfterCommit = true
      override async save(record: WorkflowStoreRecord) {
        await super.save(record)
        if (this.failAfterCommit && record.stopRequests?.length) throw new Error('stop commit acknowledgement lost')
      }
    }
    const store = new StopStore(directory)
    const stop = vi.fn(() => true)
    const first = fixture(undefined, { store, execute: () => { started(); return { result: terminal, stop } } })
    const preview = await first.service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await first.service.approve(approval)
    const pending = first.service.start(preview.workflowId, approval)
    await running
    try {
      await expect(first.service.stop(preview.workflowId, 'lost-ack')).rejects.toThrow('acknowledgement lost')
      const reopened = fixture(undefined, { store: new FileWorkflowStore(directory) })
      expect(await reopened.service.stop(preview.workflowId, 'lost-ack')).toBe(true)
      expect(await reopened.service.stop(preview.workflowId, 'fresh-stop')).toBe(false)
      expect((await reopened.service.snapshot(preview.workflowId))?.state).toBe('unknown')
      expect(reopened.slots.active).toBe(1)
      expect(reopened.execute).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
    } finally {
      store.failAfterCommit = false
      finish({ runId: 'fixture', status: 'stopped', settled: true })
      await pending
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('bounds stop receipts without evicting old identities or replaying them after cache eviction', async () => {
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    const running = new Promise<void>(resolve => { started = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    const stop = vi.fn(() => true)
    const { service, store } = fixture(undefined, { execute: () => { started(); return { result: terminal, stop } } })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval)
    await running
    try {
      for (let index = 0; index < WORKFLOW_MAX_STOP_REQUESTS; index++) expect(await service.stop(preview.workflowId, `stop-${index}`)).toBe(true)
      await expect(service.stop(preview.workflowId, 'over-limit')).rejects.toThrow('已达上限')
      expect(await service.stop(preview.workflowId, 'stop-0')).toBe(true)
      expect(stop).toHaveBeenCalledTimes(WORKFLOW_MAX_STOP_REQUESTS)
      expect((await store.load(preview.workflowId))?.stopRequests).toHaveLength(WORKFLOW_MAX_STOP_REQUESTS)
    } finally {
      finish({ runId: 'fixture', status: 'stopped', settled: true })
      await pending
    }
  })

  it('does not invent execution capability from a matching model catalog', async () => {
    const { service, plan } = fixture(undefined, { runControls: async role => ({ descriptor: descriptor(role.providerId), model: true, stop: false, identity: 'catalog-only', independentRun: false, terminalOutput: false }) })
    await expect(service.planCommand(request)).rejects.toThrow()
    expect(plan).not.toHaveBeenCalled()
  })
  it('uses the catalog operation health snapshot and never promotes unknown health', async () => {
    let state: 'unknown' | 'ready' = 'unknown'
    const { service, plan } = fixture(undefined, { runControls: async role => ({
      descriptor: { ...descriptor(role.providerId), health: { state, transport: 'fixture' } },
      model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true
    }) })
    await expect(service.planCommand(request)).rejects.toThrow('准入状态未知')
    expect(plan).not.toHaveBeenCalled()
    state = 'ready'
    const preview = await service.planCommand({ ...request, commandId: 'fresh-health' })
    expect(preview.state).toBe('ready')
    expect(preview.roles.every(role => role.state === 'available')).toBe(true)
    expect(plan).toHaveBeenCalledTimes(1)
  })
  it('queued planning and durably settled planning never become phantom unknown slots on restart', async () => {
    const store = new MemoryWorkflowStore()
    const base = { role: 'orchestrator', providerId: 'codex', workspace: '/fixture', goal: 'inspect', createdAt: 1 }
    await store.savePlanningIntent({ ...base, workflowId: 'queued', status: 'queued' })
    await store.savePlanningIntent({ ...base, workflowId: 'returned', status: 'running', scopeSettled: true, result: { output: 'durable result' } })
    const { service, slots, plan } = fixture(store)
    expect((await service.list('/fixture')).unresolvedPlanning).toBe(0)
    expect(slots.active).toBe(0)
    expect((await store.loadPlanningIntent('queued'))?.status).toBe('stopped')
    expect((await store.loadPlanningIntent('returned'))?.status).toBe('failed')
    expect(plan).not.toHaveBeenCalled()
  })
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
    const { service, execute } = fixture(undefined, { runControls: async role => ({ descriptor: descriptor(role.providerId), model: available, stop: available, identity: 'fixture-runtime', independentRun: available, terminalOutput: available }) })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: Date.now() }
    await service.approve(approval)
    available = false
    await expect(service.start(preview.workflowId, approval)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })
})
