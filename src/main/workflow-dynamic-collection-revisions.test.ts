import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock } from '../shared/workflow'
import type { WorkflowCallInputs } from './workflow-call-semantics'
import { approval, call, fixture, revision } from './workflow-revision.fixture'
import { collectionName } from './workflow-store-artifacts'

const rows = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]
function program(consumeIndex = false): WorkflowBlock {
  return { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'bind', blockId: 'rows', value: { kind: 'literal', value: rows } },
    { kind: 'map', blockId: 'firstMap', items: { kind: 'ref', name: 'rows' }, item: 'row', key: ['id'], maxItems: 2,
      body: { ...call('scan'), inputRefs: [{ nodeId: 'row', path: ['text'] }] } },
    { kind: 'map', blockId: 'consumerMap', items: { kind: 'ref', name: 'firstMap' }, item: 'entry', key: ['key'], maxItems: 2,
      body: { ...call('consumer'), inputRefs: [{ nodeId: 'entry', path: ['value'] }, ...(consumeIndex ? [{ nodeId: 'entry', path: ['index'] }] : [])] } },
    { kind: 'collect', blockId: 'collected', items: { kind: 'ref', name: 'consumerMap' } },
    { kind: 'bind', blockId: 'unused', value: { kind: 'literal', value: 'v1' } },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'collected' } }
  ] }
}
const unrelated = (preview: Parameters<typeof revision>[0]) => revision(preview, root => {
  if (root.kind !== 'sequence' || root.blocks[4].kind !== 'bind') throw new Error('fixture shape')
  root.blocks[4].value = { kind: 'literal', value: 'v2' }
})

