import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { observeSessionStatus, parseRemoteWorkspaceQuery, readRemoteWorkspace } from './remote-workspace'
import type { ActiveRun } from '../../shared/trace'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'scry-workspace-read-')))
  dirs.push(cwd)
  const authorize = vi.fn((path: string) => { if (path !== cwd) throw new Error('workspace_not_authorized'); return cwd })
  return { cwd, authority: { authorize } }
}

describe('remote workspace read contract', () => {
  it('rejects unknown actions and malformed pagination before reading', () => {
    for (const query of [null, [], { action: 'write', cwd: '/x' }, { action: 'file', cwd: '/x', path: 'a', offset: -1 },
      { action: 'list', cwd: '/x', path: 3 }, { action: 'status', cwd: '/x', providerId: '', externalSessionId: 's' }]) {
      expect(() => parseRemoteWorkspaceQuery(query)).toThrow('invalid_request')
    }
  })

  it('re-authorizes every read and rejects traversal, absolute paths and escaping symlinks', async () => {
    const { cwd, authority } = fixture()
    const outside = fixture().cwd
    writeFileSync(join(outside, 'secret'), 'outside')
    symlinkSync(outside, join(cwd, 'escape'))
    for (const path of ['../secret', join(outside, 'secret'), 'escape/secret']) {
      await expect(readRemoteWorkspace(authority, { action: 'file', cwd, path })).rejects.toThrow()
    }
    const status = vi.fn(() => 'running' as const)
    await expect(readRemoteWorkspace(authority, { action: 'status', cwd: outside, providerId: 'pi', externalSessionId: 's' }, status))
      .rejects.toThrow('workspace_not_authorized')
    expect(status).not.toHaveBeenCalled()
    expect(authority.authorize).toHaveBeenCalledTimes(4)
  })

  it('returns real paginated files, preserves UTF-8 and rejects changed-file continuation', async () => {
    const { cwd, authority } = fixture()
    const content = '文'.repeat(30_000)
    writeFileSync(join(cwd, 'text.md'), content)
    const first = await readRemoteWorkspace(authority, { action: 'file', cwd, path: 'text.md' })
    if (first.action !== 'file') throw new Error('wrong response')
    expect(first.file.content).not.toContain('\ufffd')
    expect(first.file.hasMore).toBe(true)
    const second = await readRemoteWorkspace(authority, { action: 'file', cwd, path: 'text.md', offset: first.file.nextOffset, snapshot: first.file.snapshot })
    if (second.action !== 'file') throw new Error('wrong response')
    expect(first.file.content + second.file.content).toBe(content)
    writeFileSync(join(cwd, 'text.md'), 'changed')
    await expect(readRemoteWorkspace(authority, { action: 'file', cwd, path: 'text.md', offset: first.file.nextOffset, snapshot: first.file.snapshot })).rejects.toThrow()
    writeFileSync(join(cwd, 'binary'), Buffer.from([0, 1, 2, 0xff]))
    await expect(readRemoteWorkspace(authority, { action: 'file', cwd, path: 'binary' })).rejects.toThrow()
  })

  it('pages directories without inventing empty entries or duplicates', async () => {
    const { cwd, authority } = fixture()
    for (let index = 0; index < 105; index++) writeFileSync(join(cwd, `f-${index}`), '')
    const first = await readRemoteWorkspace(authority, { action: 'list', cwd, path: '' })
    if (first.action !== 'list') throw new Error('wrong response')
    expect(first.listing.entries).toHaveLength(100)
    expect(first.listing.nextCursor).toBeTruthy()
    const second = await readRemoteWorkspace(authority, { action: 'list', cwd, path: '', cursor: first.listing.nextCursor })
    if (second.action !== 'list') throw new Error('wrong response')
    expect(second.listing.entries).toHaveLength(5)
    expect(new Set([...first.listing.entries, ...second.listing.entries].map(entry => entry.path)).size).toBe(105)
  })

  it('distinguishes unavailable Git from clean and returns bounded HEAD diff including untracked files without changing the index', async () => {
    const { cwd, authority } = fixture()
    const unavailable = await readRemoteWorkspace(authority, { action: 'diff', cwd })
    expect(unavailable).toMatchObject({ action: 'diff', diff: { status: 'unavailable', reason: 'not_git' } })
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TEMPLATE_DIR: '' }
    const git = (...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' })
    git('init')
    writeFileSync(join(cwd, 'tracked'), 'before\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'fixture')
    expect(await readRemoteWorkspace(authority, { action: 'diff', cwd })).toMatchObject({ diff: { status: 'captured', patch: '', truncated: false } })
    const index = readFileSync(join(cwd, '.git/index'))
    writeFileSync(join(cwd, 'tracked'), 'after\n')
    writeFileSync(join(cwd, 'new file'), 'untracked\n')
    const result = await readRemoteWorkspace(authority, { action: 'diff', cwd })
    if (result.action !== 'diff') throw new Error('wrong response')
    expect(result.diff.status).toBe('captured')
    expect(result.diff.patch).toContain('+untracked')
    expect(result.diff.patch).toContain('-before')
    expect(result.diff.patch).toContain('+after')
    expect(readFileSync(join(cwd, '.git/index'))).toEqual(index)
    mkdirSync(join(cwd, 'sub'))
    writeFileSync(join(cwd, 'sub/a'), '文'.repeat(40_000))
    const large = await readRemoteWorkspace(authority, { action: 'diff', cwd })
    if (large.action !== 'diff') throw new Error('wrong response')
    expect(large.diff.status).toBe('captured')
    expect(large.diff.truncated).toBe(true)
    expect(Buffer.byteLength(large.diff.patch)).toBeLessThanOrEqual(65536)
    expect(large.diff.patch).not.toContain('\ufffd')
  })

  it('matches provider, profile, canonical cwd and session; absence is not completion', () => {
    const query = { providerId: 'pi', agentProfileId: 'pi:a', cwd: '/repo', externalSessionId: 'session' }
    const active = { ...query, done: false, pendingQuestions: [] } as unknown as ActiveRun
    expect(observeSessionStatus(query, [active])).toBe('running')
    expect(observeSessionStatus({ ...query, agentProfileId: 'pi:b' }, [active])).toBe('not_observed')
    expect(observeSessionStatus({ ...query, providerId: 'codex' }, [active])).toBe('not_observed')
    expect(observeSessionStatus({ ...query, cwd: '/different' }, [active])).toBe('not_observed')
    expect(observeSessionStatus({ ...query, externalSessionId: 'different' }, [active])).toBe('not_observed')
    expect(observeSessionStatus(query, [{ ...active, done: true }])).toBe('not_observed')
    expect(observeSessionStatus(query, [{ ...active, pendingQuestions: [{}] } as ActiveRun])).toBe('waiting')
  })
})
