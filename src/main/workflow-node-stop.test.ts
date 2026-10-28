import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore } from './workflow-store'
import { fixture, deferred, started } from './workflow-node-stop.fixture'
import { fixture as systemFixture } from './workflow-system.fixture'
import type { WorkflowSystemExecution } from './workflow-system-host'

describe('durable targeted workflow stops', () => {
  it('does not signal a target when the stop journal fails, while siblings remain live', async () => {
    class FailedStopStore extends MemoryWorkflowStore {
      fail = false
      stopWrites = 0
      override async save(record: Parameters<MemoryWorkflowStore['save']>[0]): Promise<void> {
        if (this.fail && record.stopRequests?.length) {
          this.stopWrites++
          throw new Error('fixture stop journal failure')
        }
        return super.save(record)
      }
    }
    const store = new FailedStopStore(), f = fixture(store), { preview, running } = await started(f)
    const target = (await store.load(preview.workflowId))!.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
    try {
      store.fail = true
      await expect(f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'failed-stop')).rejects.toThrow('fixture stop journal failure')
      await expect(f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'failed-stop')).rejects.toThrow()
      expect(store.stopWrites).toBe(1)
      expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    } finally {
      store.fail = false
      f.executions.get('first')!.result.resolve({ runId: 'first', status: 'completed', output: 'first', settled: true })
      f.executions.get('second')!.result.resolve({ runId: 'second', status: 'completed', output: 'second', settled: true })
      f.executions.get('first')!.settled.resolve(); f.executions.get('second')!.settled.resolve()
      await running
    }
  })

  it('stops one deferred SystemStep without using the whole-root controller', async () => {
    const f = await systemFixture(), entered = deferred<void>(), result = deferred<Awaited<WorkflowSystemExecution['result']>>(), settled = deferred<void>()
    const original = f.host.execute.bind(f.host), stop = vi.fn(() => true)
    vi.spyOn(f.host, 'execute').mockImplementation((preview, block, stepId, input, beforeCheck) => {
      if (block.kind === 'replica') return original(preview, block, stepId, input, beforeCheck)
      entered.resolve()
      return { result: result.promise, settled: settled.promise, stop }
    })
    const running = f.service.start(f.preview.workflowId, f.approval)
    await entered.promise
    const record = (await f.store.load(f.preview.workflowId))!, step = record.systemIntents!.find(intent => intent.kind === 'check')!.stepId
    expect(await f.service.stopNode(f.preview.workflowId, { kind: 'system', id: step }, 'system-stop')).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    result.resolve({ state: 'unknown', settled: false, value: { state: 'unknown', reason: 'deferred', derivedFrom: [] } })
    settled.resolve()
    await expect(running).resolves.toMatchObject({ state: 'unknown' })
  })

  it('projects a later stop intent without mutating an already accepted Agent outcome', async () => {
    const f = fixture()
    const { preview, running } = await started(f)
    const first = f.executions.get('first')!
    first.result.resolve({ runId: 'first', status: 'unknown', settled: false })
    f.executions.get('second')!.result.resolve({ runId: 'second', status: 'completed', output: 'second', settled: true })
    f.executions.get('second')!.settled.resolve()
    expect((await running).state).toBe('unknown')
    const before = (await f.store.load(preview.workflowId))!
    const target = before.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
    f.slots.configure(1)
    try {
      expect(await f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'later-stop')).toBe(true)
      const after = (await f.store.load(preview.workflowId))!
      expect(after.outcomes).toEqual(before.outcomes)
      expect(after.progress.attempts.find(attempt => attempt.attemptId === target)?.stopRequested).toBeUndefined()
      const snapshot = await f.service.snapshot(preview.workflowId)
      expect(snapshot?.attempts.find(attempt => attempt.attemptId === target)?.stopRequested).toMatchObject({ commandId: 'later-stop' })
    } finally {
      first.settled.resolve()
      await f.slots.withSlot(async () => undefined, 'after-stop-scope')
    }
  })

  it('signals one sibling, preserves the other, and holds capacity until settlement', async () => {
    const f = fixture()
    const { preview, running } = await started(f)
    const record = (await f.store.load(preview.workflowId))!
    const target = record.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
    const first = f.executions.get('first')!
    expect(await f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'node-stop')).toBe(true)
    expect(await f.service.stopNode(preview.workflowId, { id: target, kind: 'attempt' }, 'node-stop')).toBe(true)
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    expect(f.slots.active).toBe(2)
    first.result.resolve({ runId: 'first', status: 'unknown', settled: false })
    f.executions.get('second')!.result.resolve({ runId: 'second', status: 'completed', output: 'second', settled: true })
    f.executions.get('second')!.settled.resolve()
    expect((await running).state).toBe('unknown')
    expect(f.slots.active).toBe(1)
    // Queue a real shared-slot user behind the still-open scope. ACK and the
    // terminal business result cannot release it; only actual settlement can.
    f.slots.configure(1)
    const next = f.slots.withSlot(async () => undefined, 'after-physical-settlement')
    expect(f.slots.queued).toBe(1)
    first.settled.resolve()
    await next
    const signals = first.stop.mock.calls.length
    const cold = fixture(f.store)
    expect(await cold.service.stopNode(preview.workflowId, { id: target, kind: 'attempt' }, 'node-stop')).toBe(true)
    expect(cold.execute).not.toHaveBeenCalled()
    expect(first.stop).toHaveBeenCalledTimes(signals)
    expect((await f.store.load(preview.workflowId))!.outcomes.find(outcome => outcome.attemptId === target)?.state).toBe('unknown')
    await expect(f.service.stopNode(preview.workflowId, { kind: 'attempt', id: 'foreign' }, 'foreign-stop')).resolves.toBe(false)
    await expect(f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'node-stop')).resolves.toBe(true)
    await expect(f.service.stop(preview.workflowId, 'node-stop')).rejects.toThrow()
  })
})
