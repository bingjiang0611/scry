import { describe, expect, it } from 'vitest'
import type { WorkflowBlock, WorkflowLoopBlock } from '../shared/workflow'
import { call, fixture, revision } from './workflow-revision.fixture'

const loop: WorkflowLoopBlock = {
  kind: 'loop', blockId: 'refine', initial: { candidate: { kind: 'literal', value: 'seed' } }, stateSchema: { candidate: { type: 'string' } },
  invariants: { rubric: { kind: 'literal', value: 'fixed rubric' } }, iteration: 'round', outcome: 'loopStatus', maxIterations: 3,
  body: { ...call('step'), inputRefs: [{ nodeId: 'candidate' }, { nodeId: 'rubric' }], outputSchema: { type: 'object', properties: { candidate: { type: 'string' }, passed: { type: 'boolean' } }, required: ['candidate', 'passed'] } },
  until: { kind: 'field', source: { kind: 'ref', name: 'step' }, path: ['passed'] },
  carry: { candidate: { kind: 'field', source: { kind: 'ref', name: 'step' }, path: ['candidate'] } },
  result: { kind: 'ref', name: 'candidate' }, progress: 'bounded_only', policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' }
}
const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [call('independent'), loop,
  { kind: 'bind', blockId: 'unused', value: { kind: 'literal', value: 'v1' } }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'refine' } }] }

describe('bounded loop revision input/state provenance', () => {
  it('reuses unchanged iterations and reruns the affected carry iteration, without skipping or mixing old carries', async () => {
    const f = await fixture(true, true, true, body)
    try {
      const original = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => {
        const native = original(request)
        if (!request.taskId.endsWith(':step')) return native
        const candidate = request.prompt.includes('\nseed\n') ? 'one' : request.prompt.includes('\none\n') ? 'two' : 'done'
        return { ...native, result: native.result.then(result => ({ ...result, output: JSON.stringify({ candidate, passed: candidate === 'done' }) })) }
      })
      expect(await f.start()).toMatchObject({ state: 'completed', dispatchAttempts: 4, finalReport: 'done' })
      const unchanged = revision(f.preview, root => {
        if (root.kind !== 'sequence' || root.blocks[2].kind !== 'bind') throw new Error('fixture shape')
        root.blocks[2].value = { kind: 'literal', value: 'v2' }
      })
      expect(await f.revise(unchanged, 'same-loop')).toMatchObject({ state: 'completed', dispatchAttempts: 4, finalReport: 'done' })
      expect(f.calls.filter(value => value.node === 'step')).toHaveLength(3)
      const changed = revision(unchanged, root => {
        if (root.kind !== 'sequence' || root.blocks[1].kind !== 'loop') throw new Error('fixture shape')
        root.blocks[1].carry.candidate = { kind: 'literal', value: 'two' }
      })
      expect(await f.revise(changed, 'changed-carry')).toMatchObject({ state: 'completed', dispatchAttempts: 5, finalReport: 'two' })
      const steps = f.calls.filter(value => value.node === 'step')
      expect(steps).toHaveLength(4)
      expect(steps.at(-1)?.prompt).toContain('\ntwo\n')
      expect(steps.filter(value => value.prompt.includes('\nseed\n'))).toHaveLength(1)
      expect(steps.filter(value => value.prompt.includes('\none\n'))).toHaveLength(1)
      expect(f.calls.filter(value => value.node === 'independent')).toHaveLength(1)
      const record = await f.record()
      expect(record.revisions).toHaveLength(3)
      expect(record.intents).toHaveLength(5)
      expect(record.revisions?.every(value => value.reuse.length === 0)).toBe(true)
    } finally { await f.cleanup() }
  })

  it.each(['initial', 'control'] as const)('does not reuse an earlier iteration under changed loop %s', async mode => {
    const f = await fixture(true, true, true, body)
    try {
      const original = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => {
        const native = original(request)
        return request.taskId.endsWith(':step') ? { ...native, result: native.result.then(result => ({ ...result, output: JSON.stringify({ candidate: 'done', passed: true }) })) } : native
      })
      expect((await f.start()).dispatchAttempts).toBe(2)
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence' || root.blocks[1].kind !== 'loop') throw new Error('fixture shape')
        if (mode === 'initial') root.blocks[1].initial.candidate = { kind: 'literal', value: 'changed seed' }
        else root.blocks[1].maxIterations = 2
      })
      expect((await f.revise(next)).dispatchAttempts).toBe(3)
      expect(f.calls.filter(value => value.node === 'step').at(-1)?.prompt).toContain(mode === 'initial' ? 'changed seed' : 'seed')
      expect(f.calls.filter(value => value.node === 'independent')).toHaveLength(1)
    } finally { await f.cleanup() }
  })
})
