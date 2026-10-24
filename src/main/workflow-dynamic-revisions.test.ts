import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkflowBlock, WorkflowExpression, WorkflowValue } from '../shared/workflow'
import { call, fixture, revision } from './workflow-revision.fixture'

const literal = (value: WorkflowValue): WorkflowExpression => ({ kind: 'literal', value })
const field = (name: string, ...path: string[]): WorkflowExpression => ({ kind: 'field', source: { kind: 'ref', name }, path })
const report = (nodeId: string): WorkflowBlock => ({ kind: 'return', blockId: 'finish', ref: { nodeId } })
const root = (...blocks: WorkflowBlock[]): WorkflowBlock => ({ kind: 'sequence', blockId: 'root', blocks })
const bind = (blockId: string, value: WorkflowValue): WorkflowBlock => ({ kind: 'bind', blockId, value: literal(value) })
const mapped = (blockId: string, items: WorkflowExpression, item: string, body: WorkflowBlock): WorkflowBlock => ({ kind: 'map', blockId, items, item, key: ['id'], maxItems: 4, body })
const collect = (nodeId: string): WorkflowBlock => ({ kind: 'collect', blockId: 'collected', items: { kind: 'ref', name: nodeId } })
const selected = (nodeId: string, ...path: string[]) => ({ nodeId, path })

