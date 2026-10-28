import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowParallelFailurePolicy } from '../shared/workflow'
import { validateWorkflowProgram } from './workflow-program'
import { WorkflowAdmissionFence } from './workflow-parallel-policy'
import { fixture, prepared, deferred } from './workflow-node-stop.fixture'
import { MemoryWorkflowStore, type WorkflowStoreRecord } from './workflow-store'
import { WorkflowSlots } from './workflow-slots'

const call = (name: string): WorkflowBlock => ({ kind: 'call', blockId: name, role: 'worker', prompt: name })
const parallel = (policy?: WorkflowParallelFailurePolicy, blocks = [call('first'), call('second')]): WorkflowBlock => ({
  kind: 'parallel', blockId: 'siblings', blocks, ...(policy ? { failurePolicy: policy } : {})
})
const body = (group: WorkflowBlock): WorkflowBlock => ({ kind: 'sequence', blockId: 'root', blocks: [group,
  { kind: 'return', blockId: 'finish', ref: { nodeId: group.blockId } }] })
const unknownPath = (handled: boolean): WorkflowBlock => {
  const report = (blockId: string): WorkflowBlock => ({ kind: 'bind', blockId, value: { kind: 'literal', value: 'reported' } })
  return { kind: 'sequence', blockId: 'probe_path', blocks: [
    { kind: 'call', blockId: 'probe', role: 'worker', prompt: 'probe',
      outputSchema: { type: 'object', properties: { flag: { type: 'boolean' } }, required: [] } },
    { kind: 'branch', blockId: 'choice', when: { kind: 'field', source: { kind: 'ref', name: 'probe' }, path: ['flag'] },
      then: report('yes'), else: report('no'), unknown: handled ? report('partial') : 'blocked' }
  ] }
}
type Running = Awaited<ReturnType<typeof start>>
const live: Array<{ f: ReturnType<typeof fixture>; running: Promise<unknown> }> = []
async function start(group = parallel('fail_fast'), store = new MemoryWorkflowStore(), slots = new WorkflowSlots(2)) {
  const f = fixture(store, slots, body(group))
  const { preview, approval } = await prepared(f)
  const running = f.service.start(preview.workflowId, approval)
  live.push({ f, running })
  return { ...f, preview, running }
}
function finish(f: Pick<Running, 'executions'>, name: string, status: 'completed' | 'failed' = 'completed', settled = true, output = name) {
  const execution = f.executions.get(name)
  expect(execution).toBeDefined()
  execution!.result.resolve({ runId: 'fixture-' + name, status, output, settled })
  if (settled) execution!.settled.resolve()
}
afterEach(async () => {
  for (const { f } of live) f.settleExecutionsForCleanup()
  await Promise.allSettled(live.map(value => value.running))
  for (const { f } of live) await vi.waitFor(() => expect(f.slots.active).toBe(0))
  live.length = 0
})

class PolicyStore extends MemoryWorkflowStore {
  readonly entered = deferred<void>()
  readonly release = deferred<void>()
  fail = false
  private intercepted = false
  override async save(record: WorkflowStoreRecord): Promise<void> {
    if (!this.intercepted && record.stopRequests?.some(request => request.provenance)) {
      this.intercepted = true
      this.entered.resolve()
      if (this.fail) throw new Error('policy journal failure')
      await this.release.promise
    }
    return super.save(record)
  }
}

class PolicyFrameStore extends MemoryWorkflowStore {
  gate = false
  readonly entered = deferred<void>()
  readonly release = deferred<void>()
  private intercepted = false
  override async loadFrame(workflowId: string, frameId: string) {
    const frame = await super.loadFrame(workflowId, frameId)
    if (this.gate && !this.intercepted && frame?.nodeId === 'siblings') {
      this.intercepted = true
      this.entered.resolve()
      await this.release.promise
    }
    return frame
  }
}

