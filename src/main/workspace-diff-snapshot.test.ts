import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as captures from '../core/turn-recorder/git-capture'
import { readWorkspaceDiffSnapshot } from '../core/turn-recorder/git-workspace-snapshot'

const exec = promisify(execFile)
const git = (cwd: string, args: string[]) => exec('git', args, { cwd })
const roots: string[] = []
beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  vi.stubEnv('GIT_TEMPLATE_DIR', '')
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) vi.stubEnv(key, undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
afterAll(() => vi.unstubAllEnvs())

async function fixture(commit = true): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-workspace-snapshot-')))
  roots.push(root)
  await git(root, ['init', '-q'])
  await writeFile(join(root, 'tracked.txt'), 'before\n')
  if (commit) {
    await git(root, ['add', '.'])
    await git(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=test', '-c', 'user.email=test@scry.local', 'commit', '-qm', 'baseline'])
  }
  return root
}

describe('same-snapshot workspace diff', () => {
  it('projects HEAD to working files, including odd untracked paths, without changing the real index or object store', async () => {
    const root = await fixture()
    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, ['add', '.'])
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    const odd = 'new \"中\"\nfile.txt'
    await writeFile(join(root, odd), 'new\nline\n')
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'empty.txt'), '')
    const index = await readFile(join(root, '.git/index'))
    const indexStat = await stat(join(root, '.git/index'))
    const objects = await readdir(join(root, '.git/objects'), { recursive: true })
    const result = await readWorkspaceDiffSnapshot(root)
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.head).toBe((await git(root, ['rev-parse', 'HEAD'])).stdout.trim())
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(result.snapshot.files.map(file => basename(file.path)).sort()).toEqual(['binary.dat', 'empty.txt', odd].sort())
    expect(result.snapshot.files.find(file => basename(file.path) === odd)).toMatchObject({ added: 2, deleted: 0, patchStatus: 'captured' })
    expect(result.snapshot.files.find(file => basename(file.path) === odd)?.patch).toContain('+new\n+line')
    expect(result.snapshot.files.find(file => basename(file.path) === 'binary.dat')).toMatchObject({ binary: true, patchStatus: 'binary' })
    expect(result.snapshot.cleanup).toBe('ok')
    expect(await readFile(join(root, '.git/index'))).toEqual(index)
    expect((await stat(join(root, '.git/index'))).mtimeMs).toBe(indexStat.mtimeMs)
    expect(await readdir(join(root, '.git/objects'), { recursive: true })).toEqual(objects)
  })

  it('keeps totals and patch from the captured tree when working files change before projection', async () => {
    const root = await fixture()
    await writeFile(join(root, 'tracked.txt'), 'captured\n')
    const begin = captures.beginGitTurnDiff
    vi.spyOn(captures, 'beginGitTurnDiff').mockImplementation(async (...args) => {
      const capture = await begin(...args)
      await writeFile(join(root, 'tracked.txt'), 'later\nwith\nthree lines\n')
      return capture
    })
    const result = await readWorkspaceDiffSnapshot(root)
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.snapshot.files[0]).toMatchObject({ added: 1, deleted: 1, patchStatus: 'captured' })
    expect(result.snapshot.files[0].patch).toContain('+captured')
    expect(result.snapshot.files[0].patch).not.toContain('later')
  })

  it('distinguishes clean, unborn, non-Git, special-index and timeout evidence', async () => {
    const clean = await fixture()
    expect(await readWorkspaceDiffSnapshot(clean)).toMatchObject({ status: 'captured', snapshot: { files: [] } })
    const unborn = await fixture(false)
    expect(await readWorkspaceDiffSnapshot(unborn)).toMatchObject({ status: 'unavailable', reason: 'no_head' })
    await rm(join(unborn, '.git'), { recursive: true })
    expect(await readWorkspaceDiffSnapshot(unborn)).toMatchObject({ status: 'unavailable', reason: 'not_git' })
    await git(clean, ['update-index', '--assume-unchanged', 'tracked.txt'])
    await writeFile(join(clean, 'tracked.txt'), 'hidden\n')
    expect(await readWorkspaceDiffSnapshot(clean)).toMatchObject({ status: 'unavailable', reason: 'workspace_index' })
    expect(await readWorkspaceDiffSnapshot(clean, [], 0)).toMatchObject({ status: 'timeout', reason: 'deadline' })
  })

  it('does not present a budget-limited patch as complete or lose the full file statistics', async () => {
    const root = await fixture()
    await writeFile(join(root, 'tracked.txt'), 'abcdefghij'.repeat(40_000) + '\n')
    const result = await readWorkspaceDiffSnapshot(root)
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.snapshot.files[0]).toMatchObject({ added: 1, deleted: 1, patchStatus: 'unavailable', patchReason: 'budget' })
    expect(result.snapshot.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.patch ?? ''), 0)).toBeLessThanOrEqual(256 * 1024)
  })

  it('rejects oversized untracked input before snapshot materialization', async () => {
    const root = await fixture()
    await writeFile(join(root, 'large.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 65))
    const objects = await readdir(join(root, '.git/objects'), { recursive: true })
    expect(await readWorkspaceDiffSnapshot(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_limit' })
    expect(await readdir(join(root, '.git/objects'), { recursive: true })).toEqual(objects)
  })
})
