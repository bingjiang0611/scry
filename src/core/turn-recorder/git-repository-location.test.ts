import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeTurnDiffSnapshot } from '../../shared/turn-diff'
import { aggregateTurnEvidence } from './aggregate'
import { beginGitTurnDiff, finishGitTurnDiff } from './git'
import {
  normalizeGitOrigin, readGitRepositoryLocation, readTurnRepositoryRemote, REPOSITORY_REMOTE_RETRY,
  sampleGitRepositoryLocation, type GitRepositoryLocation
} from './git-repository-location'

vi.mock('./git-repository-location.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-repository-location.js')>()
  return { ...actual, sampleGitRepositoryLocation: vi.fn(actual.sampleGitRepositoryLocation) }
})

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd })
  return stdout.trim()
}

async function read(root: string, includeOrigin = true): Promise<GitRepositoryLocation> {
  const location = {}
  await readGitRepositoryLocation(root, Date.now() + 1000, includeOrigin, fields => Object.assign(location, fields))
  return location
}

// A best-effort production sample never waits. Read the real Git files before handing the
// observation to each boundary so a slow CI filesystem cannot make these mapping tests flaky.
async function sampleNextBoundary(root: string, includeOrigin: boolean): Promise<void> {
  const observed = await read(root, includeOrigin)
  vi.mocked(sampleGitRepositoryLocation).mockReturnValueOnce(() => observed)
}