describe('dynamic same-root revision facts', () => {
  it('retains an unchanged selected arm across revision prefixes and never dispatches a removed arm', async () => {
    const branch: WorkflowBlock = { kind: 'branch', blockId: 'choice', when: { kind: 'ref', name: 'flag' }, then: call('yes'), else: call('no'), unknown: 'blocked' }
    const f = await fixture(true, true, true, root(call('independent'), bind('flag', true), branch, call('tail', 'choice'), report('tail')))
    try {
      expect((await f.start()).dispatchAttempts).toBe(3)
      const unchanged = revision(f.preview, body => {
        if (body.kind !== 'sequence' || body.blocks[2].kind !== 'branch' || body.blocks[2].else.kind !== 'call') throw new Error('fixture shape')
        body.blocks[2].else.prompt = 'unused-arm-v2'
      })
      expect((await f.revise(unchanged, 'same-arm')).dispatchAttempts).toBe(3)
      const changed = revision(unchanged, body => {
        if (body.kind !== 'sequence' || body.blocks[1].kind !== 'bind' || body.blocks[2].kind !== 'branch') throw new Error('fixture shape')
        body.blocks[1].value = literal(false)
        body.blocks[2].then = { kind: 'bind', blockId: 'removedArm', value: literal('not executed') }
      })
      expect((await f.revise(changed, 'changed-arm')).dispatchAttempts).toBe(5)
      expect(f.calls.filter(value => value.node === 'independent')).toHaveLength(1)
      expect(f.calls.filter(value => value.node === 'yes')).toHaveLength(1)
      expect(f.calls.filter(value => value.node === 'no')).toHaveLength(1)
      expect((await f.record()).revisions?.at(-1)?.reuse).toEqual([])
    } finally { await f.cleanup() }
  })

  it('matches stable map keys, reruns only the changed item and its consumer, and collects current ordered facts', async () => {
    const rows = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }]
    const pipeline: WorkflowBlock = { kind: 'sequence', blockId: 'pipeline', blocks: [
      { ...call('scan'), inputRefs: [selected('entry')] }, call('review', 'scan')
    ] }
    const f = await fixture(true, true, true, root(bind('rows', rows), mapped('jobs', { kind: 'ref', name: 'rows' }, 'entry', pipeline), collect('jobs'), report('collected')))
    try {
      expect((await f.start()).dispatchAttempts).toBe(6)
      const next = revision(f.preview, body => {
        if (body.kind !== 'sequence' || body.blocks[0].kind !== 'bind') throw new Error('fixture shape')
        body.blocks[0].value = literal([rows[2], rows[0], { id: 'b', text: 'B2' }])
      })
      const result = await f.revise(next)
      expect(result.dispatchAttempts).toBe(8)
      expect(f.calls.filter(value => value.node === 'scan')).toHaveLength(4)
      expect(f.calls.filter(value => value.node === 'review')).toHaveLength(4)
      expect(f.calls.filter(value => value.node === 'scan').at(-1)?.prompt).toContain('B2')
      const values = JSON.parse(result.finalReport!)
      expect(values.map((value: { key: string }) => value.key)).toEqual(['c', 'a', 'b'])
      expect(values.every((value: { state: string; settled: boolean }) => value.state === 'completed' && value.settled)).toBe(true)
      expect(values[2].value).toContain('B2')
      const original = (await f.record()).intents.slice(0, 6)
      expect(original.filter(intent => intent.callFrameId)).toHaveLength(6)
      const bodyChange = revision(next, body => {
        if (body.kind !== 'sequence' || body.blocks[1].kind !== 'map' || body.blocks[1].body.kind !== 'sequence' || body.blocks[1].body.blocks[1].kind !== 'call') throw new Error('fixture shape')
        body.blocks[1].body.blocks[1].prompt = 'review-v2'
      })
      expect((await f.revise(bodyChange, 'consumer-change')).dispatchAttempts).toBe(11)
      expect(f.calls.filter(value => value.node === 'scan')).toHaveLength(4)
      expect(f.calls.filter(value => value.node === 'review')).toHaveLength(7)
    } finally { await f.cleanup() }
  })

  it.each(['unused', 'consumed', 'ancestor-key'] as const)('keys nested maps on actual dependencies: %s outer change', async mode => {
    const innerCall: WorkflowBlock = { ...call('innerWork'), inputRefs: [selected('inner', 'text'), ...(mode === 'consumed' ? [selected('outer', 'unused')] : [])] }
    const inner = mapped('innerJobs', field('outer', 'children'), 'inner', innerCall)
    const branch: WorkflowBlock = { kind: 'branch', blockId: 'nestedChoice', when: field('outer', 'enabled'), then: inner, else: { kind: 'bind', blockId: 'off', value: literal('off') }, unknown: 'blocked' }
    const initial = [{ id: 'parent', unused: 'old', enabled: true, children: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }]
    const f = await fixture(true, true, true, root(bind('rows', initial), mapped('outerJobs', { kind: 'ref', name: 'rows' }, 'outer', branch), collect('outerJobs'), report('collected')))
    try {
      expect((await f.start()).dispatchAttempts).toBe(2)
      const next = revision(f.preview, body => {
        if (body.kind !== 'sequence' || body.blocks[0].kind !== 'bind') throw new Error('fixture shape')
        body.blocks[0].value = literal([{ ...initial[0], id: mode === 'ancestor-key' ? 'new-parent' : 'parent', unused: 'new',
          children: mode === 'unused' ? [{ id: 'b', text: 'B2' }, { id: 'a', text: 'A' }] : initial[0].children }])
      })
      expect((await f.revise(next)).dispatchAttempts).toBe(mode === 'unused' ? 3 : 4)
      expect(f.calls.filter(value => value.node === 'innerWork' && value.prompt.includes('\nA'))).toHaveLength(mode === 'unused' ? 1 : 2)
    } finally { await f.cleanup() }
  })

  it('does not equate identical JSON from a newly executed opaque producer with the original input fact', async () => {
    const producer: WorkflowBlock = { ...call('producer'), outputSchema: { type: 'array', maxItems: 2, items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } } }
    const rows = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]
    const f = await fixture(true, true, true, root(producer, mapped('jobs', { kind: 'ref', name: 'producer' }, 'entry', { ...call('consumer'), inputRefs: [selected('entry', 'text')] }), collect('jobs'), bind('unused', 'v1'), report('collected')))
    try {
      const original = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => {
        const execution = original(request)
        return request.taskId.endsWith(':producer') ? { ...execution, result: execution.result.then(async result => {
          // Only the first write changes bytes; consumer workspace observations
          // remain equal to the current workspace on both revisions.
          await writeFile(join(f.workspace, 'producer-change.txt'), 'stable after')
          return { ...result, output: JSON.stringify(rows) }
        }) } : execution
      })
      expect((await f.start()).dispatchAttempts).toBe(3)
      const before = await f.record()
      const next = revision(f.preview, body => {
        if (body.kind !== 'sequence' || body.blocks[3].kind !== 'bind') throw new Error('fixture shape')
        body.blocks[3].value = literal('v2')
      })
      expect((await f.revise(next)).dispatchAttempts).toBe(6)
      const after = await f.record()
      expect(after.intents.filter(intent => intent.taskId.endsWith(':producer'))).toHaveLength(2)
      expect(after.intents.filter(intent => intent.taskId.endsWith(':consumer'))).toHaveLength(4)
      expect(after.outcomes.slice(0, before.outcomes.length)).toEqual(before.outcomes)
    } finally { await f.cleanup() }
  })
})
