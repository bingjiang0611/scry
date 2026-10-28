import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceChoices, WorkspaceChoicesRequest } from '../../shared/workspace-selection'
import { SourceControlService } from './service'
import { ScProcess } from './process'

let temp: string
let cwd: string
let home: string
let service: SourceControlService
let authorized: Set<string>
let running: Array<string | undefined>
const env = () => ({
  PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'
})
const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env: env(), encoding: 'utf8' }).trim()
async function choices(input: Partial<WorkspaceChoicesRequest> = {}): Promise<WorkspaceChoices> {
  const result = await service.workspaceChoices({ cwd, kind: 'branches', ...input })
  if (result.status !== 'available') throw new Error(result.reason)
  return result.data
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'scry-workspace-choices-')))
  cwd = join(temp, 'repository with spaces')
  home = join(temp, 'home')
  await mkdir(cwd)
  await mkdir(home)
  authorized = new Set([cwd])
  running = []
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  await writeFile(join(cwd, 'file.txt'), 'initial\n')
  git('add', 'file.txt')
  git('commit', '-m', 'initial')
  service = new SourceControlService({
    userData: join(temp, 'userData'),
    authorizeDirectory: path => {
      if (!authorized.has(path)) throw new Error('未授权目录')
      return path
    },
    unsettledDirectories: () => running,
    process: new ScProcess(env)
  })
})
afterEach(async () => {
  await service.dispose()
  await rm(temp, { recursive: true, force: true })
})

