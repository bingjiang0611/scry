import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})

import { open, rename, writeFile } from 'node:fs/promises'
import { FileWorkflowStore } from './workflow-store'
import type { WorkflowControlFrame, WorkflowEvaluation, WorkflowValue } from '../shared/workflow'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const known = (value: WorkflowValue): WorkflowEvaluation => ({ state: 'known', value, derivedFrom: [] })
function frame(workflowId = 'checkpoint-flow'): Omit<WorkflowControlFrame, 'revision'> {
  return { schemaVersion: 1, workflowId, programRevision: 'revision', frameId: 'node', nodeId: 'node', scopePath: [], inputKey: '0'.repeat(64), phase: 'entered' }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-workflow-checkpoint-'))
  roots.push(root)
  return { root, store: new FileWorkflowStore(root) }
}

describe('native workflow frame/value checkpoints', () => {
  it('cold-reads the hash-checked value referenced by the published frame and rejects stale CAS before creating facts', async () => {
    const { root, store } = await fixture()
    const initial = await store.saveFrame(frame(), 0)
    const value = known({ answer: 42 })
    const completed = await store.saveFrameWithValue({ ...initial, phase: 'completed' }, initial.revision, { field: 'resultRef', key: 'result', evaluation: value })
    const cold = new FileWorkflowStore(root)
    expect(await cold.loadFrame(initial.workflowId, initial.frameId)).toMatchObject({ phase: 'completed', resultRef: completed.resultRef })
    expect(await cold.loadValue(initial.workflowId, completed.resultRef!)).toEqual(value)
    const before = (await readdir(join(root, 'workflows'))).filter(name => name.endsWith('.value.json'))
    await expect(store.saveFrameWithValue({ ...initial, phase: 'completed' }, 0, { field: 'resultRef', key: 'stale', evaluation: known('must not publish') })).rejects.toThrow()
    expect((await readdir(join(root, 'workflows'))).filter(name => name.endsWith('.value.json'))).toEqual(before)
  })

  it('rejects value rename, frame rename, and final directory sync failures without reporting success', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const valueFailure = await fixture()
    await valueFailure.store.saveFrame(frame(), 0)
    vi.mocked(rename).mockImplementationOnce(async () => { throw new Error('value rename failed') })
    await expect(valueFailure.store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('value') })).rejects.toThrow('value rename failed')

    const frameFailure = await fixture()
    await frameFailure.store.saveFrame(frame(), 0)
    vi.mocked(rename).mockImplementationOnce(actual.rename).mockImplementationOnce(async () => { throw new Error('frame rename failed') })
    await expect(frameFailure.store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('frame') })).rejects.toThrow('frame rename failed')

    const orphan = (await readdir(join(frameFailure.root, 'workflows'))).find(name => name.endsWith('.value.json'))!
    await rm(join(frameFailure.root, 'workflows', orphan))
    const retry = await frameFailure.store.saveValue('checkpoint-flow', 'result', known('frame'))
    expect(await frameFailure.store.loadValue('checkpoint-flow', retry)).toEqual(known('frame'))

    const syncFailure = await fixture()
    await syncFailure.store.saveFrame(frame(), 0)
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === join(syncFailure.root, 'workflows')) handle.sync = async () => { throw new Error('directory sync failed') }
      return handle
    })
    try {
      await expect(syncFailure.store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('sync') })).rejects.toThrow('directory sync failed')
    } finally { vi.mocked(open).mockReset().mockImplementation(actual.open) }
  })

  it('flushes both files and waits for one directory barrier after both renames before acknowledging', async () => {
    const { store, root } = await fixture()
    await store.saveFrame(frame(), 0)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { reached = resolve })
    let syncs = 0, acknowledged = false
    vi.mocked(writeFile).mockClear()
    vi.mocked(rename).mockClear()
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === join(root, 'workflows')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { syncs++; reached(); await gate; await sync() }
      }
      return handle
    })
    const checkpoint = store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('durable') }).then(value => { acknowledged = true; return value })
    try {
      await started
      expect(acknowledged).toBe(false)
      const writes = vi.mocked(writeFile).mock.calls.filter(([path]) => String(path).endsWith('.tmp'))
      expect(writes).toHaveLength(2)
      for (const [, , options] of writes) expect(options).toMatchObject({ flush: true, mode: 0o600 })
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(2)
      expect(syncs).toBe(1)
    } finally {
      release()
      await checkpoint
      vi.mocked(open).mockReset().mockImplementation(actual.open)
    }
    expect(syncs).toBe(1)
    expect(await store.loadValue('checkpoint-flow', (await store.loadFrame('checkpoint-flow', 'node'))!.resultRef!)).toEqual(known('durable'))
  })
})