describe('Git repository location from disk', () => {
  let root: string
  let oid: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scry-git-location-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function init(separate?: string): Promise<void> {
    await git(root, 'init', '-b', 'feature/first', ...(separate ? ['--separate-git-dir', separate] : []))
    await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'seed')
    oid = await git(root, 'rev-parse', 'HEAD')
  }

  it('reads the branch, loose HEAD commit and credential-free origin of a normal repository', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', 'https://alice:fake-password@EXAMPLE.invalid:443/group/repo.git?token=fake#secret')
    expect(await read(root)).toEqual({
      branch: 'feature/first', branchStatus: 'observed', commit: oid, commitStatus: 'observed',
      remote: 'example.invalid/group/repo', remoteStatus: 'observed'
    })
  })

  it('reads a linked worktree HEAD and resolves its packed ref and origin in the common directory', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'worktree/second', linked)
    await git(root, 'pack-refs', '--all')
    expect(await read(linked)).toEqual({
      branch: 'worktree/second', branchStatus: 'observed', commit: oid, commitStatus: 'observed',
      remote: 'example.invalid/group/repo', remoteStatus: 'observed'
    })
  })

  it('keeps the start branch and HEAD when the turn creates and switches to another branch', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    await sampleNextBoundary(root, true)
    const capture = await beginGitTurnDiff(root)
    await git(root, 'switch', '-c', 'feature/second')
    await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'next')
    const commitAfter = await git(root, 'rev-parse', 'HEAD')
    await sampleNextBoundary(root, false)
    const snapshot = await finishGitTurnDiff(capture)
    expect(normalizeTurnDiffSnapshot(snapshot)?.repositoryLocation).toEqual({
      branch: 'feature/first', branchStatus: 'observed', branchAfter: 'feature/second',
      commitBefore: oid, commitStatus: 'observed', commitAfter,
      remote: 'example.invalid/group/repo', remoteStatus: 'observed'
    })
  })

  it('records the end branch and commit for an unchanged turn after an empty early sample', async () => {
    await init()
    const capture = await beginGitTurnDiff(root)
    const location = vi.fn<() => GitRepositoryLocation>()
      .mockReturnValueOnce({})
      .mockReturnValue({ branch: 'feature/first', commit: oid })
    vi.mocked(sampleGitRepositoryLocation).mockReturnValueOnce(location)
    const onAfter = vi.fn()
    const snapshot = await finishGitTurnDiff(capture, undefined, { onAfter })
    expect(snapshot.collection?.strategy).toBe('unchanged')
    expect(snapshot.files).toEqual([])
    expect(onAfter).toHaveBeenCalledOnce()
    const record = aggregateTurnEvidence({ events: [{
      id: 'diff', runId: 'turn', ts: snapshot.afterAt, kind: 'harness', stage: 'turn_diff', turnDiff: snapshot
    }] })
    expect(record.diff.value?.[0].repositoryLocation).toMatchObject({ branchAfter: 'feature/first', commitAfter: oid })
  })

  it('samples the actual HEAD independently of a continuation baseline tree and records detached end', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    const tree = await git(root, 'rev-parse', 'HEAD^{tree}')
    await sampleNextBoundary(root, true)
    const capture = await beginGitTurnDiff(root, undefined, undefined, [], false, { commit: tree, at: new Date().toISOString() })
    await git(root, 'switch', '--detach')
    await sampleNextBoundary(root, false)
    const snapshot = await finishGitTurnDiff(capture)
    expect(normalizeTurnDiffSnapshot(snapshot)?.repositoryLocation).toEqual({
      branch: 'feature/first', branchStatus: 'observed', branchAfter: null,
      commitBefore: oid, commitStatus: 'observed', commitAfter: oid,
      remote: 'example.invalid/group/repo', remoteStatus: 'observed'
    })
  })

  it('fills the origin a lost start sample missed, and keeps branch and start commit from status', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'tracked')
    const head = await git(root, 'rev-parse', 'HEAD')
    vi.mocked(sampleGitRepositoryLocation).mockReturnValueOnce(() => ({}))
    const capture = await beginGitTurnDiff(root)
    await writeFile(join(root, 'tracked.txt'), 'after\n')
    await sampleNextBoundary(root, false)
    const started = Date.now()
    const snapshot = await finishGitTurnDiff(capture)
    expect(Date.now() - started).toBeLessThan(REPOSITORY_REMOTE_RETRY.turnDeadlineMs + 5_000)
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0].path.endsWith('tracked.txt')).toBe(true)
    expect(normalizeTurnDiffSnapshot(snapshot)?.repositoryLocation).toEqual({
      remote: 'example.invalid/group/repo', remoteStatus: 'observed',
      branch: 'feature/first', branchStatus: 'observed',
      commitBefore: head, commitStatus: 'observed',
      branchAfter: 'feature/first', commitAfter: head
    })
  })

  it('does not spend a second read on a repository the turn did not change', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    vi.mocked(sampleGitRepositoryLocation).mockReturnValueOnce(() => ({}))
    const capture = await beginGitTurnDiff(root)
    await sampleNextBoundary(root, false)
    const snapshot = await finishGitTurnDiff(capture)
    expect(snapshot.files).toEqual([])
    expect(normalizeTurnDiffSnapshot(snapshot)?.repositoryLocation).toEqual({
      remoteStatus: 'unavailable', branch: 'feature/first', branchStatus: 'observed',
      commitBefore: oid, commitStatus: 'observed', branchAfter: 'feature/first', commitAfter: oid
    })
  })

  it('still finishes a changed turn when the origin retry cannot read the config', async () => {
    await init()
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await git(root, 'add', 'tracked.txt')
    await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'tracked')
    const head = await git(root, 'rev-parse', 'HEAD')
    const config = join(root, '.git', 'config')
    const other = join(root, 'config')
    await writeFile(other, await readFile(config, 'utf8'))
    await rm(config)
    await symlink(other, config)
    vi.mocked(sampleGitRepositoryLocation).mockReturnValueOnce(() => ({}))
    const capture = await beginGitTurnDiff(root)
    await writeFile(join(root, 'tracked.txt'), 'after\n')
    await sampleNextBoundary(root, false)
    const snapshot = await finishGitTurnDiff(capture)
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0].path.endsWith('tracked.txt')).toBe(true)
    expect(normalizeTurnDiffSnapshot(snapshot)?.repositoryLocation).toMatchObject({
      remoteStatus: 'unavailable', branch: 'feature/first', commitBefore: head
    })
  })

  it('handles a gitdir pointer without a worktree commondir', async () => {
    await init(join(root, 'metadata'))
    await writeFile(join(root, '.git'), 'gitdir: metadata\n')
    expect(await read(root)).toEqual({
      branch: 'feature/first', branchStatus: 'observed', commit: oid, commitStatus: 'observed', remoteStatus: 'absent'
    })
  })

  it('marks a detached HEAD and a repository without an origin as facts, not missing data', async () => {
    await init()
    await git(root, 'switch', '--detach')
    expect(await read(root)).toEqual({
      branch: null, branchStatus: 'detached', commit: oid, commitStatus: 'observed', remoteStatus: 'absent'
    })
  })

  it('separates an unnameable origin from a missing one', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', '/Users/fixture/local-clone')
    expect(await read(root)).toEqual({
      branch: 'feature/first', branchStatus: 'observed', commit: oid, commitStatus: 'observed', remoteStatus: 'unsupported'
    })
  })

  it('omits location in a non-Git directory or unrecognized layout', async () => {
    expect(await read(root)).toEqual({})
    await writeFile(join(root, '.git'), 'unrecognized\n')
    expect(await read(root)).toEqual({})
  })

  it('does not follow a symlinked config or read an oversized config', async () => {
    await init()
    const config = join(root, '.git', 'config')
    const other = join(root, 'config')
    const origin = '[remote "origin"]\nurl = https://example.invalid/repo\n'
    await writeFile(other, origin)
    await rm(config)
    await symlink(other, config)
    expect(await read(root)).toEqual({
      branch: 'feature/first', branchStatus: 'observed', commit: oid, commitStatus: 'observed', remoteStatus: 'unavailable'
    })
    await rm(config)
    await writeFile(config, `${origin}${'#'.repeat(65_536)}`)
    expect(await read(root)).toEqual({
      branch: 'feature/first', branchStatus: 'observed', commit: oid, commitStatus: 'observed', remoteStatus: 'unavailable'
    })
  })
})

