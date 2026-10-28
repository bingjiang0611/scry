import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock } from '../shared/workflow'
import { fixture, prepared, deferred } from './workflow-node-stop.fixture'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowSlots } from './workflow-slots'
import { WorkflowAdmissionFence, workflowParallelFailureCommandId, workflowParallelFailureProvenance, type WorkflowParallelFailure } from './workflow-parallel-policy'
import { recordWorkflowParallelFailure } from './workflow-parallel-stop'
import { registerWorkflowTargetStop, sameWorkflowStopProvenance, validateWorkflowStopRequests, workflowStopTargetKey } from './workflow-stop'

const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'parallel', blockId: 'siblings', failurePolicy: 'fail_fast', blocks: [
    { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first' },
    { kind: 'call', blockId: 'second', role: 'worker', prompt: 'second' }
  ] }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'siblings' } }
] }
const live: Array<{ f: ReturnType<typeof fixture>; running: Promise<unknown> }> = []
afterEach(async () => {
  for (const { f } of live) f.settleExecutionsForCleanup()
  await Promise.allSettled(live.map(value => value.running))
  for (const { f } of live) await vi.waitFor(() => expect(f.slots.active).toBe(0))
  live.length = 0
})

/** This fixture supplies a protocol event to the journal function, not a real
 * interpreter failure. Runtime trigger behavior is tested in parallel-failure. */
async function context(store: WorkflowStore = new MemoryWorkflowStore()) {
  const f = fixture(store, new WorkflowSlots(2), body)
  const { preview, approval } = await prepared(f)
  const running = f.service.start(preview.workflowId, approval)
  live.push({ f, running })
  await f.entered.promise
  const record = (await store.load(preview.workflowId))!
  const second = record.intents.find(intent => intent.taskId.endsWith(':second'))!
  const frame = (await store.loadFrame(preview.workflowId, second.frameId!))!
  expect(typeof frame.parentFrameId).toBe('string')
  const target = { kind: 'attempt' as const, id: second.attemptId }
  const admission = new WorkflowAdmissionFence()
  admission.addTarget(target)
  admission.stop()
  const failure: WorkflowParallelFailure = { policy: 'fail_fast', admission,
    trigger: { frameId: frame.parentFrameId!, nodeId: 'first', phase: 'failed' } }
  const owner = { record, targetStops: new Map<string, Set<() => boolean>>(), targetLatches: new Map<string, boolean>() }
  const stop = vi.fn(() => true)
  owner.targetStops.set(workflowStopTargetKey(target), new Set([stop]))
  const options = { owner, failure, store, now: () => 1,
    persist: () => store.save(record), canSignal: () => true }
  return { ...f, preview, running, owner, failure, target, stop, options }
}

