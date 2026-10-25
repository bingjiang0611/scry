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

// These multi-operation integrations launch 55–78 real Git commands per scenario.
// Measured startup waits alone can exhaust Vitest's 5s unit budget. Match the
// existing real-Git 15s allowance without changing command limits or trust checks.
describe('source control real temporary Git', { timeout: 15_000 }, () => {
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

  it('rejects a same-repository same-branch PR before GitHub credential discovery', async () => {
    git('remote', 'add', 'origin', 'ssh://git@ssh.github.com:443/owner/repo.git')
    const state = await snapshot()
    const connect = vi.spyOn(service.github, 'connect')
    const result = await service.mutate({
      action: 'createPr', repositoryId: state.id, expectedRevision: state.revision,
      repository: 'owner/repo', headRepository: 'OWNER/REPO', headBranch: 'feature', baseBranch: 'feature',
      account: 'fixture', title: 'invalid PR', body: '', draft: false, operationId: randomUUID()
    })
    expect(result.status).toBe('failed')
    expect(result.message).toContain('源分支与目标分支相同')
    expect(connect).not.toHaveBeenCalled()
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
    expect(state.actionBlockers.push).toContain('push.gpgsign')
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

  it('keeps revision-only material identical to a full status without fabricating empty remote evidence', async () => {
    git('remote', 'add', 'origin', 'https://fixture:secret@example.invalid/team/repo.git')
    await writeFile(join(cwd, 'base.txt'), 'changed\n')
    const identity = await service.git.identity(cwd)
    const full = await service.git.status(identity)
    const revision = await service.git.revisionSnapshot(identity)
    const { remotes, ...expected } = full
    expect(revision).toEqual({ ...expected, observedAt: revision.observedAt })
    expect(revision).not.toHaveProperty('remotes')
    expect(remotes).toEqual([{ name: 'origin', pushUrls: ['https://[redacted]@example.invalid/team/repo.git'], fetchUrls: ['https://[redacted]@example.invalid/team/repo.git'] }])
  })

  it('reads staged, unstaged and untracked diffs through both validations without changing the index', async () => {
    await writeFile(join(cwd, 'base.txt'), 'staged\n')
    git('add', 'base.txt')
    await writeFile(join(cwd, 'base.txt'), 'staged\nworking only\n')
    await writeFile(join(cwd, 'new 中文.txt'), 'untracked\n')
    const state = await snapshot()
    const index = await readFile(join(cwd, '.git/index'))
    for (const [path, staged, included, excluded] of [
      ['base.txt', true, '+staged', 'working only'],
      ['base.txt', false, '+working only', '+staged'],
      ['new 中文.txt', false, '+untracked', '+working only']
    ] as const) {
      const result = await service.diff({ repositoryId: state.id, expectedRevision: state.revision, path, staged })
      expect(result.status).toBe('available')
      if (result.status !== 'available') throw new Error(result.reason)
      expect(result.data.patch).toContain(included)
      expect(result.data.patch).not.toContain(excluded)
      expect(result.data).toMatchObject({ binary: false, truncated: false })
    }
    expect((await readFile(join(cwd, '.git/index'))).equals(index)).toBe(true)
    expect((await snapshot()).revision).toBe(state.revision)
  })

  it.each(['worktree', 'index', 'head', 'remote-config', 'hook'] as const)(
    'rejects a %s change after reading a diff instead of returning stale evidence', async kind => {
      git('remote', 'add', 'origin', 'https://example.invalid/before.git')
      await writeFile(join(cwd, 'base.txt'), 'before diff\n')
      const state = await snapshot()
      const original = service.git.diff.bind(service.git)
      const reader = vi.spyOn(service.git, 'diff').mockImplementation(async (...args) => {
        const data = await original(...args)
        if (kind === 'worktree') await writeFile(join(cwd, 'base.txt'), 'after diff\n')
        else if (kind === 'index') git('add', 'base.txt')
        else if (kind === 'head') git('-c', 'core.hooksPath=/dev/null', 'commit', '-am', 'concurrent change')
        else if (kind === 'remote-config') git('remote', 'set-url', 'origin', 'https://example.invalid/after.git')
        else {
          await mkdir(join(cwd, '.git/hooks'), { recursive: true })
          await writeFile(join(cwd, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n')
          await chmod(join(cwd, '.git/hooks/pre-commit'), 0o755)
        }
        return data
      })
      try {
        const result = await service.diff({ repositoryId: state.id, expectedRevision: state.revision, path: 'base.txt', staged: false })
        expect(result.status).toBe('failed')
        expect(result).not.toHaveProperty('data')
        if (result.status === 'failed') expect(result.reason).toContain('仓库已变化')
      } finally { reader.mockRestore() }
    }
  )

  it('rejects a newly executable filter during the diff before running another status', async () => {
    await writeFile(join(cwd, 'base.txt'), 'before diff\n')
    const state = await snapshot()
    const marker = join(temp, 'filter-executed')
    const original = service.git.diff.bind(service.git)
    const reader = vi.spyOn(service.git, 'diff').mockImplementation(async (...args) => {
      const data = await original(...args)
      git('config', 'filter.late.clean', `printf unsafe > '${marker}'`)
      await writeFile(join(cwd, '.gitattributes'), 'base.txt filter=late\n')
      return data
    })
    try {
      const result = await service.diff({ repositoryId: state.id, expectedRevision: state.revision, path: 'base.txt', staged: false })
      expect(result.status).toBe('failed')
      if (result.status === 'failed') expect(result.reason).toContain('filter')
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { reader.mockRestore() }
  })

  it('rejects a stale pre-diff revision without invoking the patch reader', async () => {
    await writeFile(join(cwd, 'base.txt'), 'before\n')
    const state = await snapshot()
    await writeFile(join(cwd, 'base.txt'), 'after\n')
    const reader = vi.spyOn(service.git, 'diff')
    try {
      expect((await service.diff({ repositoryId: state.id, expectedRevision: state.revision, path: 'base.txt', staged: false })).status).toBe('failed')
      expect(reader).not.toHaveBeenCalled()
    } finally { reader.mockRestore() }
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
