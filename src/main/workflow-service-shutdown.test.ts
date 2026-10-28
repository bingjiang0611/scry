import { describe, expect, it, vi } from 'vitest'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { MemoryWorkflowStore, type WorkflowPlanningIntent } from './workflow-store'
import type { WorkflowServiceOptions } from './workflow-service'
import type { WorkflowProviderExecutionResult } from './workflow-runner'
import { descriptor, fixture, output, request } from './workflow-service-fixture'

describe('workflow service shutdown preparation', () => {

  it('does not signal from an expired preparation while the veto decision remains open', async () => {
    let finish!: (result: WorkflowProviderExecutionResult) => void
    let release!: () => void
    let entered!: () => void
    const running = new Promise<void>(resolve => { entered = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    class SlowHistoryStore extends MemoryWorkflowStore {
      hold = false
      override async listPage(cursor?: string, limit?: number) {
        if (this.hold) await barrier
        return super.listPage(cursor, limit)
      }
    }
    const store = new SlowHistoryStore()
    const stop = vi.fn(() => true)
    const { service } = fixture(store, { execute: () => { entered(); return { result: terminal, stop } } })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval)
    await running
    store.hold = true
    try {
      expect((await service.prepareForShutdown({ timeoutMs: 0 })).state).toBe('unconfirmed')
      release()
      await nextTurn()
      expect(stop).not.toHaveBeenCalled()
    } finally {
      release()
      finish({ runId: 'fixture', status: 'completed', output: 'done', settled: true })
      await pending
    }
  })

  it('coalesces concurrent preparation callers onto the same whole-window deadline', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    class SlowHistoryStore extends MemoryWorkflowStore {
      hold = false
      override async listPage(cursor?: string, limit?: number) {
        if (this.hold) await barrier
        return super.listPage(cursor, limit)
      }
    }
    const store = new SlowHistoryStore()
    const { service } = fixture(store)
    await service.list('/fixture')
    store.hold = true
    const first = service.prepareForShutdown({ timeoutMs: 0 })
    let secondFinished = false
    const second = service.prepareForShutdown({ timeoutMs: 0 }).then(result => { secondFinished = true; return result })
    try {
      expect((await first).state).toBe('unconfirmed')
      await nextTurn()
      expect(secondFinished).toBe(true)
    } finally {
      release()
      await Promise.all([first, second])
    }
  })

  it('allows quit after late proven scope settlement without promoting the unknown business outcome', async () => {
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const { service, slots, store } = fixture(undefined, { execute: () => ({
      result: Promise.resolve({ runId: 'fixture', status: 'unknown', settled: false }), settled, stop: () => true
    }) })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    expect((await service.start(preview.workflowId, approval)).state).toBe('unknown')
    const preparing = service.prepareForShutdown({ timeoutMs: 200 })
    settle()
    expect((await preparing).state).toBe('ready')
    await nextTurn()
    expect(slots.active).toBe(0)
    const record = await store.load(preview.workflowId)
    expect(record?.progress.state).toBe('unknown')
    expect(record?.outcomes).toHaveLength(1)
    expect(record?.outcomes[0].settled).toBe(true)
    expect(record?.progress.dispatchAttempts).toBe(1)
  })

  it('does not acknowledge a planning stop candidate that never reached its journal', async () => {
    let entered!: () => void
    let finish!: (result: { output: string }) => void
    const running = new Promise<void>(resolve => { entered = resolve })
    const terminal = new Promise<{ output: string }>(resolve => { finish = resolve })
    class FailedPlanningStopStore extends MemoryWorkflowStore {
      rejectStop = false
      override async savePlanningIntent(intent: WorkflowPlanningIntent) {
        if (this.rejectStop && intent.stopCommandId) throw new Error('fixture shutdown write rejected')
        await super.savePlanningIntent(intent)
      }
    }
    const store = new FailedPlanningStopStore()
    const { service } = fixture(store, { plan: async () => { entered(); return terminal } })
    const pending = service.planCommand(request).catch(error => error)
    await running
    store.rejectStop = true
    try {
      expect((await service.prepareForShutdown({ timeoutMs: 0 })).state).toBe('storage_failure')
      service.cancelShutdownPreparation()
      expect((await service.prepareForShutdown({ timeoutMs: 0 })).state).toBe('storage_failure')
    } finally {
      store.rejectStop = false
      finish({ output })
      await pending
    }
  })

  it('does not resurrect pre-quit planning admission after returning from a veto', async () => {
    let entered!: () => void
    let release!: () => void
    const loading = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const store = new MemoryWorkflowStore()
    await store.savePlanningIntent({ workflowId: 'old-unknown', role: 'orchestrator', providerId: 'pi', workspace: '/fixture', goal: 'old', createdAt: 1, status: 'unknown' })
    const { service, plan } = fixture(store, { runControls: async role => {
      entered()
      await barrier
      return { descriptor: descriptor(role.providerId), model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }
    } })
    const pending = service.planCommand(request).then(value => ({ value }), error => ({ error }))
    await loading
    try {
      expect((await service.prepareForShutdown({ timeoutMs: 0 })).state).toBe('unconfirmed')
      expect(service.cancelShutdownPreparation()).toBe(true)
    } finally { release() }
    const result = await pending
    expect(plan).not.toHaveBeenCalled()
    expect(result).toHaveProperty('error')
  })

  it('does not let a timed-out quit stop a new separately approved workflow after return', async () => {
    let enteredOld!: () => void
    let enteredNew!: () => void
    let release!: () => void
    let finishOld!: (result: WorkflowProviderExecutionResult) => void
    let finishNew!: (result: WorkflowProviderExecutionResult) => void
    const oldRunning = new Promise<void>(resolve => { enteredOld = resolve })
    const newRunning = new Promise<void>(resolve => { enteredNew = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const oldTerminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finishOld = resolve })
    const newTerminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finishNew = resolve })
    class SlowHistoryStore extends MemoryWorkflowStore {
      hold = false
      override async listPage(cursor?: string, limit?: number) {
        if (this.hold) await barrier
        return super.listPage(cursor, limit)
      }
    }
    const store = new SlowHistoryStore()
    const stopOld = vi.fn(() => true)
    const stopNew = vi.fn(() => true)
    let oldId = ''
    const { service } = fixture(store, { execute: request => {
      if (request.workflowId === oldId) { enteredOld(); return { result: oldTerminal, stop: stopOld } }
      enteredNew()
      return { result: newTerminal, stop: stopNew }
    } })
    const old = await service.planCommand(request)
    oldId = old.workflowId
    const approval = { workflowId: oldId, programRevision: old.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pendingOld = service.start(oldId, approval)
    await oldRunning
    store.hold = true
    expect((await service.prepareForShutdown({ timeoutMs: 0 })).state).toBe('unconfirmed')
    expect(service.cancelShutdownPreparation()).toBe(true)
    const fresh = await service.planCommand({ ...request, commandId: 'fresh-after-veto' })
    const freshApproval = { workflowId: fresh.workflowId, programRevision: fresh.programRevision, approvedAt: 2 }
    await service.approve(freshApproval)
    const pendingNew = service.start(fresh.workflowId, freshApproval)
    await newRunning
    try {
      store.hold = false
      release()
      await nextTurn()
      expect(stopNew).not.toHaveBeenCalled()
    } finally {
      store.hold = false
      release()
      finishOld({ runId: 'old', status: 'stopped', settled: true })
      finishNew({ runId: 'new', status: 'stopped', settled: true })
      await Promise.all([pendingOld, pendingNew])
    }
  })

  it('freezes already-running sequence dispatch synchronously before shutdown journal reads', async () => {
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    let release!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const first = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    class ReadBarrierStore extends MemoryWorkflowStore {
      hold = false
      override async listPage(cursor?: string, limit?: number) {
        if (this.hold) await barrier
        return super.listPage(cursor, limit)
      }
    }
    const store = new ReadBarrierStore()
    let executeCount = 0
    const execute = vi.fn<WorkflowServiceOptions['execute']>(() => {
      executeCount++
      started()
      return { result: executeCount === 1 ? first : Promise.resolve({ runId: 'second', status: 'completed' as const, output: 'second', settled: true }), stop: () => true }
    })
    const plan = async () => ({ output: JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first' },
      { kind: 'call', blockId: 'second', role: 'worker', prompt: 'must not dispatch after quit' },
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'second' } }
    ] } }) })
    const { service } = fixture(store, { execute, plan })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval)
    await running
    store.hold = true
    const preparing = service.prepareForShutdown({ timeoutMs: 0 })
    try {
      finish({ runId: 'first', status: 'completed', output: 'first', settled: true })
      await pending
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      store.hold = false
      release()
      await preparing
    }
  })

  it('does not repeatedly scan historical records while waiting for one native scope', async () => {
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    const running = new Promise<void>(resolve => { started = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    class CountingStore extends MemoryWorkflowStore {
      pages = 0
      override async listPage(cursor?: string, limit?: number) { this.pages++; return super.listPage(cursor, limit) }
    }
    const store = new CountingStore()
    const { service } = fixture(store, { execute: () => { started(); return { result: terminal, stop: () => true } } })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval)
    await running
    const before = store.pages
    let now = 0
    try {
      expect((await service.prepareForShutdown({ timeoutMs: 10, now: () => now, wait: async ms => { now += ms } })).state).toBe('unconfirmed')
      expect(store.pages - before).toBeLessThanOrEqual(1)
    } finally {
      finish({ runId: 'fixture', status: 'stopped', settled: true })
      await pending
    }
  })

  it('prepares a durable shutdown stop and waits for recorded convergence', async () => {
    let started!: () => void
    let finish!: (result: WorkflowProviderExecutionResult) => void
    const running = new Promise<void>(resolve => { started = resolve })
    const terminal = new Promise<WorkflowProviderExecutionResult>(resolve => { finish = resolve })
    const stop = vi.fn(() => { finish({ runId: 'shutdown-run', status: 'stopped', settled: true }); return true })
    const { service, store } = fixture(undefined, { execute: () => { started(); return { result: terminal, stop } } })
    const preview = await service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    const pending = service.start(preview.workflowId, approval)
    await running
    const preparation = await service.prepareForShutdown({ timeoutMs: 500, wait: async () => { await Promise.resolve() } })
    expect(preparation).toEqual({ state: 'ready', workflowCount: 1 })
    expect(stop).toHaveBeenCalledTimes(1)
    expect((await store.load(preview.workflowId))?.stopRequests).toEqual([{ commandId: expect.stringMatching(/^shutdown-[a-f0-9]{32}$/), requestedAt: expect.any(Number) }])
    expect((await pending).state).toBe('stopped')
  })

  it('durably cancels an in-flight planner before aborting its provider scope', async () => {
    let entered!: () => void
    const running = new Promise<void>(resolve => { entered = resolve })
    const plan = vi.fn(({ signal }: Parameters<NonNullable<WorkflowServiceOptions['plan']>>[0]) => new Promise<{ output: string }>((resolve, reject) => {
      void resolve
      entered()
      signal.addEventListener('abort', () => reject(new Error('planner aborted')), { once: true })
    }))
    const { service, store } = fixture(undefined, { plan })
    const planning = service.planCommand(request)
    const planningResult = planning.then(() => undefined, error => error)
    await running
    const preparation = await service.prepareForShutdown({ timeoutMs: 50 })
    expect(preparation).toMatchObject({ state: 'unconfirmed', workflowIds: [expect.stringMatching(/^workflow-/)] })
    expect((await planningResult) as Error).toHaveProperty('message', 'planner aborted')
    let intent: WorkflowPlanningIntent | undefined
    for await (const candidate of store.planningIntents()) intent = candidate
    expect(intent).toMatchObject({ status: 'unknown', scopeSettled: false, stopCommandId: expect.stringMatching(/^shutdown-/) })
  })

})
