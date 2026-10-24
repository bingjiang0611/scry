import { describe, expect, it, vi } from 'vitest'
import { makePlanPreview, validateWorkflowProgram } from './workflow-program'
import { assertWorkflowFrozenRevision } from './workflow-revisions'
import { workflowFixtureApproval } from './workflow-runner.fixture'
import { WorkflowRunner } from './workflow-runner'
import { MemoryWorkflowStore } from './workflow-store'

function fixture() {
  return makePlanPreview(validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-immutable', programRevision: 'pending',
    userGoal: 'immutable governing source', workspace: '/fixture',
    roles: [{ role: 'worker', providerId: 'codex' }], body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'value', schema: { type: 'string' }, value: { kind: 'literal', value: 'original' } },
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'value' } }
    ] } }), [], { role: 'orchestrator', providerId: 'codex' })
}

describe('governing revision immutable validation cache', () => {
  it('deep-freezes validated source, including an externally shallow-frozen body', () => {
    const plan = fixture()
    workflowFixtureApproval(plan)
    Object.freeze(plan.program.body)
    assertWorkflowFrozenRevision(plan)
    expect(Object.isFrozen(plan.program)).toBe(true)
    if (plan.program.body.kind !== 'sequence') throw new Error('fixture shape')
    expect(Object.isFrozen(plan.program.body.blocks)).toBe(true)
    expect(Object.isFrozen(plan.program.body.blocks[0])).toBe(true)
    expect(Reflect.set(plan.program.body.blocks[0], 'blockId', 'mutated')).toBe(false)
    assertWorkflowFrozenRevision(plan)
  })

  it('revalidates clones and replacement programs and still checks outer identity on a cache hit', () => {
    const plan = fixture()
    workflowFixtureApproval(plan)
    assertWorkflowFrozenRevision(plan)
    const changed = structuredClone(plan)
    changed.program.userGoal = 'tampered'
    expect(() => assertWorkflowFrozenRevision(changed)).toThrow()
    const replaced = { ...plan, program: changed.program }
    expect(() => assertWorkflowFrozenRevision(replaced)).toThrow()
    plan.workspace = '/different'
    expect(() => assertWorkflowFrozenRevision(plan)).toThrow()
  })

  it('keeps public MemoryStore loads independent despite private frozen-source sharing', async () => {
    const plan = fixture(), approval = workflowFixtureApproval(plan)
    const store = new MemoryWorkflowStore(), execute = vi.fn(() => { throw new Error('unexpected dispatch') })
    const runner = new WorkflowRunner({ store, execute })
    runner.approve(plan, approval)
    expect((await runner.start(plan, approval)).state).toBe('completed')
    const first = (await store.load(plan.workflowId))!, second = (await store.load(plan.workflowId))!
    first.preview.program.userGoal = 'tampered load'
    first.revisions![0].preview.program.userGoal = 'tampered history'
    expect(second.preview.program.userGoal).toBe('immutable governing source')
    expect(second.revisions![0].preview.program.userGoal).toBe('immutable governing source')
    expect((await store.load(plan.workflowId))!.preview.program.userGoal).toBe('immutable governing source')
    expect(() => assertWorkflowFrozenRevision(first.preview)).toThrow()
    expect(execute).not.toHaveBeenCalled()
  })
})