describe('read-only workspace selection with real temporary Git', () => {
  it('lists local and cached remote refs and checkout ownership without fetching or altering dirty work', async () => {
    git('branch', 'topic/nested/中文')
    git('update-ref', 'refs/remotes/origin/nested/cached', 'HEAD')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/nested/cached')
    git('remote', 'add', 'origin', 'https://unreachable.invalid/no-fetch.git')
    const linked = join(temp, 'linked with spaces')
    git('worktree', 'add', linked, 'topic/nested/中文')
    await writeFile(join(cwd, 'file.txt'), 'dirty\n')
    const index = await readFile(join(cwd, '.git/index'))
    const indexTime = (await stat(join(cwd, '.git/index'))).mtimeMs
    const refs = git('show-ref')
    const run = vi.spyOn(service.git, 'run')
    const state = await choices()
    expect(state).toMatchObject({ dirty: true, branch: 'main', commonDirBusy: false })
    expect(state.page.kind).toBe('branches')
    if (state.page.kind !== 'branches') throw new Error('Wrong page')
    expect(state.page.items.map(ref => ref.name)).toEqual([
      'refs/heads/main', 'refs/heads/topic/nested/中文', 'refs/remotes/origin/nested/cached'
    ])
    expect(state.page.items.find(ref => ref.name.endsWith('中文'))?.worktreeIds).toHaveLength(1)
    expect(run.mock.calls.some(([, args]) => ['fetch', 'switch', 'checkout', 'add'].includes(args[0]))).toBe(false)
    expect(git('show-ref')).toBe(refs)
    expect(await readFile(join(cwd, '.git/index'))).toEqual(index)
    expect((await stat(join(cwd, '.git/index'))).mtimeMs).toBe(indexTime)
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('dirty\n')
    expect(authorized.has(linked)).toBe(false)
    const nested = await choices({ query: 'nested' })
    expect(nested.page.items).toHaveLength(2)
    expect((await choices({ query: '*' })).page.items).toEqual([])
  })

  it('reuses the selected repository identity when its own run is unsettled', async () => {
    running = [cwd]
    const identity = vi.spyOn(service.git, 'identity')
    await expect(choices()).resolves.toMatchObject({ commonDirBusy: true })
    expect(identity).toHaveBeenCalledTimes(2)
  })

  it('paginates bounded refs, searches beyond the first 1,000 and rejects stale page cursors', async () => {
    const head = git('rev-parse', 'HEAD')
    const commands = Array.from({ length: 1_050 }, (_, index) =>
      `create refs/heads/topic-${String(index).padStart(4, '0')} ${head}\n`).join('')
    execFileSync('/usr/bin/git', ['update-ref', '--stdin'], { cwd, env: env(), input: commands })
    const first = await choices()
    expect(first.page.items).toHaveLength(100)
    expect(first.limited).toBe(true)
    expect(first.nextCursor?.offset).toBe(100)
    const second = await choices({ cursor: first.nextCursor! })
    expect(second.page.items).toHaveLength(100)
    expect(second.page.items).not.toEqual(first.page.items)
    const found = await choices({ query: 'topic-1049' })
    expect(found.page.items).toMatchObject([{ name: 'refs/heads/topic-1049' }])
    expect(found.limited).toBe(false)
    git('branch', 'aaa-new')
    expect(await service.workspaceChoices({ cwd, kind: 'branches', cursor: first.nextCursor! }))
      .toMatchObject({ status: 'failed', reason: expect.stringContaining('清单已变化') })
  })

  it('preserves NUL-delimited worktree paths and marks locks, prunable entries and run ownership', async () => {
    const linked = join(temp, 'linked \"quoted\"\nline')
    const busyPath = join(temp, 'busy worktree')
    const missing = join(temp, 'deleted worktree')
    git('worktree', 'add', '-b', 'linked', linked)
    git('worktree', 'lock', '--reason', 'kept for review', linked)
    git('worktree', 'add', '-b', 'busy', busyPath)
    git('worktree', 'add', '-b', 'deleted', missing)
    await rm(missing, { recursive: true })
    authorized.add(busyPath)
    running = [busyPath]
    const state = await choices({ kind: 'worktrees' })
    expect(state.commonDirBusy).toBe(true)
    if (state.page.kind !== 'worktrees') throw new Error('Wrong page')
    expect(state.page.items.find(tree => tree.path === linked)).toMatchObject({ locked: 'kept for review', busy: false })
    expect(state.page.items.find(tree => tree.path === busyPath)).toMatchObject({ busy: true })
    expect(state.page.items.find(tree => tree.path === cwd)).toMatchObject({ current: true, busy: false })
    expect(state.page.items.find(tree => tree.path === missing)?.prunable).not.toBeNull()
    const selected = state.page.items.find(tree => tree.path === linked)!
    const filtered = await choices({ kind: 'worktrees', query: 'busy worktree', selectedWorktreeId: selected.id })
    expect(filtered.page.items).toHaveLength(1)
    expect(filtered.selectedWorktree).toEqual(selected)
    expect(authorized.has(linked)).toBe(false)
    running = [undefined]
    const unknown = await choices({ kind: 'worktrees' })
    if (unknown.page.kind !== 'worktrees') throw new Error('Wrong page')
    expect(unknown.page.items.every(tree => tree.busy)).toBe(true)
  })

  it('bounds UTF-8 response bytes and permits a narrower search instead of silently dropping metadata', async () => {
    for (let index = 0; index < 3; index++) {
      const target = join(temp, `large-metadata-${index}`)
      git('worktree', 'add', '-b', `budget-${index}`, target)
      git('worktree', 'lock', '--reason', '保留'.repeat(16_000), target)
    }
    expect(await service.workspaceChoices({ cwd, kind: 'worktrees' }))
      .toMatchObject({ status: 'failed', reason: expect.stringContaining('256 KiB') })
    const narrowed = await choices({ kind: 'worktrees', query: 'large-metadata-1' })
    expect(narrowed.page.items).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(narrowed), 'utf8')).toBeLessThanOrEqual(256 * 1024)
    if (narrowed.page.kind !== 'worktrees') throw new Error('Wrong page')
    expect(narrowed.page.items[0].locked).toBe('保留'.repeat(16_000))
    expect(authorized.size).toBe(1)
  })

  it('distinguishes detached, unborn, non-Git and denied directories without granting candidates', async () => {
    git('checkout', '--detach', 'HEAD')
    expect(await choices()).toMatchObject({ branch: null, head: expect.any(String) })
    git('checkout', '--orphan', 'unborn')
    expect(await choices()).toMatchObject({ branch: 'unborn', head: null })
    const plain = join(temp, 'plain')
    await mkdir(plain)
    authorized.add(plain)
    expect(await service.workspaceChoices({ cwd: plain, kind: 'branches' })).toMatchObject({ status: 'unavailable' })
    const identity = vi.spyOn(service.git, 'identity')
    expect(await service.workspaceChoices({ cwd: temp, kind: 'branches' })).toMatchObject({ status: 'failed' })
    expect(identity).not.toHaveBeenCalled()
  })

  it('uses native Git ref validation and rechecks project authority on every validation', async () => {
    const { repositoryId } = await choices()
    expect(await service.validateWorkspaceBranch({ repositoryId, name: 'scry/中文-work' }))
      .toEqual({ status: 'available', data: { name: 'scry/中文-work' } })
    for (const name of ['-option', 'bad..name', 'refs[glob]', '@{-1}', ' leading', 'line\nbreak'])
      expect(await service.validateWorkspaceBranch({ repositoryId, name })).toMatchObject({ status: 'failed' })
    authorized.delete(cwd)
    const run = vi.spyOn(service.git, 'run')
    expect(await service.validateWorkspaceBranch({ repositoryId, name: 'valid' })).toMatchObject({ status: 'failed' })
    expect(run).not.toHaveBeenCalled()
  })
})
