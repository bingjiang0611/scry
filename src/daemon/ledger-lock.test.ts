import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDaemonLock, DAEMON_LOCK_NAME } from './ledger-lock'
import type { ProcessSnapshot } from '../main/process-diagnostics'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-lock-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function snapshot(rows: Array<[number, string, string?]>): () => ProcessSnapshot {
  const map = new Map(rows.map(([pid, startedAt, status]) => [pid, {
    pid, startedAt, command: 'node daemon.js', status: status ?? 'S'
  }]))
  return () => map
}

describe('daemon ledger lock', () => {
  it('writes a 0600 record describing this process', () => {
    const directory = tempDir()
    const outcome = acquireDaemonLock({ directory, startedBy: 'test', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    expect(outcome.status).toBe('acquired')
    const path = join(directory, DAEMON_LOCK_NAME)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    expect(record).toMatchObject({ pid: 4001, startedAt: 'Mon Jan  1 00:00:00 2026', startedBy: 'test' })
  })

  it('refuses a second daemon while the holder is alive, leaving the record untouched', () => {
    const directory = tempDir()
    const lister = snapshot([[4001, 'Mon Jan  1 00:00:00 2026'], [4002, 'Mon Jan  1 00:00:01 2026']])
    expect(acquireDaemonLock({ directory, startedBy: 'first', pid: 4001, lister }).status).toBe('acquired')
    const before = readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')
    const second = acquireDaemonLock({ directory, startedBy: 'second', pid: 4002, lister })
    expect(second.status).toBe('already-running')
    expect(second.status === 'already-running' && second.holder.pid).toBe(4001)
    expect(readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')).toBe(before)
  })

  it('refuses when the pid was reused instead of killing the new owner', () => {
    const directory = tempDir()
    expect(acquireDaemonLock({
      directory, startedBy: 'first', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']])
    }).status).toBe('acquired')
    const reused = acquireDaemonLock({
      directory, startedBy: 'second', pid: 4002,
      lister: snapshot([[4001, 'Tue Feb  2 00:00:00 2026'], [4002, 'Tue Feb  2 00:00:01 2026']])
    })
    expect(reused.status).toBe('identity-changed')
    expect(reused.status === 'identity-changed' && reused.holder.startedAt).toBe('Mon Jan  1 00:00:00 2026')
  })

  it('takes over when the holder is gone or a zombie', () => {
    for (const [status, row] of [['missing', undefined], ['zombie', 'Z+']] as const) {
      const directory = tempDir()
      expect(acquireDaemonLock({
        directory, startedBy: 'first', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']])
      }).status).toBe('acquired')
      const next = acquireDaemonLock({
        directory, startedBy: 'second', pid: 4002,
        lister: snapshot([[4002, 'Tue Feb  2 00:00:01 2026'], ...(row ? [[4001, 'Mon Jan  1 00:00:00 2026', row] as [number, string, string]] : [])])
      })
      expect(next.status, status).toBe('replaced-stale')
    }
  })

  it('treats an unparsable lock as stale rather than blocking startup', () => {
    const directory = tempDir()
    writeFileSync(join(directory, DAEMON_LOCK_NAME), 'not json')
    const outcome = acquireDaemonLock({ directory, startedBy: 'test', pid: 4003, lister: snapshot([[4003, 'Mon Jan  1 00:00:00 2026']]) })
    expect(outcome.status).toBe('replaced-stale')
  })

  it('release removes only its own record', () => {
    const directory = tempDir()
    const first = acquireDaemonLock({ directory, startedBy: 'first', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    expect(first.status).toBe('acquired')
    if (first.status !== 'acquired') return
    const successor = acquireDaemonLock({
      directory, startedBy: 'second', pid: 4002,
      lister: snapshot([[4002, 'Tue Feb  2 00:00:01 2026']])
    })
    expect(successor.status).toBe('replaced-stale')
    first.release()
    expect(JSON.parse(readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')).pid).toBe(4002)
  })
})
