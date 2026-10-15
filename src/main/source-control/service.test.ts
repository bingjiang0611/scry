import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlService } from './service'
import { ScProcess } from './process'
import { parseGitStatus } from './git'
import type { ScPr, ScRepository } from '../../shared/source-control'
import type { GithubSession } from './github'

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

describe('source control real temporary Git', () => {
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
    expect(state.writeBlocker).toContain('pre-commit')
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

  it('negative control: bypassing the pre-read guard really executes the repository filter', async () => {
    const marker = join(temp, 'filter-control')
    await writeFile(join(cwd, '.gitattributes'), '*.txt filter=control\n')
    // Equal size forces a content comparison rather than Git's size-only dirty shortcut.
    await writeFile(join(cwd, 'base.txt'), 'BASE\n')
    git('config', 'filter.control.clean', `touch '${marker}'; cat`)
    const unsafe = vi
      .spyOn(
        service.git as unknown as { assertSafeWorktreeRead(root: string): Promise<void> },
        'assertSafeWorktreeRead'
      )
      .mockResolvedValue(undefined)
    try {
      expect((await service.read(cwd)).status).toBe('available')
      expect(await readFile(marker, 'utf8')).toBe('')
    } finally {
      unsafe.mockRestore()
    }
  })

  it('reciprocally excludes Agent registration while a Git write owns the repository', async () => {
    await writeFile(join(cwd, 'base.txt'), 'changed\n')
    const state = await snapshot()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = service.git.status.bind(service.git)
    vi.spyOn(service.git, 'status').mockImplementationOnce(async (identity) => {
      enter()
      await held
      return original(identity)
    })
    const mutation = service.mutate({
      action: 'stage',
      repositoryId: state.id,
      expectedRevision: state.revision,
      paths: ['base.txt'],
      operationId: randomUUID()
    })
    try {
      await entered
      const register = vi.fn()
      await expect(service.admitRun(cwd, register)).rejects.toThrow('源代码管理操作')
      expect(register).not.toHaveBeenCalled()
    } finally {
      release()
    }
    expect((await mutation).status).toBe('succeeded')
  })

  it('persists commit and review drafts with their original head across restart', async () => {
    const state = await snapshot()
    await service.saveCommitDraft({
      repositoryId: state.id,
      head: state.head,
      message: 'recover this message'
    })
    const draft = {
      repositoryId: state.id,
      repository: 'owner/repo',
      number: 4,
      account: 'reviewer',
      head: state.head!,
      base: 'b'.repeat(40),
      verdict: 'COMMENT' as const,
      body: 'recover this review',
      comments: [{ path: 'base.txt', side: 'RIGHT' as const, line: 1, body: 'inline' }]
    }
    await service.saveDraft(draft)
    await service.dispose()
    service = makeService()
    await snapshot()
    expect(await service.loadCommitDraft({ repositoryId: state.id })).toMatchObject({
      message: 'recover this message',
      head: state.head
    })
    expect(await service.loadDraft(draft)).toEqual(draft)
  })

  it('rechecks PR account, HEAD and base in main before any review write', async () => {
    git('remote', 'add', 'origin', 'https://github.com/owner/repo.git')
    const state = await snapshot()
    const pr: ScPr = {
      repository: 'owner/repo',
      number: 7,
      title: 'fixture',
      body: '',
      url: 'https://github.com/owner/repo/pull/7',
      author: 'author',
      account: 'reviewer',
      state: 'open',
      draft: false,
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      headBranch: 'feature',
      baseBranch: 'main',
      mergeState: 'clean',
      mergeable: true,
      canWrite: true,
      methods: ['squash'],
      checks: [],
      checksComplete: true,
      files: [],
      filesComplete: true,
      comments: [],
      reviews: [],
      activityComplete: true,
      observedAt: Date.now()
    }
    const review = vi.fn(async () => 123)
    const session = { account: 'reviewer', detail: vi.fn(async () => pr), review }
    vi.spyOn(service.github, 'connect').mockResolvedValue(session as unknown as GithubSession)
    const request = {
      action: 'review' as const,
      repositoryId: state.id,
      repository: 'owner/repo',
      number: 7,
      account: 'reviewer',
      head: pr.head,
      base: pr.base,
      body: 'review',
      comments: [],
      verdict: 'COMMENT' as const
    }
    for (const drift of [
      { account: 'another-account' },
      { head: 'c'.repeat(40) },
      { base: 'd'.repeat(40) }
    ]) {
      const result = await service.mutate({ ...request, ...drift, operationId: randomUUID() })
      expect(result.status).toBe('failed')
      expect(review).not.toHaveBeenCalled()
    }
    const result = await service.mutate({ ...request, operationId: randomUUID() })
    expect(result.status).toBe('succeeded')
    expect(result.evidence?.reviewId).toBe(123)
    expect(review).toHaveBeenCalledTimes(1)
  })

  it('blocks signing and gitlinks before native extensions can run', async () => {
    git('config', 'push.gpgsign', 'if-asked')
    let state = await snapshot()
    expect(state.writeBlocker).toContain('push.gpgsign')
    const result = await service.mutate({
      action: 'push',
      repositoryId: state.id,
      expectedRevision: state.revision,
      remote: 'origin',
      operationId: randomUUID()
    })
    expect(result.status).toBe('failed')
    git('config', '--unset', 'push.gpgsign')
    state = await snapshot()
    git('update-index', '--add', '--cacheinfo', `160000,${state.head},nested-module`)
    const submodule = await service.read(cwd)
    expect(submodule.status).toBe('failed')
    if (submodule.status !== 'available') expect(submodule.reason).toContain('不递归读取')
  })

  it('allows an identity filter attribute with no configured executable', async () => {
    await writeFile(join(cwd, '.gitattributes'), '*.txt filter=identity\n')
    await writeFile(join(cwd, 'base.txt'), 'BASE\n')
    const state = await snapshot()
    expect(
      (
        await service.mutate({
          action: 'stage',
          repositoryId: state.id,
          expectedRevision: state.revision,
          paths: ['base.txt'],
          operationId: randomUUID()
        })
      ).status
    ).toBe('succeeded')
    expect(git('show', ':base.txt')).toBe('BASE')
  })

  it('requires an explicit confirmation before replacing a partially staged file', async () => {
    await writeFile(join(cwd, 'base.txt'), 'staged\n')
    git('add', 'base.txt')
    await writeFile(join(cwd, 'base.txt'), 'staged\nworking only\n')
    const state = await snapshot()
    const request = {
      action: 'stage' as const,
      repositoryId: state.id,
      expectedRevision: state.revision,
      paths: ['base.txt']
    }
    expect((await service.mutate({ ...request, operationId: randomUUID() })).status).toBe('failed')
    expect(git('show', ':base.txt')).toBe('staged')
    expect(
      (await service.mutate({ ...request, allowStagedOverwrite: true, operationId: randomUUID() })).status
    ).toBe('succeeded')
    expect(git('show', ':base.txt')).toBe('staged\nworking only')
  })

  it('does not stage an unrelated replacement at the source of an indexed rename', async () => {
    git('mv', 'base.txt', 'moved.txt')
    await writeFile(join(cwd, 'base.txt'), 'unrelated replacement\n')
    await writeFile(join(cwd, 'moved.txt'), 'base\nselected change\n')
    const state = await snapshot()
    expect(state.files.find((file) => file.path === 'moved.txt')).toMatchObject({
      index: 'R',
      previousPath: 'base.txt'
    })
    const result = await service.mutate({
      action: 'stage',
      repositoryId: state.id,
      expectedRevision: state.revision,
      paths: ['moved.txt'],
      allowStagedOverwrite: true,
      operationId: randomUUID()
    })
    expect(result.status).toBe('succeeded')
    expect(git('ls-files')).toBe('moved.txt')
    expect(git('status', '--porcelain')).toContain('?? base.txt')
  })

  it('treats corrupt recovery journals as failure, not an empty ledger', async () => {
    await service.store.ready
    await service.dispose()
    await writeFile(join(temp, 'data/source-control/operations', `${randomUUID()}.json`), '{broken')
    service = makeService()
    expect((await service.read(cwd)).status).toBe('failed')
  })
})

it('parses NUL paths and rename sources, not whitespace-split filenames', () => {
  const state = parseGitStatus(
    '# branch.oid (initial)\0# branch.head feature\0? a\nb.txt\x002 R. N... 100644 100644 100644 abc def R100 new name.txt\0old name.txt\0'
  )
  expect(state.files[0].path).toBe('a\nb.txt')
  expect(state.files[1]).toMatchObject({ path: 'new name.txt', previousPath: 'old name.txt', index: 'R' })
})
