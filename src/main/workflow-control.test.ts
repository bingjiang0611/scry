import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowRunner, WorkflowSlots, type WorkflowProviderExecutionRequest } from './workflow-runner'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { workflowFrameId } from './workflow-frames'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'scry-workflow-control-')); roots.push(root); return root }
const known = (value: Extract<WorkflowEvaluation, { state: 'known' }>['value']): WorkflowEvaluation => ({ state: 'known', value, derivedFrom: [] })
const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
function plan(body: WorkflowBlock, id = 'workflow-' + randomUUID()) {
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: 'controlled execution', workspace: '/fixture', roles: [role], body })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  return makePlanPreview(program, [], role)
}
function frame(workflowId = 'workflow-frame-test'): Omit<WorkflowControlFrame, 'revision'> {
  return { schemaVersion: 1, workflowId, programRevision: 'revision-test', frameId: 'node', nodeId: 'node', scopePath: [], inputKey: '0'.repeat(64), phase: 'entered' }
}

describe('durable control/value store', () => {
  it('serializes CAS across independent store objects, not just one in-memory queue', async () => {
    const root = await temporary(), first = new FileWorkflowStore(root), second = new FileWorkflowStore(root)
    const results = await Promise.allSettled([first.saveFrame(frame(), 0), second.saveFrame(frame(), 0)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await new FileWorkflowStore(root).loadFrame('workflow-frame-test', 'node')).toMatchObject({ phase: 'entered', revision: 1 })
  })
  it('refuses a selected frame without its decision or a terminal frame without its result artifact', async () => {
    const store = new FileWorkflowStore(await temporary())
    await expect(store.saveFrame({ ...frame(), phase: 'selected' }, 0)).rejects.toThrow('合同无效')
    await expect(store.saveFrame({ ...frame(), phase: 'completed' }, 0)).rejects.toThrow('合同无效')
    await expect(store.saveFrame({ ...frame(), phase: 'unknown' }, 0)).rejects.toThrow('合同无效')
    expect(await store.loadFrame('workflow-frame-test', 'node')).toBeUndefined()
  })

  it('keeps the committed choice/input immutable and forbids terminal rewrites', async () => {
    const store = new FileWorkflowStore(await temporary()), initial = await store.saveFrame(frame(), 0)
    const decisionRef = await store.saveValue(initial.workflowId, 'decision', known(false))
    const selected = await store.saveFrame({ ...initial, phase: 'selected', arm: 'else', decisionRef }, 1)
    await expect(store.saveFrame({ ...selected, arm: 'then' }, 2)).rejects.toThrow('选择不可改写')
    await expect(store.saveFrame({ ...selected, inputKey: '1'.repeat(64) }, 2)).rejects.toThrow('身份已变化')
    const resultRef = await store.saveValue(initial.workflowId, 'result', known({ arm: 'else', value: false }))
    const completed = await store.saveFrame({ ...selected, phase: 'completed', resultRef }, 2)
    await expect(store.saveFrame({ ...completed, phase: 'entered' }, 3)).rejects.toThrow('不可改写')
    expect(await store.loadValue(initial.workflowId, completed.resultRef!)).toMatchObject({ state: 'known', value: { arm: 'else', value: false } })
  })
  it('cannot reset an unknown frame to admission or erase a selected choice', async () => {
    const store = new FileWorkflowStore(await temporary()), initial = await store.saveFrame(frame(), 0)
    const decisionRef = await store.saveValue(initial.workflowId, 'decision', known(true))
    const selected = await store.saveFrame({ ...initial, phase: 'selected', arm: 'then', decisionRef }, 1)
    await expect(store.saveFrame({ ...selected, phase: 'entered' }, 2)).rejects.toThrow('选择不可改写')
    const resultRef = await store.saveValue(initial.workflowId, 'result', { state: 'unknown', reason: 'native result unavailable', derivedFrom: ['attempt-1'] })
    const unknown = await store.saveFrame({ ...selected, phase: 'unknown', resultRef }, 2)
    await expect(store.saveFrame({ ...unknown, phase: 'entered' }, 3)).rejects.toThrow('不可改写')
    await expect(store.saveFrame({ ...unknown, phase: 'completed' }, 3)).rejects.toThrow('不可改写')
  })

  it('verifies immutable content and workflow containment; missing is never null/empty', async () => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const ref = await store.saveValue('workflow-value-test', 'data', known({ zero: 0, flag: false, nil: null }))
    expect(await new FileWorkflowStore(root).loadValue(ref.workflowId, ref)).toMatchObject({ state: 'known', value: { zero: 0, flag: false, nil: null } })
    await expect(store.loadValue('another-workflow', ref)).rejects.toThrow('引用身份')
    const files = await readdir(join(root, 'workflows'))
    await appendFile(join(root, 'workflows', files.find(file => file.endsWith('.value.json'))!), ' ')
    await expect(store.loadValue(ref.workflowId, ref)).rejects.toThrow('校验失败')
    await expect(store.loadValue(ref.workflowId, { ...ref, hash: '1'.repeat(64) })).rejects.toThrow('缺失')
    await expect(store.saveValue(ref.workflowId, 'bad', known(NaN))).rejects.toThrow()
  })
  it('supports maximum authorized IDs without exceeding filesystem component bounds', async () => {
    const root = await temporary(), store = new FileWorkflowStore(root)
    const ref = await store.saveValue('w'.repeat(96), 'k'.repeat(96), known([]))
    expect(await store.loadValue(ref.workflowId, ref)).toMatchObject({ state: 'known', value: [] })
    expect((await readdir(join(root, 'workflows'))).every(file => Buffer.byteLength(file) <= 255)).toBe(true)
  })
})

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
