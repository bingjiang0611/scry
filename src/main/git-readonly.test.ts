import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { beginGitTurnDiff, cancelGitTurnDiff, gitNumstat, parseNumstat, readWorkspaceNumstat } from './git'

const symlinkRace = vi.hoisted(() => ({ path: '', target: '', swapped: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const metadata = await actual.lstat(...args)
    if (String(args[0]) === symlinkRace.path) {
      await actual.rm(symlinkRace.path)
      await actual.symlink(symlinkRace.target, symlinkRace.path)
      symlinkRace.swapped = true
    }
    return metadata
  } }
})

const exec = promisify(execFile)
const git = (cwd: string, args: string[]) => exec('git', args, { cwd })
beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  vi.stubEnv('GIT_TEMPLATE_DIR', '')
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) vi.stubEnv(key, undefined)
})
afterAll(() => vi.unstubAllEnvs())

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-readonly-')))
  try {
    await git(root, ['init', '-q'])
    await writeFile(join(root, 'changed.txt'), 'before\n')
    await writeFile(join(root, 'deleted.txt'), 'gone\n')
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await git(root, ['add', '.'])
    await git(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=test', '-c', 'user.email=test@scry.local', 'commit', '-qm', 'baseline'])
    await run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function equivalent(root: string): Promise<void> {
  const repository = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
  const expected = await gitNumstat(root)
  const index = await readFile(join(repository, '.git/index'))
  const metadata = await stat(join(repository, '.git/index'))
  const objects = await readdir(join(repository, '.git/objects'), { recursive: true })
  const actual = await readWorkspaceNumstat(root)
  expect(actual).toMatchObject(expected)
  expect(actual.collectedAt).toMatch(/^\d{4}-/)
  expect(await readFile(join(repository, '.git/index'))).toEqual(index)
  expect((await stat(join(repository, '.git/index'))).mtimeMs).toBe(metadata.mtimeMs)
  expect(await readdir(join(repository, '.git/objects'), { recursive: true })).toEqual(objects)
}

describe('workspace numstat read-only equivalence', () => {
  it('rejects an untracked regular file replaced by an outside symlink between lstat and open', async () => fixture(async root => {
    const outside = await mkdtemp(join(tmpdir(), 'scry-readonly-outside-'))
    try {
      const path = join(root, 'untracked.txt')
      const target = join(outside, 'private.txt')
      // Equal byte lengths: following the symlink must not fail merely on the size guard.
      await writeFile(path, 'inside\n')
      await writeFile(target, 'x\nx\nxx\n')
      Object.assign(symlinkRace, { path, target, swapped: false })
      const result = await readWorkspaceNumstat(root)
      expect(symlinkRace.swapped).toBe(true)
      expect(await realpath(path)).toBe(await realpath(target))
      expect(result).toMatchObject({ status: 'failed', reason: 'git_error', files: [] })
    } finally {
      Object.assign(symlinkRace, { path: '', target: '', swapped: false })
      await rm(outside, { recursive: true, force: true })
    }
  }))

  it('matches modified / deleted / staged / untracked / binary / empty / odd paths without index or object writes', async () => fixture(async root => {
    await writeFile(join(root, 'changed.txt'), 'after\nsecond\n')
    await rm(join(root, 'deleted.txt'))
    await writeFile(join(root, 'staged.txt'), 'staged\n')
    await git(root, ['add', 'staged.txt'])
    await writeFile(join(root, 'staged.txt'), 'working\nextra\n')
    await writeFile(join(root, '中文\n\t.txt'), 'one\ntwo')
    await writeFile(join(root, 'binary.bin'), Buffer.from([1, 0, 255]))
    await writeFile(join(root, 'empty.txt'), '')
    await symlink('missing-target', join(root, 'link'))
    await mkdir(join(root, 'ignored'))
    await writeFile(join(root, 'ignored/noise'), 'noise\n')
    await equivalent(root)
  }))

  it('matches staged delete/recreate and explicitly rejects special index flags', async () => fixture(async root => {
    await git(root, ['rm', 'deleted.txt'])
    await writeFile(join(root, 'deleted.txt'), 'recreated\n')
    await equivalent(root)
    await git(root, ['update-index', '--assume-unchanged', 'changed.txt'])
    await writeFile(join(root, 'changed.txt'), 'different\n')
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_index', files: [] })
    await git(root, ['update-index', '--no-assume-unchanged', 'changed.txt'])
    await git(root, ['update-index', '--skip-worktree', 'changed.txt'])
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_index', files: [] })
  }))

  it('matches clean trees and staged-only changes reverted in the worktree', async () => fixture(async root => {
    await equivalent(root)
    await writeFile(join(root, 'changed.txt'), 'staged\n')
    await git(root, ['add', 'changed.txt'])
    await writeFile(join(root, 'changed.txt'), 'before\n')
    await equivalent(root)
  }))

  it('matches scope and explicit excludedPaths (including ignored paths)', async () => fixture(async root => {
    const selected = join(root, 'selected[scope]')
    const excluded = join(selected, 'exclude')
    await mkdir(excluded, { recursive: true })
    await writeFile(join(selected, 'inside.txt'), 'inside\n')
    await writeFile(join(excluded, 'noise'), 'excluded\n')
    await writeFile(join(root, 'outside.txt'), 'outside\n')
    const capture = await beginGitTurnDiff(selected, 5000, undefined, [excluded, join(root, 'ignored')])
    try {
      expect(capture.status).toBe('ready')
      const { stdout } = await exec('git', [...(capture.filterOverrides ?? []), 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD', capture.beforeTree!, '--', ...capture.pathspec!], {
        cwd: root, env: { ...process.env, GIT_OBJECT_DIRECTORY: capture.objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs }
      })
      expect(await readWorkspaceNumstat(selected, [excluded, join(root, 'ignored')])).toMatchObject({ status: 'captured', files: parseNumstat(stdout, root) })
      await equivalent(selected)
    } finally { await cancelGitTurnDiff(capture) }
  }))

  it('matches attributes, no-final-newline, CRLF and binary threshold', async () => fixture(async root => {
    await writeFile(join(root, '.gitattributes'), '*.data -diff\n*.text diff\n')
    await writeFile(join(root, 'binary.data'), 'plain text\n')
    await writeFile(join(root, 'empty.data'), '')
    await writeFile(join(root, 'nul.text'), Buffer.from([0, 10, 65]))
    await writeFile(join(root, 'crlf.txt'), 'a\r\nb\r\nlast')
    await equivalent(root)
    await git(root, ['config', 'core.bigFileThreshold', '4'])
    await equivalent(root)
  }))

  it('rejects staged attribute fallback changes and normalized-size binary boundaries explicitly', async () => fixture(async root => {
    await writeFile(join(root, '.gitattributes'), '*.txt -diff\n')
    await git(root, ['add', '.gitattributes'])
    await git(root, ['-c', 'user.name=test', '-c', 'user.email=test@scry.local', 'commit', '-qm', 'attrs'])
    await git(root, ['rm', '.gitattributes'])
    await writeFile(join(root, 'changed.txt'), 'after\n')
    const oracle = await gitNumstat(root)
    expect(oracle.files.find(file => file.path === join(root, 'changed.txt'))).toEqual({ path: join(root, 'changed.txt'), added: 1, deleted: 1 })
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_attributes', files: [] })
    await git(root, ['reset', '--hard', 'HEAD'])
    await rm(join(root, '.gitattributes'))
    await git(root, ['config', 'core.autocrlf', 'true'])
    await git(root, ['config', 'core.bigFileThreshold', '3'])
    await writeFile(join(root, 'new.txt'), 'ab\r\n')
    expect((await gitNumstat(root)).files.find(file => file.path === join(root, 'new.txt'))).toEqual({ path: join(root, 'new.txt'), added: 1, deleted: 0 })
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_attributes', files: [] })
    // Valueless config booleans are true, not an absent/false setting.
    await writeFile(join(root, '.git/config'), (await readFile(join(root, '.git/config'), 'utf8')) + '\n[core]\n  autocrlf\n')
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_attributes', files: [] })
  }))

  it('rejects dirty and changed-HEAD submodules rather than reporting worktree dirt as gitlink changes', async () => fixture(async root => {
    const sub = join(root, 'nested')
    await mkdir(sub)
    await git(sub, ['init', '-q'])
    await writeFile(join(sub, 'file'), 'before\n')
    await git(sub, ['add', '.'])
    const commit = ['-c', 'user.name=test', '-c', 'user.email=test@scry.local', 'commit', '-qm', 'baseline']
    await git(sub, commit)
    await git(root, ['add', 'nested'])
    await git(root, commit)
    await git(root, ['config', 'diff.ignoreSubmodules', 'none'])
    await writeFile(join(sub, 'file'), 'after\n')
    expect(await gitNumstat(root)).toEqual({ status: 'captured', files: [] })
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_submodule', files: [] })
    await git(sub, ['add', '.'])
    await git(sub, commit)
    expect((await gitNumstat(root)).files).toEqual([{ path: sub, added: 1, deleted: 1 }])
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_submodule', files: [] })
  }))

  it('disables repository filters, fsmonitor, hooks, external diff and textconv before reading worktree content', async () => fixture(async root => {
    const sentinel = join(root, 'executed')
    const command = `printf unsafe > '${sentinel}'; cat`
    await writeFile(join(root, '.gitattributes'), '*.txt filter=Spy diff=Spy\n')
    await git(root, ['add', '.gitattributes'])
    await git(root, ['-c', 'user.name=test', '-c', 'user.email=test@scry.local', 'commit', '-qm', 'attrs'])
    for (const [key, value] of [['filter.Spy.clean', command], ['filter.Spy.process', command], ['filter.Spy.required', 'true'], ['core.fsmonitor', command], ['diff.external', command], ['diff.Spy.textconv', command]]) await git(root, ['config', key, value])
    const hooks = join(root, '.git/hooks-sentinel')
    await mkdir(hooks)
    await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\n${command}\n`, { mode: 0o755 })
    await git(root, ['config', 'core.hooksPath', hooks])
    await writeFile(join(root, 'changed.txt'), 'after\n')
    const result = await readWorkspaceNumstat(root)
    expect(result).toMatchObject({ status: 'captured', files: [{ path: join(root, 'changed.txt'), added: 1, deleted: 1 }] })
    await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  }))

  it('does not run a repository remote helper to fetch missing promisor objects', async () => fixture(async root => {
    const marker = join(root, 'remote-helper-ran')
    const blob = (await git(root, ['rev-parse', 'HEAD:changed.txt'])).stdout.trim()
    await git(root, ['config', 'remote.origin.url', 'ssh://fixture.invalid/repo'])
    await git(root, ['config', 'remote.origin.promisor', 'true'])
    await git(root, ['config', 'core.sshCommand', `printf unsafe > '${marker}'; exit 1`])
    await rm(join(root, '.git/objects', blob.slice(0, 2), blob.slice(2)))
    await writeFile(join(root, 'changed.txt'), 'after\n')
    // Sensitivity control: normal Git lazy-fetch really invokes the fixture helper.
    await expect(exec('git', ['cat-file', '-p', blob], { cwd: root, env: { ...process.env, GIT_NO_LAZY_FETCH: '0' } })).rejects.toThrow()
    expect(await readFile(marker, 'utf8')).toBe('unsafe')
    await rm(marker)
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'failed', reason: 'git_error', files: [] })
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }))

  it('reports unsupported attributes and limits explicitly, not successful empty or partial files', async () => fixture(async root => {
    await writeFile(join(root, '.gitattributes'), '*.new working-tree-encoding=UTF-16\n')
    await writeFile(join(root, 'file.new'), Buffer.from([255, 254, 65, 0]))
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_attributes', files: [] })
    await rm(join(root, '.gitattributes'))
    await writeFile(join(root, 'large'), Buffer.alloc(16 * 1024 * 1024 + 1, 65))
    expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'workspace_limit', files: [] })
  }))

  it('preserves not_git / no_head / failed / timeout states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-readonly-state-'))
    try {
      expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'not_git', files: [] })
      await git(root, ['init', '-q'])
      expect(await readWorkspaceNumstat(root)).toMatchObject({ status: 'unavailable', reason: 'no_head', files: [] })
      expect(await readWorkspaceNumstat(join(root, 'missing'))).toMatchObject({ status: 'failed', reason: 'git_error', files: [] })
      expect(await readWorkspaceNumstat(root, [], 0)).toMatchObject({ status: 'timeout', reason: 'deadline', files: [] })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
