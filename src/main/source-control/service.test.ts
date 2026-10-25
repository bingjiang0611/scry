import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlService } from './service'
import { ScProcess } from './process'
import type { ScRepository } from '../../shared/source-control'

let temp: string
let cwd: string
let home: string
let service: SourceControlService
let running: Array<string | undefined> = []
let authorized: Set<string>
const git = (...args: string[]): string =>
  execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
  }).trim()
async function snapshot(): Promise<ScRepository> {
  const result = await service.read(cwd)
  if (result.status !== 'available') throw new Error(result.reason)
  return result.data
}
function makeService(): SourceControlService {
  return new SourceControlService({
    userData: join(temp, 'data'),
    authorizeDirectory: (path) => {
      if (!authorized.has(path)) throw new Error('未授权目录')
      return path
    },
    unsettledDirectories: () => running,
    process: new ScProcess(() => ({
      PATH: '/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1'
    }))
  })
}
beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'scry-source-control-')))
  cwd = join(temp, 'repo with spaces')
  home = join(temp, 'home')
  await mkdir(cwd)
  await mkdir(home)
  authorized = new Set([cwd])
  running = []
  git('init', '-b', 'feature')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  await writeFile(join(cwd, 'base.txt'), 'base\n')
  git('add', '--', 'base.txt')
  git('commit', '-m', 'initial')
  service = makeService()
})
afterEach(async () => {
  await service.dispose()
  await rm(temp, { recursive: true, force: true })
})