it.each([
  ['https://fake-token@EXAMPLE.invalid/group/repo.git', 'example.invalid/group/repo'],
  ['ssh://git:fake-token@EXAMPLE.invalid:22/group/repo.git', 'example.invalid/group/repo'],
  ['ssh://git@EXAMPLE.invalid:2222/group/repo.git', 'example.invalid:2222/group/repo'],
  ['https://example.invalid/group/%40user/repo', undefined],
  ['https://fake-token@/example.invalid/group/repo', undefined],
  ['alice:fake-token@example.invalid/repo.git', undefined],
  ['file:///home/alice/repo', undefined],
  ['../local/repo', undefined],
  ['https://example.invalid/group/../repo', undefined],
  [`https://example.invalid/${'a'.repeat(1024)}`, undefined]
])('normalizes origin %s to %s', (url, expected) => {
  expect(normalizeGitOrigin(url)).toBe(expected)
})

describe('finish-time origin retry', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scry-git-remote-retry-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('reads the origin a lost start sample never saw', async () => {
    await git(root, 'init', '-b', 'main')
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    expect(await readTurnRepositoryRemote(root, Date.now() + 5_000)).toEqual({
      remote: 'example.invalid/group/repo', remoteStatus: 'observed'
    })
  })

  it('reports a fact when there is no origin and a miss when the config cannot be read', async () => {
    await git(root, 'init', '-b', 'main')
    expect(await readTurnRepositoryRemote(root, Date.now() + 5_000)).toEqual({ remoteStatus: 'absent' })
    const config = join(root, '.git', 'config')
    const other = join(root, 'config')
    await writeFile(other, '[remote "origin"]\nurl = https://example.invalid/repo\n')
    await rm(config)
    await symlink(other, config)
    expect(await readTurnRepositoryRemote(root, Date.now() + 5_000)).toEqual({ remoteStatus: 'unavailable' })
  })

  it('returns a miss without any read once the turn ceiling already passed', async () => {
    await git(root, 'init', '-b', 'main')
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    const started = Date.now()
    expect(await readTurnRepositoryRemote(root, Date.now() - 1)).toEqual({ remoteStatus: 'unavailable' })
    expect(Date.now() - started).toBeLessThan(REPOSITORY_REMOTE_RETRY.deadlineMs)
  })

  it('keeps 40 queued callers inside the turn ceiling', async () => {
    await git(root, 'init', '-b', 'main')
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    const started = Date.now()
    const results = await Promise.all(Array.from({ length: 40 }, () => readTurnRepositoryRemote(root, started + 400)))
    // The pool is 8 deep, so the tail waits; the ceiling, not the queue, decides when it stops.
    expect(Date.now() - started).toBeLessThan(REPOSITORY_REMOTE_RETRY.turnDeadlineMs + REPOSITORY_REMOTE_RETRY.deadlineMs)
    expect(results.every((result) => ['observed', 'absent', 'unsupported', 'unavailable'].includes(result.remoteStatus))).toBe(true)
  })
})

it('publishes no fields if the read budget is already spent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-expired-location-'))
  try {
    await git(root, 'init', '-b', 'main')
    const fields: unknown[] = []
    await readGitRepositoryLocation(root, Date.now() - 1, true, match => fields.push(match))
    expect(fields).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