describe('revision sealed collection input authority', () => {
  it.each([false, true])('reorders keys without using positions, unless index is an actual declared input: %s', async consumeIndex => {
    const f = await fixture(true, true, true, program(consumeIndex))
    try {
      expect((await f.start()).dispatchAttempts).toBe(4)
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence' || root.blocks[0].kind !== 'bind') throw new Error('fixture shape')
        root.blocks[0].value = { kind: 'literal', value: [{ ...rows[1], unused: 'new' }, rows[0]] }
      })
      const progress = await f.revise(next)
      expect(progress.dispatchAttempts).toBe(consumeIndex ? 6 : 4)
      expect(f.calls.filter(value => value.node === 'scan')).toHaveLength(2)
      expect(f.calls.filter(value => value.node === 'consumer')).toHaveLength(consumeIndex ? 4 : 2)
      expect(JSON.parse(progress.finalReport!).map((value: { key: string }) => value.key)).toEqual(['b', 'a'])
    } finally { await f.cleanup() }
  })

  it('keeps per-key opaque attempts when only one equal-JSON producer is newly executed', async () => {
    const f = await fixture(true, true, true, program())
    try {
      const original = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => {
        const native = original(request)
        return request.taskId.endsWith(':scan') && request.prompt.endsWith('\nA') ? { ...native, result: native.result.then(async result => {
          await writeFile(join(f.workspace, 'writer.txt'), 'stable after')
          return result
        }) } : native
      })
      expect((await f.start()).dispatchAttempts).toBe(4)
      expect((await f.revise(unrelated(f.preview))).dispatchAttempts).toBe(6)
      expect(f.calls.filter(value => value.node === 'scan')).toHaveLength(3)
      expect(f.calls.filter(value => value.node === 'consumer')).toHaveLength(3)
      expect(f.calls.filter(value => value.node === 'consumer').at(-1)?.prompt).toContain('\nA-output')
    } finally { await f.cleanup() }
  })

  it('rejects a missing historical sealed manifest on cold selection validation, rather than rerunning its consumer', async () => {
    const f = await fixture(true, true, true, program())
    try {
      await f.start()
      const record = await f.record(), intent = record.intents.find(value => value.taskId.endsWith(':consumer'))!
      const callFrame = (await f.store.loadFrame(f.preview.workflowId, intent.callFrameId!))!
      const input = await f.store.loadValue(f.preview.workflowId, callFrame.callInputRef!)
      if (input.state !== 'known') throw new Error('fixture missing input')
      const context = (input.value as unknown as WorkflowCallInputs).contexts.find(value => value.blockId === 'consumerMap')!
      const parent = (await f.store.loadFrame(f.preview.workflowId, context.frameId))!
      const source = await f.store.loadValue(f.preview.workflowId, parent.sourceRef!)
      if (source.state !== 'known' || !source.collection) throw new Error('fixture missing collection')
      const save = f.store.saveFrame.bind(f.store)
      let cut = false
      const spy = vi.spyOn(f.store, 'saveFrame').mockImplementation(async (frame, expected) => {
        const saved = await save(frame, expected)
        if (!cut && saved.nodeId === 'consumer' && saved.callReuse) { cut = true; throw new Error('consumer selection durable') }
        return saved
      })
      const next = unrelated(f.preview)
      try { await expect(f.revise(next)).rejects.toThrow('consumer selection durable') }
      finally { spy.mockRestore() }
      expect(cut).toBe(true)
      await rm(join(f.userData, 'workflows', collectionName(source.collection.reference)))
      f.service.close()
      const cold = f.makeService()
      try {
        await cold.approve(approval(next))
        await expect(cold.resume(next.workflowId, approval(next), 'cold-collection')).rejects.toThrow()
        expect(f.execute).toHaveBeenCalledTimes(4)
        expect((await f.record()).intents).toHaveLength(4)
      } finally { cold.close() }
    } finally { await f.cleanup() }
  })

  it('does not grant ordinary JSON wrappers the old collection producer authority', async () => {
    const f = await fixture(true, true, true, program())
    try {
      await f.start()
      const original = await f.record()
      const wrappers = await Promise.all(original.intents.filter(intent => intent.taskId.endsWith(':scan')).map(async (intent, index) => {
        const outcome = original.outcomes.find(value => value.attemptId === intent.attemptId)!
        return { key: rows[index].id, index, state: 'completed', settled: true, value: (await f.store.loadOutput(f.preview.workflowId, outcome))!,
          // Payload labels are intentionally plausible but convey no authority.
          attemptId: intent.attemptId, programRevision: intent.programRevision, derivedFrom: ['attempt:' + intent.attemptId] }
      }))
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence') throw new Error('fixture shape')
        root.blocks[1] = { kind: 'bind', blockId: 'firstMap', value: { kind: 'literal', value: wrappers } }
      })
      expect((await f.revise(next)).dispatchAttempts).toBe(6)
      expect(f.calls.filter(value => value.node === 'scan')).toHaveLength(2)
      expect(f.calls.filter(value => value.node === 'consumer')).toHaveLength(4)
    } finally { await f.cleanup() }
  })

  it.each(['same', 'separate'] as const)('retains per-group member origins without invalidating separately sourced groups: %s', async grouping => {
    const body = program()
    if (body.kind !== 'sequence' || body.blocks[1].kind !== 'map' || body.blocks[1].body.kind !== 'call') throw new Error('fixture shape')
    body.blocks[1].body.outputSchema = { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] }
    body.blocks.splice(2, 2,
      { kind: 'bind', blockId: 'groups', value: { kind: 'group', items: { kind: 'ref', name: 'firstMap' }, key: ['value', 'category'] } },
      { kind: 'map', blockId: 'groupMap', items: { kind: 'ref', name: 'groups' }, item: 'group', key: ['key'], maxItems: 2,
        body: { ...call('groupConsumer'), inputRefs: [{ nodeId: 'group', path: ['key'] }] } })
    body.blocks[5] = { kind: 'return', blockId: 'finish', ref: { nodeId: 'groupMap' } }
    const f = await fixture(true, true, true, body)
    try {
      const original = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => {
        const native = original(request)
        if (!request.taskId.endsWith(':scan')) return native
        const isA = request.prompt.includes('[committed binding row]\nA')
        return { ...native, result: native.result.then(async result => {
          if (isA) await writeFile(join(f.workspace, 'group-writer.txt'), 'stable after')
          return { ...result, output: JSON.stringify({ category: grouping === 'same' ? 'shared' : isA ? 'group-a' : 'group-b' }) }
        }) }
      })
      const initialAttempts = grouping === 'same' ? 3 : 4
      expect((await f.start()).dispatchAttempts).toBe(initialAttempts)
      expect((await f.revise(unrelated(f.preview))).dispatchAttempts).toBe(initialAttempts + 2)
      expect(f.calls.filter(value => value.node === 'scan')).toHaveLength(3)
      expect(f.calls.filter(value => value.node === 'groupConsumer')).toHaveLength(grouping === 'same' ? 2 : 3)
      if (grouping === 'separate') expect(f.calls.filter(value => value.node === 'groupConsumer' && value.prompt.includes('\ngroup-b'))).toHaveLength(1)
    } finally { await f.cleanup() }
  })

})
