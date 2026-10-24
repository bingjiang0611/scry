import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowControlFrame } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowRunner, WorkflowSlots, type WorkflowProviderExecutionRequest } from './workflow-runner'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import { WorkflowControl } from './workflow-control'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'scry-workflow-control-')); roots.push(root); return root }
const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
function plan(body: WorkflowBlock, id = 'workflow-' + randomUUID()) {
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: 'controlled execution', workspace: '/fixture', roles: [role], body })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  return makePlanPreview(program, [], role)
}

const branch = (condition: Extract<WorkflowBlock, { kind: 'branch' }>['when'], unknown: Extract<WorkflowBlock, { kind: 'branch' }>['unknown'] = 'blocked'): WorkflowBlock => ({
  kind: 'branch', blockId: 'choice', when: condition,
  then: { kind: 'call', blockId: 'then_worker', role: 'worker', prompt: 'then work' },
  else: { kind: 'call', blockId: 'else_worker', role: 'worker', prompt: 'else work' }, unknown
})
const result = (nodeId: string, path?: string[]): WorkflowBlock => ({ kind: 'return', blockId: 'report', ref: { nodeId, ...(path ? { path } : {}) } })

describe('typed branch and binding execution through production Runner/store', () => {
  it.each([true, false])('commits %s choice before dispatch, runs only the chosen arm and retains skipped markers', async flag => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'flag', value: { kind: 'literal', value: flag } },
      branch({ kind: 'ref', name: 'flag' }), result('choice', ['value'])
    ] })
    const path = ['revision:' + preview.programRevision], branchId = workflowFrameId('choice', path)
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => ({ result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, output: 'chosen result', settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, slots: new WorkflowSlots(1), execute, beforeDispatch: async () => {
      const independent = new FileWorkflowStore(root)
      const checkpoint = await independent.loadFrame(preview.workflowId, workflowFrameId('root', path))
      expect(checkpoint).toMatchObject({ phase: 'entered', cursor: 1 })
      expect(checkpoint?.children).toHaveLength(1)
      expect(await new WorkflowControl(independent, preview).readCommitted(checkpoint!.children![0])).toMatchObject({ state: 'known', value: flag })
      const frozen = await independent.loadFrame(preview.workflowId, branchId)
      expect(frozen).toMatchObject({ phase: 'selected', arm: flag ? 'then' : 'else' })
      expect(await independent.loadValue(preview.workflowId, frozen!.decisionRef!)).toMatchObject({ state: 'known', value: flag })
    } })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    const progress = await runner.start(preview, approval)
    expect(progress.state).toBe('completed')
    expect(progress.finalReport).toBe('chosen result')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0].prompt).toBe(flag ? 'then work' : 'else work')
    const completed = await new FileWorkflowStore(root).loadFrame(preview.workflowId, branchId)
    expect(completed).toMatchObject({ phase: 'completed', arm: flag ? 'then' : 'else', revision: 3 })
    const skippedArm = flag ? 'else' : 'then'
    const skippedId = workflowFrameId(skippedArm + '_worker', [...path, 'choice:' + skippedArm + ':' + completed!.decisionRef!.hash])
    expect(await store.loadFrame(preview.workflowId, skippedId)).toMatchObject({ phase: 'skipped_by_condition' })
    expect((await store.listPage()).records).toHaveLength(1)
  })

  it('references direct immutable predecessors instead of flattening the whole provenance chain', async () => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'seed', value: { kind: 'literal', value: false } },
      { kind: 'bind', blockId: 'second', value: { kind: 'ref', name: 'seed' } },
      { kind: 'bind', blockId: 'third', value: { kind: 'ref', name: 'second' } }, result('third')
    ] })
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'must-not-run', status: 'completed' as const, output: 'unexpected', settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, execute })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    expect((await runner.start(preview, approval)).finalReport).toBe('false')
    expect(execute).not.toHaveBeenCalled()
    const scope = ['revision:' + preview.programRevision]
    const frames = await Promise.all(['seed', 'second', 'third'].map(name => store.loadFrame(preview.workflowId, workflowFrameId(name, scope))))
    const third = await new FileWorkflowStore(root).loadValue(preview.workflowId, frames[2]!.resultRef!)
    expect(third.derivedFrom).toEqual([`value:${frames[1]!.resultRef!.key}:${frames[1]!.resultRef!.hash}`, 'second'])
    expect(third.derivedFrom).not.toContain(`value:${frames[0]!.resultRef!.key}:${frames[0]!.resultRef!.hash}`)
  })

  it('keeps an optional missing boolean unknown, never dispatches either boolean arm', async () => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'probe', role: 'worker', prompt: 'source', outputSchema: { type: 'object', properties: { flag: { type: 'boolean' } }, required: [] } },
      branch({ kind: 'field', source: { kind: 'ref', name: 'probe' }, path: ['flag'] }), result('choice', ['value'])
    ] })
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => ({ result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, output: '{}', settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, execute })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    const progress = await runner.start(preview, approval)
    expect(progress.state).toBe('blocked')
    expect(progress.finalReportStatus).toBe('unavailable')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(progress.dispatchAttempts).toBe(1)
    const frozen = await store.loadFrame(preview.workflowId, workflowFrameId('choice', ['revision:' + preview.programRevision]))
    expect(frozen).toMatchObject({ phase: 'blocked', arm: 'unknown' })
    expect(await store.loadValue(preview.workflowId, frozen!.decisionRef!)).toMatchObject({ state: 'unknown' })
  })

  it('permits an explicit unknown report arm without pretending it selected false', async () => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'probe', role: 'worker', prompt: 'source', outputSchema: { type: 'object', properties: { flag: { type: 'boolean' } }, required: [] } },
      branch({ kind: 'field', source: { kind: 'ref', name: 'probe' }, path: ['flag'] }, { kind: 'bind', blockId: 'unknown_report', value: { kind: 'literal', value: { status: 'partial', reason: 'missing evidence' } } }), result('choice')
    ] })
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'probe-result', status: 'completed' as const, output: '{}', settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, execute })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    const progress = await runner.start(preview, approval)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(JSON.parse(progress.finalReport!)).toEqual({ arm: 'unknown', value: { status: 'partial', reason: 'missing evidence' } })
  })

  it('rejects truthy conditions, missing unknown policy, unselected/private outputs and sibling reads', () => {
    expect(() => plan({ kind: 'sequence', blockId: 'root', blocks: [branch({ kind: 'literal', value: 1 }), result('choice')] })).toThrow('布尔')
    const withMissingUnknown = { ...branch({ kind: 'literal', value: true }), unknown: undefined }
    expect(() => plan({ kind: 'sequence', blockId: 'root', blocks: [withMissingUnknown as WorkflowBlock, result('choice')] })).toThrow('unknown')
    expect(() => plan({ kind: 'sequence', blockId: 'root', blocks: [branch({ kind: 'literal', value: true }), result('then_worker')] })).toThrow('前置')
    expect(() => plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'parallel', blockId: 'fork', blocks: [
        { kind: 'bind', blockId: 'left', value: { kind: 'literal', value: true } },
        { kind: 'bind', blockId: 'right', value: { kind: 'ref', name: 'left' } }
      ] }, result('fork')
    ] })).toThrow('left')
  })
  it('does not dispatch if the durable choice checkpoint fails after writing its value artifact', async () => {
    class CutChoiceStore extends FileWorkflowStore {
      override async saveFrame(input: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
        if (input.phase === 'selected') throw new Error('fixture choice checkpoint failure')
        return super.saveFrame(input, revision)
      }
    }
    const root = await temporary(), store = new CutChoiceStore(root)
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [branch({ kind: 'literal', value: true }), result('choice')] })
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'must-not-run', status: 'completed' as const, output: 'unsafe success', settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, execute })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    await expect(runner.start(preview, approval)).rejects.toThrow('checkpoint failure')
    expect(execute).not.toHaveBeenCalled()
    const saved = await store.load(preview.workflowId)
    expect(saved?.intents).toEqual([])
    expect(saved?.progress.dispatchAttempts).toBe(0)
    expect(saved?.progress.state).toBe('failed')
    expect(await new FileWorkflowStore(root).loadFrame(preview.workflowId, workflowFrameId('choice', ['revision:' + preview.programRevision]))).toMatchObject({ phase: 'entered', revision: 1 })
  })

  it('does not advance to the next execution when the bundled result checkpoint fails', async () => {
    class CutResultStore extends FileWorkflowStore {
      override async saveFrameWithValue(): Promise<WorkflowControlFrame> { throw new Error('fixture bundled result checkpoint failure') }
    }
    const root = await temporary(), store = new CutResultStore(root)
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first effect' },
      { kind: 'call', blockId: 'second', role: 'worker', prompt: 'must not run' }, result('second', [])
    ] })
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => ({ result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, output: 'first result', settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, execute })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    await expect(runner.start(preview, approval)).rejects.toThrow('fixture bundled result checkpoint failure')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0].prompt).toBe('first effect')
  })

  it('keeps the completed child receipt when advancing its parent fails, and never dispatches the next child', async () => {
    class CutAdvanceStore extends FileWorkflowStore {
      override async saveFrame(input: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
        if (input.nodeId === 'root' && input.cursor === 1 && input.phase === 'entered') throw new Error('fixture cursor checkpoint failure')
        return super.saveFrame(input, revision)
      }
    }
    const root = await temporary(), store = new CutAdvanceStore(root)
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first effect', outputSchema: { type: 'boolean' } },
      { kind: 'call', blockId: 'second', role: 'worker', prompt: 'must not run' }, result('second', [])
    ] })
    const execute = vi.fn(() => ({ result: Promise.resolve({ runId: 'first-result', status: 'completed' as const, output: 'false', settled: true }), stop: () => true }))
    const runner = new WorkflowRunner({ store, execute })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    runner.approve(preview, approval)
    await expect(runner.start(preview, approval)).rejects.toThrow('cursor checkpoint failure')
    expect(execute).toHaveBeenCalledTimes(1)
    const independent = new FileWorkflowStore(root)
    const saved = await independent.load(preview.workflowId)
    expect(saved?.intents).toHaveLength(1)
    expect(saved?.outcomes).toHaveLength(1)
    expect(saved?.outcomes[0]).toMatchObject({ state: 'completed', settled: true })
    const child = await independent.loadFrame(preview.workflowId, workflowFrameId('first', ['revision:' + preview.programRevision]))
    expect(child).toMatchObject({ phase: 'completed' })
    const reference = { frameId: child!.frameId, revision: child!.revision, resultRef: child!.resultRef! }
    const control = new WorkflowControl(independent, preview)
    expect(await control.readCommitted(reference)).toMatchObject({ state: 'known', value: false })
    await expect(control.readCommitted({ ...reference, revision: reference.revision + 1 })).rejects.toThrow('身份')
    expect(await independent.loadFrame(preview.workflowId, workflowFrameId('root', ['revision:' + preview.programRevision]))).toMatchObject({ phase: 'entered', revision: 1 })
  })

  it('accepts a sealed literal empty collection without turning a missing source into empty', () => {
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'empty', value: { kind: 'group', items: { kind: 'literal', value: [] }, key: ['id'] } }, result('empty')
    ] })
    expect(preview.plannedCalls).toBe(0)
    expect(() => plan({ kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'empty', value: { kind: 'group', items: { kind: 'ref', name: 'missing' }, key: ['id'] } }, result('empty')
    ] })).toThrow('missing')
  })

  it('bounds exclusive branch calls by the largest arm, not both arms summed', () => {
    const preview = plan({ kind: 'sequence', blockId: 'root', blocks: [branch({ kind: 'literal', value: true }), result('choice')] })
    expect(preview.plannedCalls).toBe(1)
  })
})