describe('parallel policy durable signal boundary', () => {
  it('does not signal on an unconfirmed candidate or replay a lost publication acknowledgement', async () => {
    const f = await context()
    await expect(recordWorkflowParallelFailure({ ...f.options, persist: async () => {
      await f.options.persist()
      throw new Error('lost publication acknowledgement')
    } })).rejects.toThrow('lost publication acknowledgement')
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.owner.targetLatches.get(workflowStopTargetKey(f.target))).toBe(false)
    await expect(recordWorkflowParallelFailure(f.options)).resolves.toBe(true)
    await expect(recordWorkflowParallelFailure(f.options)).resolves.toBe(true)
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('rejects a candidate absent from durable readback without retrying publication', async () => {
    const f = await context()
    const persist = vi.fn(async () => { throw new Error('publication not accepted') })
    await expect(recordWorkflowParallelFailure({ ...f.options, persist })).rejects.toThrow('publication not accepted')
    await expect(recordWorkflowParallelFailure({ ...f.options, persist })).rejects.toThrow('尚未确认持久化')
    expect(persist).toHaveBeenCalledTimes(1)
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('requires the live generation guard even after durable publication', async () => {
    const f = await context()
    await expect(recordWorkflowParallelFailure({ ...f.options, canSignal: () => false })).resolves.toBe(true)
    expect((await f.store.load(f.preview.workflowId))!.stopRequests).toHaveLength(2)
    expect(f.stop).not.toHaveBeenCalled()
    const late = vi.fn(() => true)
    registerWorkflowTargetStop(f.owner, f.target, late)
    expect(late).not.toHaveBeenCalled()
  })

  it('latches a late actor only after confirmed publication', async () => {
    const f = await context()
    f.owner.targetStops.clear()
    const entered = deferred<void>(), release = deferred<void>()
    const pending = recordWorkflowParallelFailure({ ...f.options, persist: async () => {
      entered.resolve()
      await release.promise
      await f.options.persist()
    } })
    try {
      await entered.promise
      registerWorkflowTargetStop(f.owner, f.target, f.stop)
      expect(f.stop).not.toHaveBeenCalled()
      release.resolve()
      await pending
      expect(f.stop).toHaveBeenCalledTimes(1)
      await recordWorkflowParallelFailure(f.options)
      expect(f.stop).toHaveBeenCalledTimes(1)
    } finally { release.resolve() }
  })

  it('does not reinterpret an already requested target as permission for another automatic signal', async () => {
    const f = await context()
    f.owner.record.stopRequests = [{ commandId: 'earlier-user-stop', target: f.target, requestedAt: 0 }]
    f.owner.targetLatches.set(workflowStopTargetKey(f.target), true)
    await recordWorkflowParallelFailure(f.options)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.owner.targetLatches.get(workflowStopTargetKey(f.target))).toBe(true)
  })

  it('compares provenance semantically and rejects a receipt rebound to a different trigger', async () => {
    const f = await context()
    const reordered = { phase: f.failure.trigger.phase, frameId: f.failure.trigger.frameId, nodeId: f.failure.trigger.nodeId }
    expect(workflowParallelFailureCommandId(f.preview.workflowId, reordered, f.target)).toBe(workflowParallelFailureCommandId(f.preview.workflowId, f.failure.trigger, f.target))
    expect(sameWorkflowStopProvenance(workflowParallelFailureProvenance(reordered), workflowParallelFailureProvenance(f.failure.trigger))).toBe(true)
    f.owner.record.stopRequests = [{ commandId: workflowParallelFailureCommandId(f.preview.workflowId, f.failure.trigger), requestedAt: 1,
      provenance: workflowParallelFailureProvenance({ ...f.failure.trigger, nodeId: 'different' }) }]
    await expect(recordWorkflowParallelFailure(f.options)).rejects.toThrow('停止收据合同无效')
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('keeps the same scope receipt across a cold FileStore and never replays its signal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-parallel-stop-'))
    let cleanup: (() => void) | undefined
    let running: Promise<unknown> | undefined
    try {
      const f = await context(new FileWorkflowStore(directory))
      cleanup = f.settleExecutionsForCleanup
      running = f.running
      await recordWorkflowParallelFailure(f.options)
      expect(f.stop).toHaveBeenCalledTimes(1)
      const coldStore = new FileWorkflowStore(directory)
      const coldRecord = (await coldStore.load(f.preview.workflowId))!
      validateWorkflowStopRequests(coldRecord)
      const coldStop = vi.fn(() => true)
      const coldOwner = { ...f.owner, record: coldRecord,
        targetStops: new Map([[workflowStopTargetKey(f.target), new Set([coldStop])]]), targetLatches: new Map<string, boolean>() }
      await recordWorkflowParallelFailure({ ...f.options, owner: coldOwner, store: coldStore,
        persist: () => coldStore.save(coldRecord) })
      expect(coldStop).not.toHaveBeenCalled()
      expect(coldRecord.stopRequests).toEqual(f.owner.record.stopRequests)
    } finally {
      cleanup?.()
      await running
      await rm(directory, { recursive: true, force: true })
    }
  })
})
