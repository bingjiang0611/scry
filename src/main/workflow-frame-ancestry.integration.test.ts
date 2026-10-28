import { describe, expect, it } from 'vitest'
import type { WorkflowBlock, WorkflowControlFrame, WorkflowLoopBlock } from '../shared/workflow'
import type { WorkflowFrameValueCheckpoint, WorkflowStoreRecord } from './workflow-store-contracts'
import { deferred } from './workflow-node-stop.fixture'
import { MemoryWorkflowStore } from './workflow-memory-store'
import { WorkflowRunner } from './workflow-runner'
import type { WorkflowProviderExecutor } from './workflow-runner-contracts'
import { WorkflowSlots } from './workflow-slots'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { nextWorkflowFrame, validateWorkflowFrame } from './workflow-frames'
import { projectWorkflowFrameLinks } from './workflow-progress'

const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
function preview(body: WorkflowBlock, workflowId: string) {
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId, programRevision: 'pending', userGoal: 'frame ancestry', workspace: '/fixture', roles: [role], body })
  const { programRevision: _revision, ...source } = program
  program.programRevision = workflowRevision(source)
  return makePlanPreview(program, [], role)
}
const approval = (workflowId: string, programRevision: string) => ({ workflowId, programRevision, approvedAt: 1 })

class AncestryStore extends MemoryWorkflowStore {
  readonly acceptedFrames: WorkflowControlFrame[] = []
  constructor(private readonly accepted: (frame: WorkflowControlFrame) => void = () => {}) { super() }
  private observe(frame: WorkflowControlFrame): WorkflowControlFrame {
    this.acceptedFrames.push(structuredClone(frame))
    this.accepted(frame)
    return frame
  }
  override async saveFrame(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number) {
    return this.observe(await super.saveFrame(input, expectedRevision))
  }
  override async saveFrameWithValue(input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number, checkpoint: WorkflowFrameValueCheckpoint) {
    return this.observe(await super.saveFrameWithValue(input, expectedRevision, checkpoint))
  }
}
function frames(store: AncestryStore, nodeId: string): WorkflowControlFrame[] {
  return [...new Map(store.acceptedFrames.filter(frame => frame.nodeId === nodeId).map(frame => [frame.frameId, frame])).values()]
}
function onlyFrame(store: AncestryStore, nodeId: string): WorkflowControlFrame {
  const matches = frames(store, nodeId)
  expect(matches).toHaveLength(1)
  return matches[0]!
}
async function run(body: WorkflowBlock, workflowId: string, execute: WorkflowProviderExecutor = request => ({
  result: Promise.resolve({ runId: request.attemptId, status: 'completed', output: 'agent', settled: true }),
  stop: () => true
}), store = new AncestryStore()) {
  const plan = preview(body, workflowId)
  const runner = new WorkflowRunner({ store, slots: new WorkflowSlots(2), execute })
  const accepted = approval(plan.workflowId, plan.programRevision)
  runner.approve(plan, accepted)
  return { store, plan, progress: await runner.start(plan, accepted) }
}

