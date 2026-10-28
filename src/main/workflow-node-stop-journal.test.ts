import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowStoreRecord } from './workflow-store'
import { WorkflowRunner } from './workflow-runner'
import { registerWorkflowTargetStop } from './workflow-stop'
import type { WorkflowStopTarget } from '../shared/workflow-api'
import { deferred, fixture, prepared, started } from './workflow-node-stop.fixture'

class HeldStopStore extends MemoryWorkflowStore {
  holdAdmission = false
  holdRootStop = false
  private admissionHeld = false
  private stopHeld = false
  private rootStopHeld = false
  readonly admitted = deferred<string>()
  readonly releaseAdmission = deferred<void>()
  readonly stopPending = deferred<void>()
  readonly releaseStop = deferred<void>()
  readonly rootStopPending = deferred<void>()
  readonly releaseRootStop = deferred<void>()

  override async save(record: WorkflowStoreRecord): Promise<void> {
    // Hold a captured publication, not a mutable reference to later commands.
    const snapshot = structuredClone(record)
    const first = snapshot.intents.find(intent => intent.taskId.endsWith(':first'))
    if (this.holdAdmission && !this.admissionHeld && first) {
      this.admissionHeld = true
      this.admitted.resolve(first.attemptId)
      await this.releaseAdmission.promise
    }
    if (this.holdRootStop && !this.rootStopHeld && snapshot.stopRequests?.some(request => !request.target)) {
      this.rootStopHeld = true
      this.rootStopPending.resolve()
      await this.releaseRootStop.promise
    }
    if (!this.stopHeld && snapshot.stopRequests?.some(request => request.commandId === 'held-target')) {
      this.stopHeld = true
      this.stopPending.resolve()
      await this.releaseStop.promise
    }
    await super.save(snapshot)
  }

  release(): void {
    this.releaseAdmission.resolve()
    this.releaseStop.resolve()
    this.releaseRootStop.resolve()
  }
}

