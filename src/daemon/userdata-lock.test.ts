import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireUserDataLock, USERDATA_LOCK_NAME } from './userdata-lock'
import type { ProcessSnapshot } from '../main/process-diagnostics'

// Every test runs against its own temporary userData; nothing here touches a real one.
const dirs: string[] = []
function tempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-userdata-lock-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function snapshot(rows: Array<[number, string, string?, string?]>): () => ProcessSnapshot {
  const map = new Map(rows.map(([pid, startedAt, status, command]) => [pid, {
    pid, startedAt, command: command ?? '/opt/Scry/out/main/daemon.js', status: status ?? 'S', ppid: 1
  }]))
  return () => map
}

const lockPath = (userDataDir: string): string => join(userDataDir, USERDATA_LOCK_NAME)
const readLock = (userDataDir: string): Record<string, unknown> => JSON.parse(readFileSync(lockPath(userDataDir), 'utf8'))

describe('userData owner lock', () => {
  it('records the owning daemon in a 0600 file at the userData root without widening or narrowing the directory', async () => {
    const userDataDir = tempUserData()
    chmodSync(userDataDir, 0o755)
    const outcome = await acquireUserDataLock({
      userDataDir, role: 'daemon', startedBy: 'app', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']])
    })
    expect(outcome.status).toBe('acquired')
    expect(statSync(lockPath(userDataDir)).mode & 0o777).toBe(0o600)
    // userData belongs to Electron; the lock must not rewrite its permissions.
    expect(statSync(userDataDir).mode & 0o777).toBe(0o755)
    expect(readLock(userDataDir)).toMatchObject({ pid: 4001, startedAt: 'Mon Jan  1 00:00:00 2026', role: 'daemon', startedBy: 'app' })
  })

  it('refuses a second writer while the holder is alive and leaves its record untouched', async () => {
    const userDataDir = tempUserData()
    const lister = snapshot([[4001, 'Mon Jan  1 00:00:00 2026'], [4002, 'Mon Jan  1 00:00:01 2026']])
    expect((await acquireUserDataLock({ userDataDir, role: 'daemon', startedBy: 'first', pid: 4001, lister })).status).toBe('acquired')
    const before = readFileSync(lockPath(userDataDir), 'utf8')
    const second = await acquireUserDataLock({ userDataDir, role: 'daemon', startedBy: 'second', pid: 4002, lister })
    expect(second.status).toBe('owned')
    expect(second.status === 'owned' && second.holder).toMatchObject({ pid: 4001, role: 'daemon' })
    expect(second.status === 'owned' && second.reason).toBe('live-holder')
    expect(readFileSync(lockPath(userDataDir), 'utf8')).toBe(before)
  })

  it('takes over a lock whose holder pid is dead', async () => {
    const userDataDir = tempUserData()
    await acquireUserDataLock({ userDataDir, role: 'daemon', startedBy: 'crashed', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    const next = await acquireUserDataLock({
      userDataDir, role: 'daemon', startedBy: 'restarted', pid: 4002, lister: snapshot([[4002, 'Tue Feb  2 00:00:01 2026']])
    })
    expect(next.status).toBe('acquired')
    expect(next.status === 'acquired' && next.previous?.pid).toBe(4001)
    expect(readLock(userDataDir)).toMatchObject({ pid: 4002, startedBy: 'restarted' })
  })

  it('takes over when the holder pid now belongs to another process with a different start identity', async () => {
    const userDataDir = tempUserData()
    writeFileSync(lockPath(userDataDir), `${JSON.stringify({
      pid: 5003, startedAt: 'Tue Feb  2 00:00:00 2026', identityKey: '5003:Tue Feb  2 00:00:00 2026', startedBy: 'previous-boot', role: 'daemon'
    })}\n`)
    const next = await acquireUserDataLock({
      userDataDir, role: 'daemon', startedBy: 'this-boot', pid: 5004,
      lister: snapshot([
        // Same pid, later start time: the daemon that wrote the lock is gone.
        [5003, 'Tue Feb  2 00:00:09 2026', 'S', '/usr/bin/vim'],
        [5004, 'Tue Feb  2 00:00:10 2026']
      ])
    })
    expect(next.status).toBe('acquired')
    expect(next.status === 'acquired' && next.previous?.pid).toBe(5003)
    expect(readLock(userDataDir)).toMatchObject({ pid: 5004, startedBy: 'this-boot' })
  })

  it('refuses when a reused pid looks like Scry and the recorded identity cannot be compared', async () => {
    const userDataDir = tempUserData()
    writeFileSync(lockPath(userDataDir), `${JSON.stringify({
      pid: 5003, startedAt: 'Mon Jan  1 00:00:00 2026', identityKey: '', startedBy: 'legacy', role: 'daemon'
    })}\n`)
    const next = await acquireUserDataLock({
      userDataDir, role: 'daemon', startedBy: 'second', pid: 5004,
      lister: snapshot([[5003, 'Tue Feb  2 00:00:01 2026', 'S', '/Applications/Scry.app/Contents/MacOS/Scry'], [5004, 'Tue Feb  2 00:00:02 2026']])
    })
    expect(next.status).toBe('owned')
    expect(next.status === 'owned' && next.reason).toBe('identity-unverifiable')
  })

  it('release removes only its own record and leaves a successor in place', async () => {
    const userDataDir = tempUserData()
    const first = await acquireUserDataLock({ userDataDir, role: 'daemon', startedBy: 'first', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    if (first.status !== 'acquired') throw new Error('expected acquired')
    first.release()
    expect(existsSync(lockPath(userDataDir))).toBe(false)

    const again = await acquireUserDataLock({ userDataDir, role: 'daemon', startedBy: 'again', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    if (again.status !== 'acquired') throw new Error('expected acquired')
    const successor = await acquireUserDataLock({ userDataDir, role: 'daemon', startedBy: 'successor', pid: 4002, lister: snapshot([[4002, 'Tue Feb  2 00:00:01 2026']]) })
    expect(successor.status).toBe('acquired')
    again.release()
    expect(readLock(userDataDir)).toMatchObject({ pid: 4002, startedBy: 'successor' })
  })

  it('keeps its takeover mutex apart from the daemon lock in the same directory', async () => {
    const userDataDir = tempUserData()
    // A takeover in progress for daemon.lock must not block or be mistaken for this lock's.
    writeFileSync(join(userDataDir, 'daemon.lock.takeover'), '')
    await acquireUserDataLock({ userDataDir, role: 'daemon', startedBy: 'crashed', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    const next = await acquireUserDataLock({
      userDataDir, role: 'daemon', startedBy: 'restarted', pid: 4002, lister: snapshot([[4002, 'Tue Feb  2 00:00:01 2026']]),
      sleep: async () => { throw new Error('waited on the wrong mutex') }
    })
    expect(next.status).toBe('acquired')
    expect(existsSync(join(userDataDir, 'daemon.lock.takeover'))).toBe(true)
  })
})
