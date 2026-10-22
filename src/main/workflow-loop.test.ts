import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowExpression, WorkflowLoopBlock, WorkflowControlFrame } from '../shared/workflow'
import { WorkflowRunner, WorkflowSlots, type WorkflowProviderExecution, type WorkflowProviderExecutionRequest, type WorkflowProviderExecutionResult } from './workflow-runner'
import { FileWorkflowStore } from './workflow-store'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { workflowFrameId } from './workflow-frames'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const ref = (name: string): WorkflowExpression => ({ kind: 'ref', name })
const field = (name: string, key: string): WorkflowExpression => ({ kind: 'field', source: ref(name), path: [key] })
const literal = (value: string | boolean): WorkflowExpression => ({ kind: 'literal', value })
const report: WorkflowBlock = { kind: 'return', blockId: 'report', ref: { nodeId: 'improve' } }
function loop(overrides: Partial<WorkflowLoopBlock> = {}): WorkflowLoopBlock {
  return { kind: 'loop', blockId: 'improve', initial: { candidate: literal('seed'), best: literal('seed') }, stateSchema: { candidate: { type: 'string' }, best: { type: 'string' } },
    invariants: { rubric: literal('frozen checks') }, iteration: 'round', best: 'best', outcome: 'loop_status', maxIterations: 3,
    body: { kind: 'call', blockId: 'step', role: 'worker', prompt: 'step', inputRefs: [{ nodeId: 'candidate' }, { nodeId: 'rubric' }], outputSchema: { type: 'object', properties: { candidate: { type: 'string' }, passed: { type: 'boolean' }, diagnostic: { type: 'string' }, better: { type: 'boolean' } }, required: ['candidate', 'passed', 'diagnostic', 'better'] } },
    until: field('step', 'passed'), carry: { candidate: field('step', 'candidate'), best: field('step', 'candidate') }, result: ref('best'), progress: 'bounded_only',
    policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' }, ...overrides }
}
async function fixture(block: WorkflowBlock, execute: (request: WorkflowProviderExecutionRequest) => WorkflowProviderExecution, after: WorkflowBlock[] = [report], storeFactory: (root: string) => FileWorkflowStore = root => new FileWorkflowStore(root)) {
  const root = await mkdtemp(join(tmpdir(), 'scry-workflow-loop-')); roots.push(root)
  const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-' + randomUUID(), programRevision: 'pending', userGoal: 'loop fixture', workspace: root, roles: [role], body: { kind: 'sequence', blockId: 'root', blocks: [block, ...after] } })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  const preview = makePlanPreview(program, [], role), store = storeFactory(root)
  const runner = new WorkflowRunner({ store, slots: new WorkflowSlots(2), execute })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  runner.approve(preview, approval)
  const frameId = workflowFrameId(block.blockId, ['revision:' + preview.programRevision])
  return { root, preview, store, runner, frameId, run: () => runner.start(preview, approval) }
}
const completed = (value: unknown): WorkflowProviderExecution => ({ result: Promise.resolve({ runId: randomUUID(), status: 'completed', settled: true, output: JSON.stringify(value) }), stop: () => true })
const step = (candidate: string, passed: boolean, diagnostic = 'A', better = false) => ({ candidate, passed, diagnostic, better })

describe('bounded logical loops through the single Interpreter/Runner', () => {
  it('feeds committed feedback into a different second iteration and preserves the controller-owned best state', async () => {
    let calls = 0
    const prompts: string[] = []
    const execute = vi.fn((request: WorkflowProviderExecutionRequest): WorkflowProviderExecution => {
      prompts.push(request.prompt); calls++
      return completed(step('candidate-' + calls, calls === 2, 'E' + calls, true))
    })
    const f = await fixture(loop(), execute)
    const progress = await f.run()
    expect(progress.state).toBe('completed')
    expect(progress.finalReport).toBe('candidate-2')
    expect(prompts[0]).toContain('seed')
    expect(prompts[1]).toContain('candidate-1')
    expect(progress.dispatchAttempts).toBe(2)
    const frame = await new FileWorkflowStore(f.root).loadFrame(f.preview.workflowId, f.frameId)
    expect(frame?.loop).toMatchObject({ iteration: 2, stage: 'committed', reasons: ['success'] })
    expect(frame?.loop?.iterations).toHaveLength(2)
    expect(await f.store.loadValue(f.preview.workflowId, frame!.loop!.initialStateRefs.best)).toMatchObject({ state: 'known', value: 'seed' })
    expect(await f.store.loadValue(f.preview.workflowId, frame!.loop!.bestRef!)).toMatchObject({ state: 'known', value: 'candidate-2' })
    const attempts = (await f.store.load(f.preview.workflowId))!.outcomes
    expect(new Set(attempts.map(value => value.taskId)).size).toBe(2)
    expect(new Set(attempts.map(value => value.attemptId)).size).toBe(2)
  })

  it('counts two unchanged rounds, not one, and does not use changing artifact hashes as progress', async () => {
    const execute = vi.fn(() => completed(step('same', false, 'A', false)))
    const f = await fixture(loop({ maxIterations: 4, progress: { baseline: literal('A'), key: field('step', 'diagnostic'), improved: field('step', 'better') } }), execute)
    const progress = await f.run()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(progress.state).toBe('blocked')
    expect(progress.finalReport).toBe('same')
    const frame = await f.store.loadFrame(f.preview.workflowId, f.frameId)
    expect(frame?.loop).toMatchObject({ iteration: 2, noProgress: 2, reasons: ['no_progress'] })
    expect(frame?.continuation).toBe('report_partial')
  })

  it('detects A→B→A oscillation separately from adjacent equality', async () => {
    let round = 0
    const execute = vi.fn(() => completed(step('candidate', false, ++round === 1 ? 'B' : 'A', true)))
    const f = await fixture(loop({ progress: { baseline: literal('A'), key: field('step', 'diagnostic'), improved: field('step', 'better') } }), execute)
    expect((await f.run()).state).toBe('blocked')
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await f.store.loadFrame(f.preview.workflowId, f.frameId))?.loop).toMatchObject({ noProgress: 0, reasons: ['oscillation'] })
  })

  it('permits an approved partial summary after exhaustion without turning the root green', async () => {
    const execute = vi.fn((request: WorkflowProviderExecutionRequest) => request.prompt.startsWith('summary') ? completed('partial summary') : completed(step('candidate', false)))
    const f = await fixture(loop({ maxIterations: 2 }), execute, [
      { kind: 'call', blockId: 'summary', role: 'worker', prompt: 'summary', inputRefs: [{ nodeId: 'improve' }, { nodeId: 'loop_status' }] },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'summary' } }
    ])
    const result = await f.run()
    expect(result.state).toBe('blocked')
    expect(result.finalReport).toBe('"partial summary"')
    expect(execute).toHaveBeenCalledTimes(3)
    expect((await f.store.loadFrame(f.preview.workflowId, f.frameId))?.loop?.reasons).toEqual(['exhausted'])
  })

  it('never treats a missing success condition as false or commits its carry', async () => {
    const block = loop()
    if (block.body.kind !== 'call' || block.body.outputSchema?.type !== 'object') throw new Error('bad fixture')
    block.body.outputSchema.required = ['candidate', 'diagnostic', 'better']
    const execute = vi.fn(() => completed({ candidate: 'must-not-carry', diagnostic: 'A', better: true }))
    const f = await fixture(block, execute)
    expect((await f.run()).state).toBe('blocked')
    expect(execute).toHaveBeenCalledTimes(1)
    const frame = await f.store.loadFrame(f.preview.workflowId, f.frameId)
    expect(frame?.loop?.reasons).toContain('unknown')
    expect(await f.store.loadValue(f.preview.workflowId, frame!.loop!.bestRef!)).toMatchObject({ state: 'known', value: 'seed' })
  })

  it('halts a known failed effect instead of using another logical iteration as a retry', async () => {
    const execute = vi.fn((): WorkflowProviderExecution => ({ result: Promise.resolve({ runId: 'failed', status: 'failed', settled: true, error: 'API failed' }), stop: () => true }))
    const f = await fixture(loop(), execute)
    expect((await f.run()).state).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await f.store.load(f.preview.workflowId))?.progress.dispatchAttempts).toBe(1)
  })

  it('retains child completion and refuses a new iteration if its state checkpoint cannot commit', async () => {
    class CutCommitStore extends FileWorkflowStore {
      override async saveFrame(input: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
        if (input.nodeId === 'improve' && input.loop?.iteration === 1 && input.loop.stage === 'committed') throw new Error('fixture iteration checkpoint failure')
        return super.saveFrame(input, revision)
      }
    }
    const execute = vi.fn(() => completed(step('candidate', false)))
    const f = await fixture(loop(), execute, [report], root => new CutCommitStore(root))
    await expect(f.run()).rejects.toThrow('checkpoint failure')
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await f.store.loadFrame(f.preview.workflowId, f.frameId))?.loop).toMatchObject({ iteration: 1, stage: 'ready' })
    expect((await f.store.load(f.preview.workflowId))?.outcomes[0]).toMatchObject({ state: 'completed', settled: true })
  })

  it('retains accepted stop and late success as separate facts without committing another state or round', async () => {
    let started!: () => void, resolve!: (result: WorkflowProviderExecutionResult) => void
    const began = new Promise<void>(done => { started = done })
    const pending = new Promise<WorkflowProviderExecutionResult>(done => { resolve = done })
    const execute = vi.fn((): WorkflowProviderExecution => { started(); return { result: pending, stop: () => true } })
    const f = await fixture(loop(), execute)
    const running = f.run()
    await began
    const live = await f.store.loadFrame(f.preview.workflowId, f.frameId)
    const changed = await f.store.saveValue(f.preview.workflowId, 'changed-rubric', { state: 'known', value: 'other contract', derivedFrom: [] })
    await expect(f.store.saveFrame({ ...live!, loop: { ...live!.loop!, invariantRefs: { rubric: changed } } }, live!.revision)).rejects.toThrow('固定合同')
    expect(await f.runner.requestStop(f.preview.workflowId, 'stop-loop')).toBe(true)
    resolve({ runId: 'late-success', status: 'completed', settled: true, output: JSON.stringify(step('late candidate', true)) })
    expect((await running).state).toBe('stopped')
    expect(execute).toHaveBeenCalledTimes(1)
    const frame = await f.store.loadFrame(f.preview.workflowId, f.frameId)
    expect(frame?.loop?.reasons).toEqual(expect.arrayContaining(['success', 'stopped']))
    expect(await f.store.loadValue(f.preview.workflowId, frame!.loop!.bestRef!)).toMatchObject({ state: 'known', value: 'seed' })
  })

  it('does not replay a physically closed call whose business outcome remains unknown', async () => {
    const execute = vi.fn((): WorkflowProviderExecution => ({ result: Promise.resolve({ runId: 'unknown', status: 'unknown', settled: true }), stop: () => true }))
    const f = await fixture(loop(), execute)
    expect((await f.run()).state).toBe('unknown')
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await f.store.loadFrame(f.preview.workflowId, f.frameId))?.loop?.reasons).toContain('unknown')
    expect((await f.store.load(f.preview.workflowId))?.intents).toHaveLength(1)
  })

  it.each(['parallel', 'branch', 'map'] as const)('keeps partial status through %s while allowing the approved root report', async kind => {
    const item = loop({ maxIterations: 1 })
    let block: WorkflowBlock, after: WorkflowBlock[] = [report]
    if (kind === 'parallel') block = { kind, blockId: 'fan', blocks: [item] }
    else if (kind === 'branch') {
      block = { kind, blockId: 'choice', when: literal(true), then: item, else: { kind: 'bind', blockId: 'unused', value: literal('unused') }, unknown: 'blocked' }
      after = [{ kind: 'return', blockId: 'report', ref: { nodeId: 'choice', path: ['value'] } }]
    } else {
      block = { kind: 'sequence', blockId: 'batch', blocks: [
        { kind: 'bind', blockId: 'input', value: { kind: 'literal', value: [{ id: 'one' }] } },
        { kind, blockId: 'mapped', items: ref('input'), item: 'entry', key: ['id'], maxItems: 1, body: item }
      ] }
      after = [{ kind: 'collect', blockId: 'collected', items: ref('mapped') }, { kind: 'return', blockId: 'report', ref: { nodeId: 'collected' } }]
    }
    const f = await fixture(block, () => completed(step('partial candidate', false)), after)
    const result = await f.run()
    expect(result.state).toBe('blocked')
    expect(result.finalReportStatus).toBe('available')
    expect(result.finalReport).toContain('partial candidate')
  })

  it('carries host collection metadata by immutable binding reference without copying or forging it', async () => {
    const item = loop({ initial: { candidate: literal('seed'), best: literal('seed'), items: ref('mapped') },
      stateSchema: { candidate: { type: 'string' }, best: { type: 'string' }, items: 'inferred' },
      body: { kind: 'bind', blockId: 'passed', value: literal(true) }, until: ref('passed'),
      carry: { candidate: ref('candidate'), best: ref('best'), items: ref('items') }, result: ref('items') })
    const batch: WorkflowBlock = { kind: 'sequence', blockId: 'batch', blocks: [
      { kind: 'bind', blockId: 'input', value: { kind: 'literal', value: ['a', 'b'] } },
      { kind: 'map', blockId: 'mapped', items: ref('input'), item: 'entry', key: [], maxItems: 2, body: { kind: 'bind', blockId: 'copy', value: ref('entry') } }, item
    ] }
    const execute = vi.fn(() => completed(step('unused', true)))
    const f = await fixture(batch, execute, [{ kind: 'collect', blockId: 'collected', items: ref('improve') }, { kind: 'return', blockId: 'report', ref: { nodeId: 'collected' } }])
    const result = await f.run()
    expect(result.state).toBe('completed')
    expect(JSON.parse(result.finalReport!).map((value: { value: string }) => value.value)).toEqual(['a', 'b'])
    expect(execute).not.toHaveBeenCalled()
    const frame = await f.store.loadFrame(f.preview.workflowId, workflowFrameId('improve', ['revision:' + f.preview.programRevision]))
    const value = await new FileWorkflowStore(f.root).loadValue(f.preview.workflowId, frame!.loop!.stateRefs.items)
    expect(value.state === 'known' && value.collection?.sealed).toBe(true)
  })

  it('records simultaneous success and the visible round boundary without inventing an extra attempt', async () => {
    const execute = vi.fn(() => completed(step('unused', false)))
    const f = await fixture(loop({ maxIterations: 1, body: { kind: 'bind', blockId: 'passed', value: literal(true) }, until: ref('passed'), carry: { candidate: ref('candidate'), best: ref('best') } }), execute)
    expect((await f.run()).state).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect((await f.store.loadFrame(f.preview.workflowId, f.frameId))?.loop?.reasons).toEqual(['success', 'exhausted'])
  })

  it('rejects bare loops, scope mutation, incompatible carry and missing explicit policies before dispatch', async () => {
    const execute = vi.fn(() => completed(step('unused', true)))
    await expect(fixture(loop({ maxIterations: 0 }), execute)).rejects.toThrow('循环轮数')
    await expect(fixture(loop({ carry: { candidate: literal(false), best: literal('seed') } }), execute)).rejects.toThrow('类型合同')
    await expect(fixture(loop({ iteration: 'candidate' }), execute)).rejects.toThrow('已存在')
    await expect(fixture(loop({ policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'bad' } as unknown as WorkflowLoopBlock['policy'] }), execute)).rejects.toThrow('策略')
    expect(execute).not.toHaveBeenCalled()
  })
})