describe('targeted stop publication and cold receipts', () => {
  it('retains a confirmed stop for a late handle while a separate stop-again publication is pending', async () => {
    class LateHandleRunner extends WorkflowRunner {
      registerLate(workflowId: string, target: WorkflowStopTarget, stop: () => boolean): void {
        registerWorkflowTargetStop(this.active.get(workflowId), target, stop)
      }
    }
    const store = new HeldStopStore()
    const f = fixture(store)
    const { preview, approval } = await prepared(f)
    const runner = new LateHandleRunner({ store, slots: f.slots, execute: request => f.execute({ ...request, workspace: preview.workspace }) })
    runner.approve(preview, approval)
    const running = runner.start(preview, approval)
    let repeated: Promise<boolean> | undefined
    try {
      await f.entered.promise
      const record = (await store.load(preview.workflowId))!
      const first = record.intents.find(intent => intent.taskId.endsWith(':first'))!
      const target = { kind: 'attempt' as const, id: first.attemptId }
      expect(await runner.requestStop(preview.workflowId, 'known-first', undefined, target)).toBe(true)
      expect(f.executions.get('first')!.stop).toHaveBeenCalledTimes(1)
      repeated = runner.requestStop(preview.workflowId, 'held-target', undefined, target)
      await store.stopPending.promise
      expect((await store.load(preview.workflowId))!.stopRequests?.map(request => request.commandId)).toEqual(['known-first'])
      // Production registration must honor the earlier confirmed receipt even
      // when a newer, separate command has not yet been published.
      const lateStop = vi.fn(() => true)
      runner.registerLate(preview.workflowId, target, lateStop)
      expect(lateStop).toHaveBeenCalledTimes(1)
      store.release()
      expect(await repeated).toBe(true)
      expect(lateStop).toHaveBeenCalledTimes(2)
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    } finally {
      store.release()
      await repeated
      f.settleExecutionsForCleanup()
      await running
    }
  })

  it('copies the caller target before asynchronous readiness', async () => {
    const f = fixture()
    const { preview, running } = await started(f)
    const record = (await f.store.load(preview.workflowId))!
    const first = record.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
    const second = record.intents.find(intent => intent.taskId.endsWith(':second'))!.attemptId
    const target = { kind: 'attempt' as const, id: first }
    const stopping = f.service.stopNode(preview.workflowId, target, 'copied-target')
    target.id = second
    try {
      expect(await stopping).toBe(true)
      expect(f.executions.get('first')!.stop).toHaveBeenCalledTimes(1)
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    } finally {
      f.settleExecutionsForCleanup()
      await Promise.allSettled([running, stopping])
    }
  })

  it('does not signal an already running target before its stop publication completes', async () => {
    const store = new HeldStopStore()
    const f = fixture(store)
    const { preview, running } = await started(f)
    const record = (await store.load(preview.workflowId))!
    const target = record.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
    const stopping = f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'held-target')
    try {
      await store.stopPending.promise
      expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
      expect(f.slots.active).toBe(2)
      store.releaseStop.resolve()
      expect(await stopping).toBe(true)
      expect(f.executions.get('first')!.stop).toHaveBeenCalledTimes(1)
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
      expect(f.slots.active).toBe(2)
    } finally {
      store.release()
      f.settleExecutionsForCleanup()
      await Promise.allSettled([running, stopping])
    }
  })

  it('fences an admitted target while its journal is held without fencing its sibling', async () => {
    const store = new HeldStopStore()
    store.holdAdmission = true
    const f = fixture(store)
    const { preview, approval } = await prepared(f)
    const planningAttempts = (await store.load(preview.workflowId))!.progress.dispatchAttempts
    const requested = deferred<void>()
    const original = WorkflowRunner.prototype.requestStop
    const observer = vi.spyOn(WorkflowRunner.prototype, 'requestStop').mockImplementation(function (this: WorkflowRunner, ...args) {
      const pending = original.call(this, ...args)
      if (args[1] === 'held-target') requested.resolve()
      return pending
    })
    const running = f.service.start(preview.workflowId, approval)
    let stopping: Promise<boolean> | undefined
    try {
      const target = await Promise.race([store.admitted.promise, running.then(() => { throw new Error('Root ended before admission') })])
      stopping = f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'held-target')
      // Observe entry into the real Runner; do not replace its admission logic.
      await requested.promise
      store.releaseAdmission.resolve()
      await store.stopPending.promise
      expect(f.executions.has('first')).toBe(false)
      // A held root publisher also delays new sibling admissions. Releasing it
      // must let the sibling run, without launching or refunding this target.
      store.releaseStop.resolve()
      expect(await stopping).toBe(true)
      await f.starts.second.promise
      expect(f.executions.has('first')).toBe(false)
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
      const admitted = (await store.load(preview.workflowId))!
      expect(admitted.intents.some(intent => intent.attemptId === target)).toBe(true)
      expect(admitted.progress.dispatchAttempts).toBe(planningAttempts + admitted.intents.length)
    } finally {
      store.release()
      f.settleExecutionsForCleanup()
      await Promise.allSettled([running, ...(stopping ? [stopping] : [])])
      observer.mockRestore()
    }
  })

  it('does not use an older admission generation to signal after a held publication', async () => {
    const store = new HeldStopStore()
    store.holdRootStop = true
    const f = fixture(store)
    const { preview, running } = await started(f)
    const record = (await store.load(preview.workflowId))!
    const target = record.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
    const stopping = f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'held-target')
    await store.stopPending.promise
    const preparation = f.service.prepareForShutdown()
    try {
      store.releaseStop.resolve()
      await store.rootStopPending.promise
      expect(await stopping).toBe(true)
      expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
      store.releaseRootStop.resolve()
      f.settleExecutionsForCleanup()
      expect((await preparation).state).toBe('ready')
      await running
    } finally {
      store.release()
      f.settleExecutionsForCleanup()
      await Promise.allSettled([running, stopping, preparation])
    }
  })

  it('acknowledges a durable receipt after a lost publication response without signaling again', async () => {
    class LostResponseStore extends MemoryWorkflowStore {
      loseResponse = false
      override async save(record: WorkflowStoreRecord): Promise<void> {
        await super.save(record)
        if (this.loseResponse && record.stopRequests?.some(request => request.commandId === 'lost-response')) {
          this.loseResponse = false
          throw new Error('Published, response lost')
        }
      }
    }
    const store = new LostResponseStore()
    const f = fixture(store)
    const { preview, running } = await started(f)
    const record = (await store.load(preview.workflowId))!
    const target = record.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
    try {
      store.loseResponse = true
      await expect(f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'lost-response')).rejects.toThrow('response lost')
      expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
      expect((await store.load(preview.workflowId))!.stopRequests).toContainEqual(expect.objectContaining({ commandId: 'lost-response' }))
      expect(await f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'lost-response')).toBe(true)
      expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    } finally {
      f.settleExecutionsForCleanup()
      await running
    }
    const cold = fixture(store)
    expect(await cold.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'lost-response')).toBe(true)
    expect(cold.execute).not.toHaveBeenCalled()
    expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
  })

  it('persists a node receipt in FileStore, restores it cold, and rejects a foreign target before publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-node-stop-receipt-'))
    const store = new FileWorkflowStore(directory)
    const f = fixture(store)
    let running: Promise<unknown> | undefined
    try {
      const start = await started(f)
      running = start.running
      const { preview } = start
      const record = (await store.load(preview.workflowId))!
      const target = record.intents.find(intent => intent.taskId.endsWith(':first'))!.attemptId
      expect(await f.service.stopNode(preview.workflowId, { kind: 'attempt', id: target }, 'file-stop')).toBe(true)
      f.settleExecutionsForCleanup()
      await running
      const cold = fixture(new FileWorkflowStore(directory))
      const sibling = record.intents.find(intent => intent.taskId.endsWith(':second'))!.attemptId
      await expect(cold.service.stopNode(preview.workflowId, { kind: 'attempt', id: sibling }, 'file-stop')).rejects.toThrow()
      expect(await cold.service.stopNode(preview.workflowId, { id: target, kind: 'attempt' }, 'file-stop')).toBe(true)
      expect(cold.execute).not.toHaveBeenCalled()
      expect((await cold.service.snapshot(preview.workflowId))!.attempts.find(attempt => attempt.attemptId === target)?.stopRequested).toMatchObject({ commandId: 'file-stop' })
      const accepted = (await store.load(preview.workflowId))!
      const invalid = structuredClone(accepted)
      invalid.stopRequests!.push({ commandId: 'foreign-stop', requestedAt: 1, target: { kind: 'attempt', id: 'other-root-attempt' } })
      await expect(store.save(invalid)).rejects.toThrow()
      expect((await store.load(preview.workflowId))!.stopRequests).toEqual(accepted.stopRequests)
    } finally {
      f.settleExecutionsForCleanup()
      if (running) await running
      await rm(directory, { recursive: true, force: true })
    }
  })
})
