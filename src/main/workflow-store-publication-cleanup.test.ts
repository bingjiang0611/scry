import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), open: vi.fn(actual.open) }
})
import { open, rename, writeFile } from 'node:fs/promises'
import { FileWorkflowStore } from './workflow-store'

const roots: string[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-publication-cleanup-'))
  roots.push(root)
  return { root, store: new FileWorkflowStore(root) }
}
const value = { state: 'known' as const, value: 'durable', derivedFrom: [] }
const temporaryRemovals = () => vi.mocked(rm).mock.calls.filter(([path]) => String(path).endsWith('.tmp'))

describe('FileStore publication temporary cleanup', () => {
  it('does not unlink a temporary name already consumed by a successful rename', async () => {
    const { root, store } = await fixture()
    const reference = await store.saveValue('flow', 'result', value)
    expect(await new FileWorkflowStore(root).loadValue('flow', reference)).toEqual(value)
    expect(temporaryRemovals()).toHaveLength(0)
    expect((await readdir(join(root, 'workflows'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it.each(['write', 'rename'] as const)('cleans the unrenamed temporary file after %s failure and rejects the write', async phase => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const { root, store } = await fixture()
    if (phase === 'write') vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await actual.writeFile(...args)
      throw new Error('write failed')
    })
    else vi.mocked(rename).mockRejectedValueOnce(new Error('rename failed'))
    await expect(store.saveValue('flow', 'result', value)).rejects.toThrow(phase + ' failed')
    expect(temporaryRemovals()).toHaveLength(1)
    expect(await readdir(join(root, 'workflows'))).toEqual([])
    const reference = await store.saveValue('flow', 'result', value)
    expect(await store.loadValue('flow', reference)).toEqual(value)
  })

  it('still rejects directory-sync failure after rename without unlinking the canonical artifact', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const { root, store } = await fixture()
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === join(root, 'workflows')) handle.sync = async () => { throw new Error('directory sync failed') }
      return handle
    })
    try { await expect(store.saveValue('flow', 'result', value)).rejects.toThrow('directory sync failed') }
    finally { vi.mocked(open).mockReset().mockImplementation(actual.open) }
    expect((await readdir(join(root, 'workflows'))).filter(name => name.endsWith('.value.json'))).toHaveLength(1)
    expect(temporaryRemovals()).toHaveLength(0)
    expect((await readdir(join(root, 'workflows'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