describe('compiled workflow frame ancestry and progress projection', () => {
  it('keeps nested sequence bindings while recording distinct structural parents on one scope path', async () => {
    const id = 'ancestry-nested'
    const result = await run({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'sequence', blockId: 'inner', blocks: [
        { kind: 'bind', blockId: 'seed', value: { kind: 'literal', value: 'ok' } },
        { kind: 'bind', blockId: 'copied', value: { kind: 'ref', name: 'seed' } }
      ] },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'copied' } }
    ] }, id)
    expect(result.progress.state).toBe('completed')
    expect(result.progress.finalReport).toBe('ok')
    const root = onlyFrame(result.store, 'root')
    const inner = onlyFrame(result.store, 'inner')
    const seed = onlyFrame(result.store, 'seed')
    expect(root.parentFrameId).toBeNull()
    expect(inner.parentFrameId).toBe(root.frameId)
    expect(seed.parentFrameId).toBe(inner.frameId)
    expect(onlyFrame(result.store, 'copied').parentFrameId).toBe(inner.frameId)
    expect(inner.scopePath).toEqual(root.scopePath)
    expect(seed.scopePath).toEqual(root.scopePath)
    expect(await result.store.loadFrame(id, seed.frameId)).toEqual(seed)
  })

  it('keeps parallel ancestry correct when the right branch completes first', async () => {
    const leftStarted = deferred<void>(), rightStarted = deferred<void>()
    const leftReply = deferred<void>(), rightReply = deferred<void>(), rightCommitted = deferred<void>()
    const order: string[] = []
    const store = new AncestryStore(frame => {
      if (frame.phase === 'completed' && ['left', 'right'].includes(frame.nodeId) && !order.includes(frame.nodeId)) {
        order.push(frame.nodeId)
        if (frame.nodeId === 'right') rightCommitted.resolve()
      }
    })
    const running = run({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'parallel', blockId: 'fork', blocks: [
        { kind: 'sequence', blockId: 'left', blocks: [{ kind: 'call', blockId: 'left_actor', role: 'worker', prompt: 'left' }] },
        { kind: 'sequence', blockId: 'right', blocks: [{ kind: 'call', blockId: 'right_actor', role: 'worker', prompt: 'right' }] }
      ] },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'fork' } }
    ] }, 'ancestry-parallel', request => {
      const left = request.taskId.endsWith(':left_actor')
      const started = left ? leftStarted : rightStarted
      started.resolve()
      const result = (left ? leftReply : rightReply).promise.then(() => ({
        runId: request.attemptId, status: 'completed' as const, output: left ? 'left' : 'right', settled: true
      }))
      return { result, stop: () => true }
    }, store)
    try {
      await Promise.all([leftStarted.promise, rightStarted.promise])
      rightReply.resolve()
      await rightCommitted.promise
      expect(order).toEqual(['right'])
      leftReply.resolve()
      const result = await running
      expect(result.progress.state).toBe('completed')
      expect(JSON.parse(result.progress.finalReport!)).toEqual({ left: 'left', right: 'right' })
      expect(order).toEqual(['right', 'left'])
      const fork = onlyFrame(store, 'fork')
      const left = onlyFrame(store, 'left'), right = onlyFrame(store, 'right')
      expect(left.parentFrameId).toBe(fork.frameId)
      expect(right.parentFrameId).toBe(fork.frameId)
      expect(onlyFrame(store, 'left_actor').parentFrameId).toBe(left.frameId)
      expect(onlyFrame(store, 'right_actor').parentFrameId).toBe(right.frameId)
      expect(left.frameId).not.toBe(right.frameId)
    } finally {
      leftReply.resolve()
      rightReply.resolve()
      await running
    }
  })

  it('records map body ancestry through actual collection execution', async () => {
    const result = await run({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'input', value: { kind: 'literal', value: [{ id: 'a' }, { id: 'b' }] } },
      { kind: 'map', blockId: 'mapped', items: { kind: 'ref', name: 'input' }, item: 'entry', key: ['id'], maxItems: 2,
        body: { kind: 'bind', blockId: 'copy', value: { kind: 'ref', name: 'entry' } } },
      { kind: 'collect', blockId: 'collected', items: { kind: 'ref', name: 'mapped' } },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'collected' } }
    ] }, 'ancestry-map')
    expect(result.progress.state).toBe('completed')
    expect(JSON.parse(result.progress.finalReport!)).toHaveLength(2)
    const root = onlyFrame(result.store, 'root')
    const mapped = onlyFrame(result.store, 'mapped')
    expect(mapped.parentFrameId).toBe(root.frameId)
    const bodies = frames(result.store, 'copy')
    expect(bodies).toHaveLength(2)
    expect(new Set(bodies.map(frame => frame.frameId)).size).toBe(2)
    for (const body of bodies) expect(body.parentFrameId).toBe(mapped.frameId)
  })

  it('records loop body ancestry through an actual bounded loop execution', async () => {
    const loop: WorkflowLoopBlock = { kind: 'loop', blockId: 'loop', initial: { candidate: { kind: 'literal', value: 'seed' } }, stateSchema: { candidate: { type: 'string' } }, invariants: { rubric: { kind: 'literal', value: 'fixed' } }, iteration: 'round', outcome: 'status', maxIterations: 1,
      body: { kind: 'call', blockId: 'step', role: 'worker', prompt: 'step', inputRefs: [{ nodeId: 'candidate' }], outputSchema: { type: 'object', properties: { candidate: { type: 'string' }, passed: { type: 'boolean' } }, required: ['candidate', 'passed'] } },
      until: { kind: 'field', source: { kind: 'ref', name: 'step' }, path: ['passed'] }, carry: { candidate: { kind: 'field', source: { kind: 'ref', name: 'step' }, path: ['candidate'] } }, result: { kind: 'ref', name: 'candidate' }, progress: 'bounded_only', policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' } }
    const result = await run({ kind: 'sequence', blockId: 'root', blocks: [loop, { kind: 'return', blockId: 'report', ref: { nodeId: 'loop' } }] }, 'ancestry-loop', request => ({ result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, output: JSON.stringify({ candidate: 'done', passed: true }), settled: true }), stop: () => true }))
    expect(result.progress.state).toBe('completed')
    const root = onlyFrame(result.store, 'root')
    const parent = onlyFrame(result.store, 'loop')
    const body = onlyFrame(result.store, 'step')
    expect(root.parentFrameId).toBeNull()
    expect(parent.parentFrameId).toBe(root.frameId)
    expect(body.parentFrameId).toBe(parent.frameId)
    expect(await result.store.loadFrame(result.plan.workflowId, body.frameId)).toEqual(body)
  })

  it('records selected-arm ancestry and an explicit unexecuted-arm marker', async () => {
    const result = await run({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'branch', blockId: 'choice', when: { kind: 'literal', value: true }, unknown: 'blocked',
        then: { kind: 'sequence', blockId: 'chosen', blocks: [{ kind: 'bind', blockId: 'value', value: { kind: 'literal', value: 'chosen' } }] },
        else: { kind: 'bind', blockId: 'unchosen', value: { kind: 'literal', value: 'wrong' } } },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'choice' } }
    ] }, 'ancestry-branch')
    expect(result.progress.state).toBe('completed')
    expect(JSON.parse(result.progress.finalReport!)).toEqual({ arm: 'then', value: 'chosen' })
    const choice = onlyFrame(result.store, 'choice')
    const chosen = onlyFrame(result.store, 'chosen')
    expect(choice.parentFrameId).toBe(onlyFrame(result.store, 'root').frameId)
    expect(chosen.parentFrameId).toBe(choice.frameId)
    expect(onlyFrame(result.store, 'value').parentFrameId).toBe(chosen.frameId)
    const skipped = onlyFrame(result.store, 'unchosen')
    expect(skipped.parentFrameId).toBe(choice.frameId)
    expect(skipped.phase).toBe('skipped_by_condition')
    expect(skipped).not.toHaveProperty('resultRef')
  })

  it('projects actual admitted frame links without changing canonical outcomes', async () => {
    const result = await run({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'worker', role: 'worker', prompt: 'offline' },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'worker' } }
    ] }, 'ancestry-projection')
    const record = await result.store.load(result.plan.workflowId) as WorkflowStoreRecord
    const before = structuredClone(record.outcomes)
    const projected = projectWorkflowFrameLinks(record.progress, record)
    const intent = record.intents[0]
    expect(intent.frameId).toBeDefined()
    expect(projected.attempts.find(attempt => attempt.attemptId === intent.attemptId)?.frameId).toBe(intent.frameId)
    expect(record.outcomes).toEqual(before)
    expect(record.outcomes[0]).not.toHaveProperty('frameId')
    expect(intent.callFrameId).toBe(intent.frameId)
    const legacy = { ...record, intents: record.intents.map(({ frameId: _frameId, ...admission }) => admission) }
    const legacyView = projectWorkflowFrameLinks(record.progress, legacy)
    expect(legacyView.attempts.find(attempt => attempt.attemptId === intent.attemptId)?.frameId).toBe(intent.callFrameId)
    expect(legacy.outcomes).toEqual(before)
  })

  it('rejects self-parenting and CAS parent grafts while retaining legacy unknown ancestry', () => {
    const base: Omit<WorkflowControlFrame, 'revision'> = { schemaVersion: 1, workflowId: 'schema', programRevision: 'revision', frameId: 'root', nodeId: 'root', scopePath: [], inputKey: 'a'.repeat(64), phase: 'entered' }
    expect(() => validateWorkflowFrame({ ...base, revision: 1 }, 'schema', 'root')).not.toThrow()
    expect(() => validateWorkflowFrame({ ...base, parentFrameId: 'root', revision: 1 }, 'schema', 'root')).toThrow()
    expect(() => nextWorkflowFrame({ ...base, revision: 1 }, { ...base, parentFrameId: null }, 1)).toThrow()
  })
})