// These multi-operation integrations launch 55–78 real Git commands per scenario.
// Measured startup waits alone can exhaust Vitest's 5s unit budget. Match the
// existing real-Git 15s allowance without changing command limits or trust checks.
describe('source control real temporary Git', { timeout: 15_000 }, () => {
  it('preserves the existing index, stages only selected paths, and commits the full confirmed index', async () => {
    await writeFile(join(cwd, 'base.txt'), 'already staged\n')
    git('add', 'base.txt')
    await writeFile(join(cwd, 'space 中文.txt'), 'selected\n')
    await writeFile(join(cwd, 'untouched.txt'), 'not selected\n')
    let state = await snapshot()
    expect(state.files.find((file) => file.path === 'base.txt')?.index).toBe('M')
    const op = await service.mutate({
      action: 'stage',
      repositoryId: state.id,
      expectedRevision: state.revision,
      paths: ['space 中文.txt'],
      operationId: randomUUID()
    })
    expect(op.status).toBe('succeeded')
    expect(git('diff', '--cached', '--name-only')).toContain('base.txt')
    expect(git('diff', '--cached', '--name-only')).not.toContain('untouched.txt')
    state = await snapshot()
    const request = {
      action: 'commit' as const,
      repositoryId: state.id,
      expectedRevision: state.revision,
      message: 'selected change',
      operationId: randomUUID()
    }
    const committed = await service.mutate(request)
    expect(committed.status).toBe('succeeded')
    expect(git('show', 'HEAD:base.txt')).toBe('already staged')
    expect(git('show', 'HEAD:space 中文.txt')).toBe('selected')
    expect(git('status', '--porcelain')).toContain('untouched.txt')
    expect(await service.mutate(request)).toEqual(committed)
    expect(git('rev-list', '--count', 'HEAD')).toBe('2')
  })

  it('commits selected working files and existing partial index together without including other WIP', async () => {
    await writeFile(join(cwd, 'base.txt'), 'already staged\n')
    git('add', 'base.txt')
    await writeFile(join(cwd, 'base.txt'), 'already staged\nkeep unstaged remainder\n')
    await writeFile(join(cwd, 'selected.txt'), 'selected\n')
    await writeFile(join(cwd, 'untouched.txt'), 'not selected\n')
    const state = await snapshot()
    const request = {
      action: 'commit' as const,
      repositoryId: state.id,
      expectedRevision: state.revision,
      paths: ['selected.txt'],
      message: 'guided commit',
      operationId: randomUUID()
    }
    const result = await service.mutate(request)
    expect(result.status).toBe('succeeded')
    expect(git('show', 'HEAD:selected.txt')).toBe('selected')
    expect(git('show', 'HEAD:base.txt')).toBe('already staged')
    expect(git('diff', '--', 'base.txt')).toContain('+keep unstaged remainder')
    expect(git('status', '--porcelain')).toContain('?? untouched.txt')
    expect(await service.mutate(request)).toEqual(result)
    expect(git('rev-list', '--count', 'HEAD')).toBe('2')
  })

  it('rejects guided commit paths that would replace partial staging before any write', async () => {
    await writeFile(join(cwd, 'base.txt'), 'staged\n')
    git('add', 'base.txt')
    await writeFile(join(cwd, 'base.txt'), 'staged\nnot approved\n')
    const state = await snapshot()
    const result = await service.mutate({
      action: 'commit', repositoryId: state.id, expectedRevision: state.revision,
      paths: ['base.txt'], message: 'must not overwrite', operationId: randomUUID()
    })
    expect(result.status).toBe('failed')
    expect(git('show', ':base.txt')).toBe('staged')
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('blocks pre-push only for push, without running it during selected local commit', async () => {
    const hook = join(cwd, '.git/hooks/pre-push')
    const marker = join(temp, 'push-hook-executed')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(hook, 0o755)
    await writeFile(join(cwd, 'selected.txt'), 'selected\n')
    let state = await snapshot()
    expect(state.writeBlocker).toBeNull()
    expect(state.actionBlockers.push).toContain('pre-push')
    const committed = await service.mutate({
      action: 'commit', repositoryId: state.id, expectedRevision: state.revision,
      paths: ['selected.txt'], message: 'local only', operationId: randomUUID()
    })
    expect(committed.status).toBe('succeeded')
    state = await snapshot()
    const pushed = await service.mutate({
      action: 'push', repositoryId: state.id, expectedRevision: state.revision,
      remote: 'origin', operationId: randomUUID()
    })
    expect(pushed.status).toBe('failed')
    expect(pushed.message).toContain('pre-push')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not block a selected local commit for an unused post-checkout hook', async () => {
    const marker = join(temp, 'checkout-hook-executed')
    await writeFile(join(cwd, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(join(cwd, '.git/hooks/post-checkout'), 0o755)
    await writeFile(join(cwd, 'selected.txt'), 'selected\n')
    const state = await snapshot()
    expect(state.actionBlockers).toEqual({ prepareWorkspace: expect.stringContaining('post-checkout') })
    const result = await service.mutate({
      action: 'commit', repositoryId: state.id, expectedRevision: state.revision,
      paths: ['selected.txt'], message: 'no checkout performed', operationId: randomUUID()
    })
    expect(result.status).toBe('succeeded')
    expect(git('show', 'HEAD:selected.txt')).toBe('selected')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('limits index and reference transaction hooks to their native operations', async () => {
    const marker = join(temp, 'hook-executed')
    for (const name of ['post-index-change', 'reference-transaction']) {
      const path = join(cwd, '.git/hooks', name)
      await writeFile(path, `#!/bin/sh\ntouch '${marker}'\n`)
      await chmod(path, 0o755)
      const state = await snapshot()
      expect(Object.keys(state.actionBlockers).sort()).toEqual(
        name === 'post-index-change'
          ? ['commit', 'prepareWorkspace', 'stage', 'unstage']
          : ['commit', 'fetch', 'prepareWorkspace', 'push']
      )
      await rm(path)
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('validates the complete selected range before staging any file', async () => {
    await writeFile(join(cwd, 'selected.txt'), 'selected\n')
    const state = await snapshot()
    const result = await service.mutate({
      action: 'commit', repositoryId: state.id, expectedRevision: state.revision,
      paths: ['selected.txt', 'not-in-snapshot.txt'], message: 'invalid range', operationId: randomUUID()
    })
    expect(result.status).toBe('failed')
    expect(git('diff', '--cached', '--name-only')).toBe('')
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('keeps staged files and an unknown journal if commit fails after selected staging, without replay', async () => {
    await writeFile(join(cwd, 'selected.txt'), 'selected\n')
    const state = await snapshot()
    const commit = vi.spyOn(service.git, 'commitIndex').mockRejectedValue(new Error('fixture commit response lost'))
    const request = {
      action: 'commit' as const, repositoryId: state.id, expectedRevision: state.revision,
      paths: ['selected.txt'], message: 'commit interrupted', operationId: randomUUID()
    }
    const result = await service.mutate(request)
    expect(result.status).toBe('unknown')
    expect(git('diff', '--cached', '--name-only')).toBe('selected.txt')
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    expect(await service.mutate(request)).toEqual(result)
    expect(commit).toHaveBeenCalledTimes(1)
    expect((await snapshot()).writeBlocker).toContain('尚未核查')
  })

  it('does not commit unrelated index changes appearing during selected staging', async () => {
    await writeFile(join(cwd, 'selected.txt'), 'selected\n')
    await writeFile(join(cwd, 'other.txt'), 'not selected\n')
    const state = await snapshot()
    const stage = service.git.stage.bind(service.git)
    vi.spyOn(service.git, 'stage').mockImplementationOnce(async (...args) => {
      const paths = await stage(...args)
      git('add', '--', 'other.txt')
      return paths
    })
    const result = await service.mutate({
      action: 'commit', repositoryId: state.id, expectedRevision: state.revision,
      paths: ['selected.txt'], message: 'do not include drift', operationId: randomUUID()
    })
    expect(result.status).toBe('unknown')
    expect(result.message).toContain('其他文件的 index')
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    expect(git('diff', '--cached', '--name-only')).toBe('other.txt\nselected.txt')
  })

  it('rejects stale snapshots without staging newly changed content', async () => {
    await writeFile(join(cwd, 'base.txt'), 'first\n')
    const state = await snapshot()
    await writeFile(join(cwd, 'base.txt'), 'second longer\n')
    const op = await service.mutate({
      action: 'stage',
      repositoryId: state.id,
      expectedRevision: state.revision,
      paths: ['base.txt'],
      operationId: randomUUID()
    })
    expect(op.status).toBe('failed')
    expect(op.message).toContain('仓库已变化')
    expect(git('diff', '--cached', '--name-only')).toBe('')
  })

  it('unstages an unborn branch without deleting the working file', async () => {
    git('checkout', '--orphan', 'unborn')
    const state = await snapshot()
    expect(state.head).toBeNull()
    const op = await service.mutate({
      action: 'unstage',
      repositoryId: state.id,
      expectedRevision: state.revision,
      paths: ['base.txt'],
      operationId: randomUUID()
    })
    expect(op.status).toBe('succeeded')
    expect(await readFile(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    expect(git('ls-files')).toBe('')
  })

  it('fails closed for executable hooks and filters without running them', async () => {
    const marker = join(temp, 'executed')
    const hook = join(cwd, '.git/hooks/pre-commit')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(hook, 0o755)
    await writeFile(join(cwd, 'base.txt'), 'change\n')
    git('add', 'base.txt')
    let state = await snapshot()
    expect(state.actionBlockers.commit).toContain('pre-commit')
    expect(
      (
        await service.mutate({
          action: 'commit',
          repositoryId: state.id,
          expectedRevision: state.revision,
          message: 'blocked',
          operationId: randomUUID()
        })
      ).status
    ).toBe('failed')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(hook)
    await writeFile(join(cwd, '.gitattributes'), '*.txt filter=evil\n')
    git('config', 'filter.evil.clean', `touch '${marker}'; cat`)
    // The read itself must be blocked: status can execute clean filters before a stage call.
    const filtered = await service.read(cwd)
    expect(filtered.status).toBe('failed')
    if (filtered.status !== 'available') expect(filtered.reason).toContain('git status')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks same-common-dir linked worktrees and unknown provider cwd', async () => {
    const other = join(temp, 'linked')
    git('worktree', 'add', '-b', 'other', other)
    running = [other]
    let state = await snapshot()
    expect(state.writeBlocker).toContain('Agent')
    expect(
      (
        await service.mutate({
          action: 'fetch',
          repositoryId: state.id,
          expectedRevision: state.revision,
          remote: 'origin',
          operationId: randomUUID()
        })
      ).message
    ).toContain('Agent')
    running = [undefined]
    state = await snapshot()
    expect(state.writeBlocker).toContain('Agent')
  })

  it('uses the push endpoint rather than fetch URL, verifies it, and refuses multiple destinations', async () => {
    const fetchRepo = join(temp, 'fetch.git')
    const pushRepo = join(temp, 'push.git')
    git('init', '--bare', fetchRepo)
    git('init', '--bare', pushRepo)
    authorized.add(fetchRepo)
    authorized.add(pushRepo)
    git('remote', 'add', 'origin', fetchRepo)
    git('remote', 'set-url', '--push', 'origin', pushRepo)
    let state = await snapshot()
    expect(state.remotes[0].pushUrls).toEqual([pushRepo])
    const op = await service.mutate({
      action: 'push',
      repositoryId: state.id,
      expectedRevision: state.revision,
      remote: 'origin',
      operationId: randomUUID()
    })
    expect(op.status).toBe('succeeded')
    expect(git('ls-remote', pushRepo, 'refs/heads/feature')).toContain(state.head)
    expect(git('ls-remote', fetchRepo, 'refs/heads/feature')).toBe('')
    git('remote', 'set-url', '--add', '--push', 'origin', fetchRepo)
    state = await snapshot()
    expect(
      (
        await service.mutate({
          action: 'push',
          repositoryId: state.id,
          expectedRevision: state.revision,
          remote: 'origin',
          operationId: randomUUID()
        })
      ).status
    ).toBe('failed')
  })

  it('does not upgrade a nested workspace grant into parent repository access', async () => {
    const child = join(cwd, 'child')
    await mkdir(child)
    authorized = new Set([child])
    expect((await service.read(child)).status).toBe('failed')
    expect((await service.read(home)).status).toBe('failed')
  })

  it('recovers a running intent as unknown, blocks writes and never replays it', async () => {
    const state = await snapshot()
    const id = randomUUID()
    await service.store.save({
      version: 1,
      commonDir: join(cwd, '.git'),
      operation: {
        id,
        repositoryId: state.id,
        action: 'stage',
        status: 'running',
        startedAt: Date.now(),
        message: 'interrupted'
      },
      intent: {},
      requestHash: 'fixture',
      acknowledged: false
    })
    await service.dispose()
    service = makeService()
    const restored = await snapshot()
    const operations = await service.operations({ repositoryId: state.id })
    expect(operations[0].status).toBe('unknown')
    expect(
      (
        await service.mutate({
          action: 'stage',
          repositoryId: state.id,
          expectedRevision: restored.revision,
          paths: ['base.txt'],
          operationId: randomUUID()
        })
      ).message
    ).toContain('未知')
    expect((await service.reconcile({ repositoryId: state.id, operationId: id })).status).toBe('unknown')
    expect(git('diff', '--cached', '--name-only')).toBe('')
    expect((await service.acknowledge({ repositoryId: state.id, operationId: id })).status).toBe('unknown')
  })

})
