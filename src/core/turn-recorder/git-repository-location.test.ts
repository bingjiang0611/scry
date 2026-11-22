import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TurnRepositoryLocation } from '../../shared/turn-repository-location'
import { normalizeGitOrigin, readGitRepositoryLocation } from './git-repository-location'

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd })
  return stdout.trim()
}

async function read(root: string): Promise<TurnRepositoryLocation> {
  const location = {}
  await readGitRepositoryLocation(root, Date.now() + 1000, true, fields => Object.assign(location, fields))
  return location
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
    expect(await read(root)).toEqual({ branch: 'feature/first', commitBefore: oid, remote: 'example.invalid/group/repo' })
  })

  it('reads a linked worktree HEAD and resolves its packed ref and origin in the common directory', async () => {
    await init()
    await git(root, 'remote', 'add', 'origin', 'git@example.invalid:group/repo.git')
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'worktree/second', linked)
    await git(root, 'pack-refs', '--all')
    expect(await read(linked)).toEqual({ branch: 'worktree/second', commitBefore: oid, remote: 'example.invalid/group/repo' })
  })

  it('handles a gitdir pointer without a worktree commondir', async () => {
    await init(join(root, 'metadata'))
    await writeFile(join(root, '.git'), 'gitdir: metadata\n')
    expect(await read(root)).toEqual({ branch: 'feature/first', commitBefore: oid })
  })

  it('marks a detached HEAD and omits a missing remote', async () => {
    await init()
    await git(root, 'switch', '--detach')
    expect(await read(root)).toEqual({ branch: null, commitBefore: oid })
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
    expect(await read(root)).toEqual({ branch: 'feature/first', commitBefore: oid })
    await rm(config)
    await writeFile(config, `${origin}${'#'.repeat(65_536)}`)
    expect(await read(root)).toEqual({ branch: 'feature/first', commitBefore: oid })
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