describe('parallel failure policy through canonical planning and execution', () => {
  it.each([false, true])('retains a scoped exception without another policy decision or stopping an outer branch (prior decision: %s)', async priorDecision => {
    class RejectedResultStore extends MemoryWorkflowStore {
      override async saveFrameWithValue(...args: Parameters<MemoryWorkflowStore['saveFrameWithValue']>) {
        if (args[0].nodeId === 'second' && args[0].phase === 'completed') throw new Error('late-frame-publication')
        return super.saveFrameWithValue(...args)
      }
    }
    const store = new RejectedResultStore()
    const outer: WorkflowBlock = { kind: 'parallel', blockId: 'outer', blocks: [parallel('fail_fast'), call('outside')] }
    const f = await start(outer, store, new WorkflowSlots(3))
    await vi.waitFor(() => expect(f.executions.size).toBe(3))
    if (priorDecision) {
      finish(f, 'first', 'failed')
      await vi.waitFor(() => expect(f.executions.get('second')!.stop).toHaveBeenCalledTimes(1))
    }
    finish(f, 'second')
    if (!priorDecision) {
      await vi.waitFor(() => expect(f.executions.get('first')!.stop).toHaveBeenCalledTimes(1))
      finish(f, 'first')
    }
    const result = await f.running
    const record = (await store.load(f.preview.workflowId))!
    const scopes = record.stopRequests?.filter(request => request.provenance?.source === 'auto' && !request.target)
    expect(scopes).toHaveLength(1)
    expect(result.state).toBe('unknown')
    expect(result.error).toContain('late-frame-publication')
    expect(f.executions.get('outside')!.stop).not.toHaveBeenCalled()
    // A resolved Provider result is not the effect handler's persistence/slot-release barrier.
    await vi.waitFor(() => expect(f.slots.active).toBe(1))
    expect(record.progress.dispatchAttempts).toBe(3)
    expect(record.outcomes.find(outcome => outcome.nodeId === 'second')).toMatchObject({ state: 'completed', settled: true })
    const admission = record.intents.find(intent => intent.taskId.endsWith(':second'))!
    const child = (await store.loadFrame(f.preview.workflowId, admission.frameId!))!
    expect(child.phase).toBe('entered')
    expect(child.parentFrameId).toBeTypeOf('string')
    const group = (await store.loadFrame(f.preview.workflowId, child.parentFrameId!))!
    expect(group).toMatchObject({ phase: 'unknown', reason: 'late-frame-publication' })
  })

  it('preserves absent policy bytes and rejects an unsupported policy', async () => {
    const f = fixture(new MemoryWorkflowStore(), new WorkflowSlots(2), body(parallel()))
    const { preview } = await prepared(f)
    const normalized = validateWorkflowProgram(preview.program)
    expect(normalized).toEqual(preview.program)
    if (normalized.body.kind !== 'sequence') throw new Error('Expected compiled root sequence')
    expect(normalized.body.blocks[0]).not.toHaveProperty('failurePolicy')
    const invalid = { ...normalized, body: { ...normalized.body, blocks: normalized.body.blocks.map(block =>
      block.kind === 'parallel' ? { ...block, failurePolicy: 'later' } : block) } }
    expect(() => validateWorkflowProgram(invalid)).toThrow()
  })

  it('records an automatic scope decision after the only admitted effect has settled', async () => {
    const f = await start(parallel('fail_fast', [unknownPath(false)]))
    await vi.waitFor(() => expect(f.executions.has('probe')).toBe(true))
    finish(f, 'probe', 'completed', true, '{}')
    await expect(f.running).resolves.toMatchObject({ state: 'blocked', dispatchAttempts: 1 })
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.stopRequests).toHaveLength(1)
    expect(record.stopRequests![0]).toMatchObject({ provenance: { source: 'auto', trigger: { nodeId: 'probe_path', phase: 'blocked' } } })
    expect(record.stopRequests![0]).not.toHaveProperty('target')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps nested fences local while tracking actual descendant targets', () => {
    const outer = new WorkflowAdmissionFence()
    const inner = new WorkflowAdmissionFence(outer)
    const target = { kind: 'attempt' as const, id: 'attempt-1' }
    inner.addTarget(target)
    expect(outer.targets).toContainEqual(target)
    inner.stop()
    expect(inner.isStopped()).toBe(true)
    expect(outer.isStopped()).toBe(false)
    inner.removeTarget(target)
    expect(outer.targets.size).toBe(0)
    outer.stop()
    expect(new WorkflowAdmissionFence(outer).isStopped()).toBe(true)
  })

  it.each([undefined, 'all_settled'] as const)('does not stop a sibling under policy %s', async policy => {
    const f = await start(parallel(policy))
    await f.entered.promise
    finish(f, 'first', 'failed')
    const admission = (await f.store.load(f.preview.workflowId))!.intents.find(intent => intent.taskId.endsWith(':first'))!
    await vi.waitFor(async () => expect((await f.store.loadFrame(f.preview.workflowId, admission.frameId!))?.phase).toBe('failed'))
    expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    expect((await f.store.load(f.preview.workflowId))!.stopRequests).toBeUndefined()
    finish(f, 'second')
    await expect(f.running).resolves.toMatchObject({ state: 'failed', dispatchAttempts: 2 })
  })

  it('retains an approved loop partial report without cancelling its sibling or turning the root green', async () => {
    const loop: WorkflowBlock = { kind: 'loop', blockId: 'partial_loop', initial: { candidate: { kind: 'literal', value: 'original' } },
      stateSchema: { candidate: { type: 'string' } }, invariants: { rubric: { kind: 'literal', value: true } }, outcome: 'loop_status', maxIterations: 1,
      body: { kind: 'bind', blockId: 'step', value: { kind: 'literal', value: 'next' } },
      until: { kind: 'literal', value: false }, carry: { candidate: { kind: 'ref', name: 'step' } },
      result: { kind: 'ref', name: 'candidate' }, progress: 'bounded_only',
      policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' } }
    const store = new MemoryWorkflowStore()
    const save = vi.spyOn(store, 'saveFrame')
    const f = await start(parallel('fail_fast', [loop, call('second')]), store)
    await vi.waitFor(async () => {
      const draft = save.mock.calls.find(([frame]) => frame.nodeId === 'partial_loop')?.[0]
      expect(draft).toBeDefined()
      expect(await store.loadFrame(f.preview.workflowId, draft!.frameId)).toMatchObject({ phase: 'blocked', continuation: 'report_partial', loop: { reasons: ['exhausted'] } })
    })
    await vi.waitFor(() => expect(f.executions.has('second')).toBe(true))
    expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    expect((await store.load(f.preview.workflowId))!.stopRequests).toBeUndefined()
    finish(f, 'second')
    await expect(f.running).resolves.toMatchObject({ state: 'blocked', dispatchAttempts: 1 })
  })

  it('does not treat an explicitly handled unknown arm as a critical failure', async () => {
    const store = new MemoryWorkflowStore()
    const save = vi.spyOn(store, 'saveFrame')
    const f = await start(parallel('fail_fast', [unknownPath(true), call('second')]), store)
    await f.entered.promise
    finish(f, 'probe', 'completed', true, '{}')
    await vi.waitFor(async () => {
      const draft = save.mock.calls.find(([frame]) => frame.nodeId === 'choice')?.[0]
      expect(draft, JSON.stringify({ frames: save.mock.calls.slice(-32).map(([frame]) => ({ nodeId: frame.nodeId, phase: frame.phase, reason: frame.reason })),
        progress: await f.service.snapshot(f.preview.workflowId) })).toBeDefined()
      expect(await store.loadFrame(f.preview.workflowId, draft!.frameId)).toMatchObject({ phase: 'completed', arm: 'unknown' })
    })
    await vi.waitFor(() => expect(f.executions.has('second')).toBe(true))
    expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    expect((await store.load(f.preview.workflowId))!.stopRequests).toBeUndefined()
    finish(f, 'second')
    await expect(f.running).resolves.toMatchObject({ state: 'completed', dispatchAttempts: 2 })
  })

  it('journals scope and target before one automatic signal, preserving actual business results', async () => {
    const f = await start()
    await f.entered.promise
    finish(f, 'first', 'failed')
    await vi.waitFor(() => expect(f.executions.get('second')!.stop).toHaveBeenCalledTimes(1))
    const record = (await f.store.load(f.preview.workflowId))!
    const scope = record.stopRequests!.find(request => !request.target)!
    const target = record.stopRequests!.find(request => request.target)!
    expect(scope.provenance).toMatchObject({ source: 'auto', policy: 'fail_fast', trigger: { nodeId: 'first', phase: 'failed' } })
    expect(target.provenance).toEqual(scope.provenance)
    expect(await f.store.loadFrame(f.preview.workflowId, scope.provenance!.trigger.frameId)).toMatchObject({ nodeId: 'siblings' })
    expect(record.progress.stopRequestedAt).toBeUndefined()
    await expect(f.service.stopNode(f.preview.workflowId, target.target!, target.commandId)).rejects.toThrow()
    finish(f, 'second')
    await expect(f.running).resolves.toMatchObject({ state: 'failed', dispatchAttempts: 2 })
    expect((await f.store.load(f.preview.workflowId))!.outcomes.find(outcome => outcome.attemptId === target.target!.id)?.state).toBe('completed')
    expect(f.executions.get('second')!.stop).toHaveBeenCalledTimes(1)
  })

  it('does not stop an independent outer branch', async () => {
    const inner = parallel('fail_fast')
    const outer: WorkflowBlock = { kind: 'parallel', blockId: 'outer', blocks: [inner, call('outside')] }
    const f = await start(outer, new MemoryWorkflowStore(), new WorkflowSlots(3))
    await vi.waitFor(() => expect(f.executions.size).toBe(3))
    finish(f, 'first', 'failed')
    await vi.waitFor(() => expect(f.executions.get('second')!.stop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.executions.has('outside')).toBe(true))
    expect(f.executions.get('outside')!.stop).not.toHaveBeenCalled()
    finish(f, 'second')
    finish(f, 'outside')
    await expect(f.running).resolves.toMatchObject({ state: 'failed', dispatchAttempts: 3 })
  })

  it('can stop its still-live scope after an independent unknown has ended the root business result', async () => {
    const store = new PolicyFrameStore()
    const outer: WorkflowBlock = { kind: 'parallel', blockId: 'outer', blocks: [parallel('fail_fast'), call('outside')] }
    const f = await start(outer, store, new WorkflowSlots(3))
    try {
      await vi.waitFor(() => expect(f.executions.size).toBe(3))
      store.gate = true
      finish(f, 'first', 'failed')
      await store.entered.promise
      f.executions.get('outside')!.result.resolve({ runId: 'outside', status: 'unknown', settled: false })
      await expect(f.running).resolves.toMatchObject({ state: 'unknown' })
      expect(f.slots.active).toBe(2)
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
      store.release.resolve()
      await vi.waitFor(() => expect(f.executions.get('second')!.stop).toHaveBeenCalledTimes(1))
      expect(f.executions.get('outside')!.stop).not.toHaveBeenCalled()
      await expect(f.service.snapshot(f.preview.workflowId)).resolves.toMatchObject({ state: 'unknown' })
    } finally { store.release.resolve() }
  })

  it('fences queued admission synchronously and sends no signal while the policy publication is pending', async () => {
    const store = new PolicyStore()
    const slots = new WorkflowSlots(3)
    const independent = await start(parallel(undefined, [call('holder')]), new MemoryWorkflowStore(), slots)
    await vi.waitFor(() => expect(independent.executions.has('holder')).toBe(true))
    const f = await start(parallel('fail_fast', [call('first'), call('second'), call('third')]), store, slots)
    try {
      await f.entered.promise
      await vi.waitFor(() => expect(f.slots.queued).toBe(1))
      finish(f, 'first', 'failed', false)
      await store.entered.promise
      expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
      expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
      expect(independent.executions.get('holder')!.stop).not.toHaveBeenCalled()
      finish(independent, 'holder')
      await expect(independent.running).resolves.toMatchObject({ state: 'completed' })
      // A separate owner's genuine release drains this queue while its policy
      // journal is held; the fenced child must not reserve an intent or run.
      await vi.waitFor(() => expect(f.slots.queued).toBe(0))
      expect(f.execute).toHaveBeenCalledTimes(2)
      expect(f.executions.has('third')).toBe(false)
      store.release.resolve()
      await vi.waitFor(() => expect(f.executions.get('second')!.stop).toHaveBeenCalledTimes(1))
      f.executions.get('first')!.settled.resolve()
      finish(f, 'second')
      await f.running
      expect((await store.load(f.preview.workflowId))!.intents).toHaveLength(2)
    } finally { store.release.resolve() }
  })

  it('keeps an unknown publication fenced and unsignalled instead of pretending cancellation succeeded', async () => {
    const store = new PolicyStore()
    store.fail = true
    const f = await start(parallel('fail_fast'), store)
    await f.entered.promise
    finish(f, 'first', 'failed', false)
    await store.entered.promise
    await expect(f.running).resolves.toMatchObject({ state: 'unknown' })
    expect(f.executions.get('first')!.stop).not.toHaveBeenCalled()
    expect(f.executions.get('second')!.stop).not.toHaveBeenCalled()
    expect(f.slots.active).toBe(2)
    await expect(f.service.snapshot(f.preview.workflowId)).resolves.toMatchObject({ state: 'unknown' })
  })
})
