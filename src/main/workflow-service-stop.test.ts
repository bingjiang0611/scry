import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryWorkflowStore, FileWorkflowStore, type WorkflowPlanningIntent, type WorkflowStoreRecord } from './workflow-store'
import type { WorkflowServiceOptions } from './workflow-service'
import type { WorkflowProviderExecutionResult } from './workflow-runner'
import { descriptor, fixture, output, request, WORKFLOW_MAX_STOP_REQUESTS, WorkflowSlots } from './workflow-service-fixture'


describe('workflow service stop, planning and capacity recovery', () => {
  it('does not treat an in-memory completed planner as settled before its final journal write', async () => {
    let entered!: () => void
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const enteredWrite = new Promise<void>(resolve => { entered = resolve })
    class DelayedFinalStore extends MemoryWorkflowStore {
      override async savePlanningIntent(intent: WorkflowPlanningIntent) {
        if (intent.status === 'completed') { entered(); await barrier }
        await super.savePlanningIntent(intent)
      }
    }
    const store = new DelayedFinalStore()
    const { service } = fixture(store)
    const planning = service.planCommand(request)
    await enteredWrite
    expect((await service.prepareForShutdown({ timeoutMs: 0 })).state).toBe('unconfirmed')
    release()
    await planning
    service.cancelShutdownPreparation()
    expect((await service.prepareForShutdown({ timeoutMs: 10 })).state).toBe('ready')
  })

  it('cancels queued pre-dispatch planning without charging a provider scope', async () => {
    let release!: () => void
    let queued!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const queuedSignal = new Promise<void>(resolve => { queued = resolve })
    class PlanningStore extends MemoryWorkflowStore {
      override async savePlanningIntent(intent: WorkflowPlanningIntent) {
        await super.savePlanningIntent(intent)
        if (intent.status === 'queued') queued()
      }
    }
    const slots = new WorkflowSlots(1)
    void slots.withSlot(() => hold, 'other-root')
    const plan = vi.fn(async () => ({ output }))
    const { service } = fixture(new PlanningStore(), { slots, plan })
    const planning = service.planCommand(request)
    await queuedSignal
    const planningResult = planning.then(() => undefined, error => error)
    const preparation = await service.prepareForShutdown({ timeoutMs: 500, wait: async () => { await Promise.resolve() } })
    expect(preparation).toEqual({ state: 'ready', workflowCount: 1 })
    expect((await planningResult) as Error).toHaveProperty('message', '工作流规划已取消')
    expect(plan).not.toHaveBeenCalled()
    release()
  })

  it('vetoes shutdown for a recovered unknown reservation without refunding it', async () => {
    const store = new MemoryWorkflowStore()
    const preview = structuredClone((await fixture().service.planCommand(request)))
    const record: WorkflowStoreRecord = { preview, executionStarted: 1,
      progress: { workflowId: preview.workflowId, programRevision: preview.programRevision, workspace: preview.workspace, goal: preview.userGoal, state: 'running', attempts: [], dispatchAttempts: 1, revision: 1, slots: { limit: 1, inUse: 1, queued: 0 }, updatedAt: 1 },
      intents: [{ workflowId: preview.workflowId, programRevision: preview.programRevision, taskId: `${preview.workflowId}:scan`, attemptId: 'attempt-1', role: 'worker', providerId: 'pi', createdAt: 1 }], outcomes: [] }
    await store.save(record)
    const reopened = fixture(store)
    const preparation = await reopened.service.prepareForShutdown({ timeoutMs: 0 })
    expect(preparation.state).toBe('unconfirmed')
    expect(reopened.slots.reserved).toBe(1)
    expect((await store.load(preview.workflowId))?.outcomes[0].state).toBe('unknown')
  })

  it('reports storage failure before signalling and remains retryable', async () => {
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    const running = new Promise<void>(resolve => { started = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    class FailingStore extends MemoryWorkflowStore {
      failStop = true
      override async save(record: WorkflowStoreRecord) {
        if (this.failStop && record.stopRequests?.length) throw new Error('shutdown storage unavailable')
        await super.save(record)
      }
    }
    const stop = vi.fn(() => true)
    const store = new FailingStore()
    const { service } = fixture(store, { execute: () => { started(); return { result: terminal, stop } } })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval)
    await running
    const preparation = await service.prepareForShutdown({ timeoutMs: 50 })
    expect(preparation).toMatchObject({ state: 'storage_failure' })
    expect(stop).not.toHaveBeenCalled()
    store.failStop = false
    finish({ runId: 'late', status: 'completed', settled: true })
    await pending
  })
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
    const { service, plan } = fixture(undefined, { runControls: async role => ({ descriptor: descriptor(role.providerId), model: true, stop: false, identity: 'catalog-only', independentRun: false, terminalOutput: false, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }) })
    await expect(service.planCommand(request)).rejects.toThrow()
    expect(plan).not.toHaveBeenCalled()
  })
  it('uses the catalog operation health snapshot and never promotes unknown health', async () => {
    let state: 'unknown' | 'ready' = 'unknown'
    const { service, plan } = fixture(undefined, { runControls: async role => ({
      descriptor: { ...descriptor(role.providerId), health: { state, transport: 'fixture' } },
      model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const
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
})
