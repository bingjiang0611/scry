import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readWorkspaceDiffSnapshot } from '../core/turn-recorder/git-workspace-snapshot'

const exec = promisify(execFile)
const roots: string[] = []
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim()
beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  vi.stubEnv('GIT_TEMPLATE_DIR', '')
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) vi.stubEnv(key, undefined)
})
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
afterAll(() => vi.unstubAllEnvs())
const commit = async (root: string, name: string) => {
  await git(root, 'add', '.')
  await git(root, '-c', 'user.name=test', '-c', 'user.email=test@scry.local', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', name)
  return git(root, 'rev-parse', 'HEAD')
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-branch-diff-')))
  roots.push(root)
  await git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'tracked.txt'), 'original\n')
  const base = await commit(root, 'base')
  await git(root, 'checkout', '-qb', 'feature')
  await writeFile(join(root, 'committed.txt'), 'branch commit\n')
  await commit(root, 'branch change')
  return { root, base }
}
const capture = (root: string) => readWorkspaceDiffSnapshot(root, [], undefined, 'branch')

describe('Changes branch comparison, distinct from Uncommitted and session evidence', () => {
  it('compares merge-base to captured files, including committed, staged and untracked edits, without using the base tip', async () => {
    const { root, base } = await fixture()
    await git(root, 'checkout', '-q', 'main')
    await writeFile(join(root, 'main-only.txt'), 'not a deletion on the feature\n')
    await commit(root, 'advance main independently')
    await git(root, 'checkout', '-q', 'feature')
    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', 'tracked.txt')
    await writeFile(join(root, 'untracked.txt'), 'not committed\n')
    const index = await readFile(join(root, '.git/index'))
    const changes = await capture(root)
    const uncommitted = await readWorkspaceDiffSnapshot(root)
    expect(changes.status).toBe('captured')
    expect(uncommitted.status).toBe('captured')
    if (changes.status !== 'captured' || uncommitted.status !== 'captured') throw new Error('Missing snapshot')
    expect(changes.comparison).toEqual({ baseRef: 'main', baseCommit: base, headRef: 'feature' })
    expect(changes.snapshot.files.map(file => basename(file.path)).sort()).toEqual(['committed.txt', 'tracked.txt', 'untracked.txt'])
    expect(uncommitted.snapshot.files.map(file => basename(file.path)).sort()).toEqual(['tracked.txt', 'untracked.txt'])
    expect(changes.snapshot.files.find(file => basename(file.path) === 'committed.txt')?.patch).toContain('+branch commit')
    expect(changes.revision).not.toBe(uncommitted.revision)
    expect(await readFile(join(root, '.git/index'))).toEqual(index)
  })

  it('uses cached remote HEAD without a fetch', async () => {
    const { root, base } = await fixture()
    await git(root, 'update-ref', 'refs/remotes/origin/trunk', base)
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    const result = await capture(root)
    expect(result).toMatchObject({ status: 'captured', comparison: { baseRef: 'origin/trunk', baseCommit: base } })
  })

  it('honors the existing gh-merge-base configuration rather than guessing main', async () => {
    const { root } = await fixture()
    const base = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'branch', 'release', base)
    await git(root, 'config', 'branch.feature.gh-merge-base', 'release')
    const result = await capture(root)
    expect(result).toMatchObject({ status: 'captured', comparison: { baseRef: 'release', baseCommit: base }, snapshot: { files: [] } })
  })

  it('reports a missing comparison branch explicitly while using the observed HEAD', async () => {
    const { root } = await fixture()
    await git(root, 'branch', '-D', 'main')
    await writeFile(join(root, 'untracked.txt'), 'new\n')
    const result = await capture(root)
    expect(result).toMatchObject({ status: 'captured', comparison: { baseRef: null, baseCommit: await git(root, 'rev-parse', 'HEAD'), headRef: 'feature' } })
    if (result.status !== 'captured') throw new Error('Missing snapshot')
    expect(result.snapshot.files.map(file => basename(file.path))).toEqual(['untracked.txt'])
  })

  it('does not silently fall back to HEAD when the configured base has no common ancestor', async () => {
    const { root } = await fixture()
    await git(root, 'checkout', '--orphan', 'unrelated')
    await commit(root, 'unrelated root')
    await git(root, 'checkout', '-q', 'feature')
    await git(root, 'config', 'branch.feature.gh-merge-base', 'unrelated')
    expect(await capture(root)).toMatchObject({ status: 'failed', reason: 'git_error', files: [] })
  })
})
