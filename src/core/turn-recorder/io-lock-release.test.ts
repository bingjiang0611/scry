import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm), unlink: vi.fn(actual.unlink), rmdir: vi.fn(actual.rmdir) }
})
import { unlink, rmdir } from 'node:fs/promises'
import { withDirectoryLock } from './io'

const roots: string[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-lock-release-'))
  roots.push(root)
  return join(root, 'owned.lock')
}

it('releases its owner file and empty directory directly, without a recursive directory walk', async () => {
  const lock = await fixture()
  expect(await withDirectoryLock(lock, async () => 'done', { requireDeadOwner: true })).toBe('done')
  expect(vi.mocked(unlink).mock.calls).toEqual([[join(lock, 'owner.json')]])
  expect(vi.mocked(rmdir).mock.calls).toEqual([[lock]])
  expect(vi.mocked(rm).mock.calls).toEqual([])
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('also releases after action failure without replacing the action error', async () => {
  const lock = await fixture()
  await expect(withDirectoryLock(lock, async () => { throw new Error('action failed') })).rejects.toThrow('action failed')
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(vi.mocked(rm).mock.calls).toEqual([])
})

it('does not recursively erase unexpected files in an owned lock directory', async () => {
  const lock = await fixture()
  const extra = join(lock, 'unexpected')
  await expect(withDirectoryLock(lock, async () => { await writeFile(extra, 'retain') })).rejects.toMatchObject({ code: 'ENOTEMPTY' })
  expect(await readFile(extra, 'utf8')).toBe('retain')
  expect(vi.mocked(rm).mock.calls).toEqual([])
})
