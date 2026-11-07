import {
  chmodSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverDeadRemoteLease } from './recover-dead-lease'
import type { ProcessRow } from '../process-diagnostics'
import { utcRemoteProcessSnapshot } from './remote-lease-owner'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), linkSync: vi.fn(fs.linkSync) }
})
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const roots: string[] = []
const NAME = 'run-output.lock'

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fsyncSync).mockReset().mockImplementation(realFs.fsyncSync)
  vi.mocked(linkSync).mockReset().mockImplementation(realFs.linkSync)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scry-lease-recovery-'))
  chmodSync(directory, 0o700)
  roots.push(directory)
  const startedAt = utcRemoteProcessSnapshot().get(process.pid)!.startedAt
  const owner = { pid: process.pid, lease: randomUUID(), createdAt: 0, startedAt, identityKey: `${process.pid}:${startedAt}` }
  const path = join(directory, NAME)
  writeFileSync(path, JSON.stringify(owner), { mode: 0o600 })
  return { directory, path, owner }
}

function deadOwner(): void {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not running'), { code: 'ESRCH' }) })
}

describe('trusted remote lease recovery', () => {
  it('never uses age to steal a live PID, and only probes with signal zero', () => {
    const { directory, path, owner } = fixture()
    const probe = vi.spyOn(process, 'kill')
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow('owner_alive')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(owner)
    expect(readdirSync(directory)).toEqual([NAME])
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, 0)
  })

  it('recovers a reused PID only when its UTC process identity proves the old owner is gone', () => {
    const { directory, path, owner } = fixture()
    const row: ProcessRow = { pid: owner.pid, ppid: 1, status: 'S', startedAt: 'Fri Jan  2 00:00:00 1970', command: 'reused' }
    const recover = recoverDeadRemoteLease as unknown as typeof recoverDeadRemoteLease &
      ((directory: string, name: typeof NAME, options: { lister: () => ReadonlyMap<number, ProcessRow> }) => void)
    recover(directory, NAME, { lister: () => new Map([[owner.pid, row]]) })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses takeover when the same pid start time shifts by one second but command is Scry', () => {
    const { directory, path, owner } = fixture()
    const row: ProcessRow = {
      pid: owner.pid,
      ppid: 1,
      status: 'S',
      startedAt: owner.startedAt.replace(/(\d{2}):(\d{2}):(\d{2})/, (_all, h, m, s) => `${h}:${m}:${String(Number(s) + 1).padStart(2, '0')}`),
      command: '/Applications/Scry.app/Contents/MacOS/Scry --daemon'
    }
    expect(() => recoverDeadRemoteLease(directory, NAME, { lister: () => new Map([[owner.pid, row]]) }))
      .toThrow('identity_unverifiable')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(owner)
  })

  it('refuses takeover when a live PID identity cannot be determined', () => {
    const { directory, path, owner } = fixture()
    const recover = recoverDeadRemoteLease as unknown as typeof recoverDeadRemoteLease &
      ((directory: string, name: typeof NAME, options: { lister: () => ReadonlyMap<number, ProcessRow> }) => void)
    expect(() => recover(directory, NAME, { lister: () => new Map() })).toThrow('identity_unverifiable')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(owner)
  })

  it.each(['EPERM', 'EIO'])('preserves the lock when process identity is unconfirmed (%s)', (code) => {
    const { directory, path, owner } = fixture()
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow(code)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(owner)
  })

  it('retains exact dead-owner evidence and permits a fresh lease, without deleting a successor', () => {
    const { directory, path, owner } = fixture()
    deadOwner()
    recoverDeadRemoteLease(directory, NAME)
    expect(existsSync(path)).toBe(false)
    const claim = join(directory, `.recovered-${NAME}-${owner.lease}`)
    expect(JSON.parse(readFileSync(join(claim, 'owner.json'), 'utf8'))).toEqual(owner)
    recoverDeadRemoteLease(directory, NAME) // no active lease is an honest no-op
    writeFileSync(path, JSON.stringify(owner), { mode: 0o600 })
    // A second recoverer with the same old incarnation cannot remove a successor's name.
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow()
    expect(existsSync(path)).toBe(true)
  })

  it.each(['', '{', '{"pid":0}', JSON.stringify({ pid: -1, lease: randomUUID(), createdAt: 0 })])('rejects malformed or partial owner %j', (body) => {
    const { directory, path } = fixture()
    writeFileSync(path, body)
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow('invalid_owner')
    expect(readFileSync(path, 'utf8')).toBe(body)
  })

  it.each(['symlink', 'hardlink', 'permissions', 'oversized'] as const)('rejects an unsafe lease file: %s', (kind) => {
    const { directory, path } = fixture()
    if (kind === 'symlink') {
      const target = join(directory, 'target')
      writeFileSync(target, readFileSync(path), { mode: 0o600 })
      unlinkSync(path)
      symlinkSync(target, path)
    }
    if (kind === 'hardlink') realFs.linkSync(path, join(directory, 'alias'))
    if (kind === 'permissions') chmodSync(path, 0o644)
    if (kind === 'oversized') writeFileSync(path, 'x'.repeat(4097))
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow()
    expect(existsSync(path)).toBe(true)
  })

  it('fails closed if recovery is interrupted after claiming, preserving evidence and the active name', () => {
    const { directory, path, owner } = fixture()
    deadOwner()
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('sync_failed') })
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow('sync_failed')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(owner)
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow('invalid_file')
    expect(existsSync(path)).toBe(true)
  })

  it('will not unlink a different file substituted before the identity check', () => {
    const { directory, path, owner } = fixture()
    deadOwner()
    const successor = { ...owner, lease: randomUUID() }
    vi.mocked(linkSync).mockImplementationOnce((source, target) => {
      realFs.linkSync(source, target)
      unlinkSync(path)
      writeFileSync(path, JSON.stringify(successor), { mode: 0o600 })
    })
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow('identity_changed')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(successor)
  })

  it('rejects a non-private or symlinked directory', () => {
    const { directory } = fixture()
    chmodSync(directory, 0o755)
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow('directory_not_private')
    chmodSync(directory, 0o700)
    const alias = join(directory, 'alias')
    symlinkSync(directory, alias)
    expect(() => recoverDeadRemoteLease(alias, NAME)).toThrow('directory_not_private')
  })

  it('honors an existing exclusive recovery claim before touching the active name', () => {
    const { directory, path, owner } = fixture()
    deadOwner()
    mkdirSync(join(directory, `.recovered-${NAME}-${owner.lease}`), { mode: 0o700 })
    expect(() => recoverDeadRemoteLease(directory, NAME)).toThrow()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(owner)
  })
})
