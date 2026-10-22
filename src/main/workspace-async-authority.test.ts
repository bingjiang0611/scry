import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppSessionStore, createProjectStore, createRecentFoldersStore } from './app-store'
import { knownProjectDirectoryAsync } from './workspace-authorization'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: () => { throw new Error('synchronous authority read') },
  existsSync: () => { throw new Error('synchronous authority stat') },
  lstatSync: () => { throw new Error('synchronous authority lstat') },
  realpathSync: () => { throw new Error('synchronous directory canonicalization') },
  statSync: () => { throw new Error('synchronous directory stat') }
}))
let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'scry-async-authority-'))) })
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
const cases = [
  { file: 'recent-folders.json', create: createRecentFoldersStore, rows: ['/selected'] },
  { file: 'projects.json', create: createProjectStore, rows: [{ cwd: '/selected', lastOpenedAt: 1 }] },
  { file: 'app-sessions.json', create: createAppSessionStore, rows: [{ sessionId: 's', externalSessionId: 's', providerId: 'claude', cwd: '/selected', preview: '', ts: 1 }] }
]
describe('template workspace authority without synchronous main-thread filesystem access', () => {
  it.each(cases)('reads fresh $file data with the existing primary/backup/fail-closed contract', async ({ file, create, rows }) => {
    const store = create(root), path = join(root, file)
    expect(await store.loadAsync()).toEqual([])
    await writeFile(path, JSON.stringify(rows))
    expect(await store.loadAsync()).toEqual(rows)
    await writeFile(path + '.bak', JSON.stringify(rows))
    await writeFile(path, '{')
    expect(await store.loadAsync()).toEqual(rows)
    await writeFile(path + '.bak', '{')
    await expect(store.loadAsync()).rejects.toThrow('主索引与备份均不可用')
    await writeFile(path, '[]')
    expect(await store.loadAsync()).toEqual([])
  })
  it('preserves existing legacy session normalization without a synchronous cache read', async () => {
    await writeFile(join(root, 'app-sessions.json'), JSON.stringify([{ sessionId: 'legacy', cwd: '/selected', preview: '', ts: 1 }]))
    expect(await createAppSessionStore(root).loadAsync()).toEqual([{ sessionId: 'legacy', externalSessionId: 'legacy', providerId: 'legacy_unknown', cwd: '/selected', preview: '', ts: 1 }])
  })
  it('matches only a registered canonical directory, not its siblings or descendants', async () => {
    const project = join(root, 'project'), nested = join(project, 'nested'), outside = join(root, 'outside'), alias = join(root, 'alias')
    await mkdir(nested, { recursive: true }); await mkdir(outside); await symlink(project, alias)
    expect(await knownProjectDirectoryAsync(alias, [project])).toBe(project)
    expect(await knownProjectDirectoryAsync(project, [alias])).toBe(project)
    await expect(knownProjectDirectoryAsync(outside, [project])).rejects.toThrow('尚未')
    await expect(knownProjectDirectoryAsync(nested, [project])).rejects.toThrow('尚未')
    await expect(knownProjectDirectoryAsync(project, [join(root, 'missing')])).rejects.toThrow('尚未')
  })
})
