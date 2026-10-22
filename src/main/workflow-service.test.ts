import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowPlanningIntent, type WorkflowStoreRecord } from './workflow-store'
import { WORKFLOW_MAX_STOP_REQUESTS, type WorkflowControlFrame } from '../shared/workflow'
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

class ParentCheckpointStore extends MemoryWorkflowStore {
  fail = true
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
    if (this.fail && frame.nodeId === 'root' && frame.cursor === 1) throw new Error('fixture parent checkpoint failure')
    return super.saveFrame(frame, revision)
  }
}

describe('workflow service receipts, capabilities and recovery', () => {
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
    expect(results.map(result => result.progress.state)).toEqual(['completed', 'completed'])
    expect(second.execute).not.toHaveBeenCalled()
    expect((await store.load(preview.workflowId))?.execution?.segments).toHaveLength(2)
    const third = fixture(store)
    expect((await third.service.resume(preview.workflowId, approval, 'resume-command')).progress.state).toBe('completed')
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
    const second = fixture(store, { runControls: async role => ({ descriptor: descriptor(role.providerId), model: true, stop: true, identity, independentRun: true, terminalOutput: true }) })
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
      return { descriptor: descriptor(role.providerId), model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true }
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
