import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ScGit } from './git'
import { ScProcess } from './process'
import { assertWorkspaceCheckoutSafe, createWorkspaceWorktree, resolveWorkspaceRef, switchWorkspaceBranch, verifyWorkspaceRef } from './workspace-git'

let root: string
let cwd: string
let home: string
let process: ScProcess
let git: ScGit
const environment = () => ({ PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' })
const native = (...args: string[]) => execFileSync('/usr/bin/git', args, {
  cwd, env: environment(), encoding: 'utf8'
}).trim()
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scry-workspace-git-')))
  cwd = join(root, 'repository')
  home = join(root, 'home')
  await mkdir(cwd)
  await mkdir(home)
  native('init', '-b', 'main')
  native('config', 'user.name', 'Fixture')
  native('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(cwd, 'file.txt'), 'initial\n')
  native('add', '.')
  native('commit', '-m', 'initial')
  process = new ScProcess(environment)
  git = new ScGit(process, path => path)
})
afterEach(async () => {
  process.dispose()
  await rm(root, { recursive: true, force: true })
})

it('uses literal branches and host paths without fetching, tracking or changing the source index', async () => {
  native('branch', 'topic/中文')
  const identity = await git.identity(cwd)
  const ref = { name: 'refs/heads/topic/中文', kind: 'local' as const, head: native('rev-parse', 'HEAD') }
  await verifyWorkspaceRef(git, identity, ref)
  const index = await readFile(join(cwd, '.git/index'))
  const indexTime = (await stat(join(cwd, '.git/index'))).mtimeMs
  await assertWorkspaceCheckoutSafe(git, identity, ref.head)
  const target = join(root, 'worktree with spaces')
  await createWorkspaceWorktree(git, identity, target, 'new/topic', ref.head)
  expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('initial\n')
  expect(native('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
  expect(await readFile(join(cwd, '.git/index'))).toEqual(index)
  expect((await stat(join(cwd, '.git/index'))).mtimeMs).toBe(indexTime)
  expect(native('-C', target, 'for-each-ref', '--format=%(upstream)', 'refs/heads/new/topic')).toBe('')
  await switchWorkspaceBranch(git, identity, ref)
  expect(native('symbolic-ref', 'HEAD')).toBe(ref.name)
})

it('detects target-only executable attributes with a private index before materialization', async () => {
  const initial = native('rev-parse', 'HEAD')
  await writeFile(join(cwd, '.gitattributes'), '*.txt filter=target-only\n')
  native('add', '.gitattributes')
  native('commit', '-m', 'target attributes')
  const targetHead = native('rev-parse', 'HEAD')
  native('checkout', initial)
  const marker = join(root, 'filter-executed')
  native('config', 'filter.target-only.smudge', `touch '${marker}'; cat`)
  const identity = await git.identity(cwd)
  const index = await readFile(join(cwd, '.git/index'))
  await expect(assertWorkspaceCheckoutSafe(git, identity, targetHead)).rejects.toThrow('filter target-only')
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(cwd, '.git/index'))).toEqual(index)
  await expect(stat(join(cwd, '.gitattributes'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('resolves a frozen ref name to the commit it points at now instead of a revision expression', async () => {
  const identity = await git.identity(cwd)
  const head = native('rev-parse', 'HEAD')
  // 新建 worktree 的语义是“按这个分支现在的提交创建”，所以冻结的 head 只是当时读到的值。
  await expect(resolveWorkspaceRef(git, identity, {
    name: 'refs/heads/main', head: '0'.repeat(40), kind: 'local'
  })).resolves.toBe(head)
  await expect(resolveWorkspaceRef(git, identity, {
    name: 'refs/heads/main~1', head, kind: 'local'
  })).rejects.toThrow()
  await expect(resolveWorkspaceRef(git, identity, {
    name: 'refs/heads/missing', head, kind: 'local'
  })).rejects.toThrow()
  await expect(resolveWorkspaceRef(git, identity, {
    name: 'refs/remotes/main', head, kind: 'remote'
  })).rejects.toThrow()
})

it('rejects changed refs, revision expressions, remote switches and submodule checkouts', async () => {
  const identity = await git.identity(cwd)
  const head = native('rev-parse', 'HEAD')
  await expect(verifyWorkspaceRef(git, identity, {
    name: 'refs/heads/main', head: '0'.repeat(40), kind: 'local'
  })).rejects.toThrow('已变化')
  await expect(verifyWorkspaceRef(git, identity, {
    name: 'refs/heads/main~1', head, kind: 'local'
  })).rejects.toThrow()
  await expect(switchWorkspaceBranch(git, identity, {
    name: 'refs/remotes/origin/main', head, kind: 'remote'
  })).rejects.toThrow('只能用作新分支的起点')
  native('update-index', '--add', '--cacheinfo', `160000,${head},nested-module`)
  native('commit', '-m', 'gitlink')
  await expect(assertWorkspaceCheckoutSafe(git, identity, native('rev-parse', 'HEAD'))).rejects.toThrow('子模块')
})
