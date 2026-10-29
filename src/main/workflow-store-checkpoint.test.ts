import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})

import { open, rename } from 'node:fs/promises'
import { FileWorkflowStore } from './workflow-store'
import { frameName } from './workflow-store-artifacts'
import { storageProbe } from './workflow-storage-probe.fixture'
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

  it('rejects value rename, metadata publication, and artifact directory sync failures without reporting success', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const valueFailure = await fixture()
    await valueFailure.store.saveFrame(frame(), 0)
    vi.mocked(rename).mockImplementationOnce(async () => { throw new Error('value rename failed') })
    await expect(valueFailure.store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('value') })).rejects.toThrow('value rename failed')

    const frameFailure = await fixture()
    await frameFailure.store.saveFrame(frame(), 0)
    await storageProbe.failMetadataOnce(join(frameFailure.root, 'workflows', frameName('checkpoint-flow', 'node')))
    await expect(frameFailure.store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('frame') })).rejects.toThrow(storageProbe.metadataFailure)

    const orphan = (await readdir(join(frameFailure.root, 'workflows'))).find(name => name.endsWith('.value.json'))!
    await rm(join(frameFailure.root, 'workflows', orphan))
    const retry = await frameFailure.store.saveValue('checkpoint-flow', 'result', known('frame'))
    expect(await frameFailure.store.loadValue('checkpoint-flow', retry)).toEqual(known('frame'))

    const syncFailure = await fixture()
    await syncFailure.store.saveFrame(frame(), 0)
    const physicalDirectory = await actual.realpath(join(syncFailure.root, 'workflows'))
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if ([physicalDirectory, join(syncFailure.root, 'workflows')].includes(String(args[0]))) handle.sync = async () => { throw new Error('directory sync failed') }
      return handle
    })
    try {
      await expect(syncFailure.store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('sync') })).rejects.toThrow('directory sync failed')
    } finally { vi.mocked(open).mockReset().mockImplementation(actual.open) }
  })

  it('flushes artifacts and waits for the real metadata durability barrier before acknowledging', async () => {
    const { store, root } = await fixture()
    await store.saveFrame(frame(), 0)
    const gate = await storageProbe.holdPublication(join(root, 'workflows', frameName('checkpoint-flow', 'node')), 'checkpoint')
    let acknowledged = false
    const checkpoint = store.saveFrameWithValue({ ...frame(), phase: 'completed' }, 1, { field: 'resultRef', key: 'result', evaluation: known('durable') }).then(value => { acknowledged = true; return value })
    void checkpoint.catch(() => {})
    try {
      await gate.reached
      expect(acknowledged).toBe(false)
      await gate.expectHeld()
      expect(acknowledged).toBe(false)
      await gate.release()
      await checkpoint
      await gate.expectSettled()
    } finally {
      await gate.release()
      await checkpoint.catch(() => {})
      gate.restore()
    }
    expect(acknowledged).toBe(true)
    expect(await store.loadValue('checkpoint-flow', (await store.loadFrame('checkpoint-flow', 'node'))!.resultRef!)).toEqual(known('durable'))
  })
})
