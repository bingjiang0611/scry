import { open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileWorkflowStore } from './workflow-store'
import { fixture, revision } from './workflow-revision.fixture'
import type { WorkflowBlock } from '../shared/workflow'

const meter = vi.hoisted(() => ({ directory: '', root: '', active: false, governing: 0, manifests: 0,
  directorySyncs: 0, failSync: false, reached: () => {}, gate: Promise.resolve() }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    rename: async (...args: Parameters<typeof rename>) => {
      const result = await actual.rename(...args)
      if (meter.active && String(args[1]).startsWith(meter.directory + '/')) {
        if (String(args[1]).endsWith('.governing.json')) meter.governing++
        if (String(args[1]) === meter.root) meter.manifests++
      }
      return result
    },
    open: async (...args: Parameters<typeof open>) => {
      const handle = await actual.open(...args)
      if (meter.active && String(args[0]) === meter.directory) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          meter.directorySyncs++
          meter.reached()
          await meter.gate
          if (meter.failSync) throw new Error('held root directory sync failed')
          await sync()
        }
      }
      return handle
    }
  }
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
    meter.directory = join(f.userData, 'workflows')
    meter.root = join(meter.directory, f.preview.workflowId + '.json')
    meter.active = false
    meter.governing = meter.manifests = meter.directorySyncs = 0
    meter.failSync = false
    meter.gate = Promise.resolve()
    meter.reached = () => {}
    return { f, before, cold: new FileWorkflowStore(f.userData) }
  } catch (error) { await f.cleanup(); throw error }
}

describe('verified cold governing artifacts', () => {
  it('does not rewrite verified artifacts, still waits for root directory sync, and rechecks bytes on every load', async () => {
    const { f, before, cold } = await prepared()
    let release = () => {}, pending: Promise<void> | undefined
    try {
      const loaded = (await cold.load(f.preview.workflowId))!
      const manifest = JSON.parse(await readFile(meter.root, 'utf8')) as { revisions: Array<{ reference: string }> }
      const first = join(meter.directory, manifest.revisions[0].reference)
      const original = await readFile(first, 'utf8')
      meter.gate = new Promise<void>(resolve => { release = resolve })
      const reached = new Promise<void>(resolve => { meter.reached = resolve })
      meter.active = true
      let acknowledged = false
      pending = cold.save(loaded)
      void pending.then(() => { acknowledged = true }, () => {})
      await reached
      expect(acknowledged).toBe(false)
      expect(meter.governing).toBe(0)
      expect(meter.manifests).toBe(1)
      release()
      await pending
      expect(acknowledged).toBe(true)
      expect(meter.directorySyncs).toBe(1)
      expect(await cold.load(f.preview.workflowId)).toEqual(before)
      expect(await readFile(first, 'utf8')).toBe(original)
      await writeFile(first, original + ' ')
      await expect(cold.load(f.preview.workflowId)).rejects.toThrow()
      expect(await readFile(first, 'utf8')).toBe(original + ' ')
      await writeFile(first, original)
      expect(await cold.load(f.preview.workflowId)).toEqual(before)
    } finally {
      release()
      await pending?.catch(() => {})
      meter.active = false
      await f.cleanup()
    }
  })

  it('does not remember artifacts from a root rejected after artifact hashing', async () => {
    const { f, before, cold } = await prepared()
    try {
      const original = await readFile(meter.root, 'utf8')
      const invalid = JSON.parse(original)
      invalid.stopRequests = [{ commandId: '../invalid', requestedAt: 1 }]
      await writeFile(meter.root, JSON.stringify(invalid))
      const remember = vi.spyOn(cold as unknown as { rememberOutput(name: string): void }, 'rememberOutput')
      await expect(cold.load(f.preview.workflowId)).rejects.toThrow('停止收据合同无效')
      expect(remember).not.toHaveBeenCalled()
      await writeFile(meter.root, original)
      meter.active = true
      // save performs a fresh, valid read under the root lock before publication.
      await cold.save(before)
      expect(remember).toHaveBeenCalledTimes(2)
      expect(meter.governing).toBe(0)
      expect(meter.manifests).toBe(1)
      expect(await cold.load(f.preview.workflowId)).toEqual(before)
    } finally { meter.active = false; await f.cleanup() }
  })

  it('rejects a failed root directory sync even when all governing artifacts were read and verified', async () => {
    const { f, before, cold } = await prepared()
    try {
      const loaded = (await cold.load(f.preview.workflowId))!
      meter.active = true
      meter.failSync = true
      await expect(cold.save(loaded)).rejects.toThrow('held root directory sync failed')
      expect(meter.governing).toBe(0)
      expect(meter.manifests).toBe(1)
      expect(meter.directorySyncs).toBe(1)
      meter.failSync = false
      expect(await new FileWorkflowStore(f.userData).load(f.preview.workflowId)).toEqual(before)
    } finally { meter.active = false; await f.cleanup() }
  })
})
