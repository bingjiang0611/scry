import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowControlFrame } from '../shared/workflow'
import { approval, call, fixture, revision } from './workflow-revision.fixture'
import { workflowRecoveryCopy, workflowRetryCopy } from '../shared/constants/copy'
import { frameName, valueName } from './workflow-store-artifacts'

const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'bind', blockId: 'flag', value: { kind: 'literal', value: true } },
  { kind: 'branch', blockId: 'choice', when: { kind: 'ref', name: 'flag' }, then: call('fact'), else: { kind: 'bind', blockId: 'unusedArm', value: { kind: 'literal', value: 'v1' } }, unknown: 'blocked' },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'choice' } }
] }
const nextRevision = (preview: Parameters<typeof revision>[0]) => revision(preview, root => {
  if (root.kind !== 'sequence' || root.blocks[1].kind !== 'branch' || root.blocks[1].else.kind !== 'bind') throw new Error('fixture shape')
  root.blocks[1].else.value = { kind: 'literal', value: 'v2' }
})

async function cutAfterSelection(f: Awaited<ReturnType<typeof fixture>>) {
  const save = f.store.saveFrame.bind(f.store)
  let selected: WorkflowControlFrame | undefined
  const spy = vi.spyOn(f.store, 'saveFrame').mockImplementation(async (frame, expected) => {
    const saved = await save(frame, expected)
    if (!selected && saved.callReuse && saved.phase === 'entered') { selected = saved; throw new Error('fixture crash after durable selection') }
    return saved
  })
  const next = nextRevision(f.preview)
  try { await expect(f.revise(next, 'durable-selection')).rejects.toThrow('fixture crash after durable selection') }
  finally { spy.mockRestore() }
  expect(selected?.callReuse).toBeDefined()
  return { next, selected: selected! }
}

describe('dynamic revision cold canonical authority', () => {
  it('resumes a durably selected old fact without a fabricated attempt/outcome or Provider redispatch', async () => {
    const f = await fixture(true, true, true, body)
    try {
      await f.start()
      const original = await f.record(), { next, selected } = await cutAfterSelection(f)
      expect(selected.callReuse).toMatchObject({ attemptId: original.intents[0].attemptId, reference: { frameId: original.intents[0].callFrameId }, programRevision: f.preview.programRevision })
      f.service.close()
      const cold = f.makeService()
      try {
        await cold.approve(approval(next))
        expect(await cold.resume(next.workflowId, approval(next), 'cold-selection')).toMatchObject({ state: 'continued', progress: { state: 'completed', dispatchAttempts: 1 } })
        const resumed = await f.record()
        expect(resumed.intents).toEqual(original.intents)
        expect(resumed.outcomes).toEqual(original.outcomes)
        expect(resumed.revisions).toHaveLength(2)
        expect(resumed.revisions?.[1].reuse).toEqual([])
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect(await cold.revise(next, approval(next), { expectedRevision: original.progress.revision! }, 'durable-selection')).toMatchObject({ state: 'completed', dispatchAttempts: 1 })
        expect((await f.record()).execution?.segments).toHaveLength(resumed.execution!.segments.length)
      } finally { cold.close() }
    } finally { await f.cleanup() }
  })

  it.each(['missing-input', 'changed-input-bytes', 'changed-source-frame', 'forged-selection'] as const)('rejects %s after a durable selection, without redoing the business call', async fault => {
    const f = await fixture(true, true, true, body)
    try {
      await f.start()
      const { next, selected } = await cutAfterSelection(f)
      const source = selected.callReuse!
      if (fault === 'missing-input') await rm(join(f.userData, 'workflows', valueName(source.inputRef)))
      if (fault === 'changed-input-bytes') await writeFile(join(f.userData, 'workflows', valueName(source.inputRef)), JSON.stringify({ state: 'known', value: { definition: 'invented authority' }, derivedFrom: [] }))
      if (fault === 'changed-source-frame') {
        const path = join(f.userData, 'workflows', frameName(f.preview.workflowId, source.reference.frameId))
        const frame = JSON.parse(await readFile(path, 'utf8'))
        frame.programRevision = '0'.repeat(64)
        await writeFile(path, JSON.stringify(frame))
      }
      if (fault === 'forged-selection') {
        const path = join(f.userData, 'workflows', frameName(f.preview.workflowId, selected.frameId))
        const frame = JSON.parse(await readFile(path, 'utf8'))
        frame.callReuse.attemptId = 'invented-attempt'
        await writeFile(path, JSON.stringify(frame))
      }
      f.service.close()
      const cold = f.makeService()
      try {
        await cold.approve(approval(next))
        await expect(cold.resume(next.workflowId, approval(next), 'cold-fault')).rejects.toThrow()
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect((await f.record()).intents).toHaveLength(1)
      } finally { cold.close() }
    } finally { await f.cleanup() }
  })

  it('admits only one expected-revision CAS and fences the previous controller snapshot', async () => {
    const f = await fixture(true, true, true, body)
    try {
      await f.start()
      const old = await f.record(), next = nextRevision(f.preview)
      f.service.close()
      const left = f.makeService(), right = f.makeService()
      try {
        const results = await Promise.allSettled([
          left.revise(next, approval(next), { expectedRevision: old.progress.revision! }, 'left-dynamic'),
          right.revise(next, approval(next), { expectedRevision: old.progress.revision! }, 'right-dynamic')
        ])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        await expect(f.store.save(old)).rejects.toThrow()
        const current = await f.record()
        expect(current.execution?.segments).toHaveLength(2)
        expect(current.progress.dispatchAttempts).toBe(1)
        expect(current.intents).toHaveLength(1)
        expect(f.execute).toHaveBeenCalledTimes(1)
      } finally { left.close(); right.close() }
    } finally { await f.cleanup() }
  })

  it('keeps owned-copy revision effects unavailable on the actual Service path', async () => {
    const f = await fixture(false, true, true, body)
    try {
      await f.start()
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence') throw new Error('fixture shape')
        root.blocks.splice(2, 0, { kind: 'replica', blockId: 'ownedCopy' })
      })
      await expect(f.revise(next)).rejects.toThrow('不支持')
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect((await f.record()).execution?.segments).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  it('blocks a removed historical unknown before entering a new static program', async () => {
    const f = await fixture(false, true, true, body)
    try {
      await f.start()
      const record = await f.record()
      record.outcomes[0] = { ...record.outcomes[0], state: 'unknown', settled: true }
      await f.store.save(record)
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence') throw new Error('fixture shape')
        root.blocks = [{ kind: 'bind', blockId: 'replacement', value: { kind: 'literal', value: 'known replacement' } }, { kind: 'return', blockId: 'finish', ref: { nodeId: 'replacement' } }]
      })
      await expect(f.revise(next)).rejects.toThrow(workflowRecoveryCopy.unknown)
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect((await f.record()).execution?.segments).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  it('does not resend an admitted settled failure merely because ancestor control syntax changed', async () => {
    const f = await fixture(false, true, true, body)
    try {
      f.execute.mockImplementation(() => ({ result: Promise.resolve({ runId: 'failed-call', status: 'failed', settled: true }), stop: () => true }))
      expect((await f.start()).state).toBe('failed')
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence' || root.blocks[1].kind !== 'branch') throw new Error('fixture shape')
        root.blocks[1].when = { kind: 'literal', value: true }
      })
      await expect(f.revise(next)).rejects.toThrow(workflowRetryCopy.unsafe)
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect((await f.record()).intents).toHaveLength(1)
    } finally { await f.cleanup() }
  })
})
