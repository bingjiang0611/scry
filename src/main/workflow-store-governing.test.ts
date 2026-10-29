import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileWorkflowStore } from './workflow-store'
import { fixture, revision } from './workflow-revision.fixture'
import { storageProbe, type PublicationGate } from './workflow-storage-probe.fixture'
import type { WorkflowBlock } from '../shared/workflow'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})
const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'bind', blockId: 'fact', value: { kind: 'literal', value: 'known' } },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'fact' } }
] }
async function prepared() {
  const f = await fixture(true, false, true, body)
  try {
    await f.start()
    await f.revise(revision(f.preview, root => {
      if (root.kind !== 'sequence') throw new Error('Fixture shape')
      root.blocks.at(-1)!.blockId = 'finish-next'
    }))
    const before = await f.record()
    expect(before.revisions).toHaveLength(2)
    expect(before.progress.state).toBe('completed')
    expect(f.execute).not.toHaveBeenCalled()
    const directory = join(f.userData, 'workflows')
    return { f, before, directory, root: join(directory, f.preview.workflowId + '.json'), cold: new FileWorkflowStore(f.userData) }
  } catch (error) { await f.cleanup(); throw error }
}

describe('verified cold governing artifacts', () => {
  it('does not rewrite verified artifacts, waits for durable root publication, and rechecks bytes on every load', async () => {
    const { f, before, cold, directory, root } = await prepared()
    let gate: PublicationGate | undefined, pending: Promise<void> | undefined
    try {
      const loaded = (await cold.load(f.preview.workflowId))!
      const manifest = JSON.parse(await storageProbe.readMetadata(root)) as { revisions: Array<{ reference: string }> }
      const first = join(directory, manifest.revisions[0].reference)
      const original = await readFile(first, 'utf8')
      gate = await storageProbe.holdPublication(root, 'root')
      let acknowledged = false
      pending = cold.save(loaded)
      void pending.then(() => { acknowledged = true }, () => {})
      await gate.reached
      expect(acknowledged).toBe(false)
      await gate.expectHeld()
      expect(acknowledged).toBe(false)
      await gate.release()
      await pending
      expect(acknowledged).toBe(true)
      await gate.expectSettled()
      expect(await cold.load(f.preview.workflowId)).toEqual(before)
      expect(await readFile(first, 'utf8')).toBe(original)
      await writeFile(first, original + ' ')
      await expect(cold.load(f.preview.workflowId)).rejects.toThrow()
      expect(await readFile(first, 'utf8')).toBe(original + ' ')
      await writeFile(first, original)
      expect(await cold.load(f.preview.workflowId)).toEqual(before)
    } finally {
      await gate?.release()
      await pending?.catch(() => {})
      gate?.restore()
      await f.cleanup()
    }
  })

  it('does not remember artifacts from a root rejected after artifact hashing', async () => {
    const { f, before, cold, root } = await prepared()
    let gate: PublicationGate | undefined, pending: Promise<void> | undefined
    try {
      const original = await storageProbe.readMetadata(root)
      const invalid = JSON.parse(original)
      invalid.stopRequests = [{ commandId: '../invalid', requestedAt: 1 }]
      await storageProbe.replaceMetadata(root, JSON.stringify(invalid))
      const remember = vi.spyOn(cold as unknown as { rememberOutput(name: string): void }, 'rememberOutput')
      await expect(cold.load(f.preview.workflowId)).rejects.toThrow('停止收据合同无效')
      expect(remember).not.toHaveBeenCalled()
      await storageProbe.replaceMetadata(root, original)
      gate = await storageProbe.holdPublication(root, 'root')
      pending = cold.save(before)
      void pending.catch(() => {})
      await gate.reached
      expect(remember).toHaveBeenCalledTimes(2)
      await gate.expectHeld()
      await gate.release()
      await pending
      await gate.expectSettled()
      expect(await cold.load(f.preview.workflowId)).toEqual(before)
    } finally {
      await gate?.release()
      await pending?.catch(() => {})
      gate?.restore()
      await f.cleanup()
    }
  })

  it('rejects failed root publication even when all governing artifacts were read and verified', async () => {
    const { f, before, cold, root } = await prepared()
    let gate: PublicationGate | undefined, pending: Promise<void> | undefined
    try {
      const loaded = (await cold.load(f.preview.workflowId))!
      gate = await storageProbe.holdPublication(root, 'root', true)
      pending = cold.save(loaded)
      const rejected = expect(pending).rejects.toThrow(storageProbe.publicationFailure('root'))
      await gate.reached
      await gate.expectHeld()
      await gate.release()
      await rejected
      await gate.expectSettled(true)
      expect(await new FileWorkflowStore(f.userData).load(f.preview.workflowId)).toEqual(before)
    } finally {
      await gate?.release()
      await pending?.catch(() => {})
      gate?.restore()
      await f.cleanup()
    }
  })
})
