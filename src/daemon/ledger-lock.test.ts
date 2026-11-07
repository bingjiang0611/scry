import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDaemonLock, readDaemonIdentity, DAEMON_LOCK_NAME } from './ledger-lock'
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

function snapshot(rows: Array<[number, string, string?, string?]>): () => ProcessSnapshot {
  const map = new Map(rows.map(([pid, startedAt, status, command]) => [pid, {
    pid, startedAt, command: command ?? 'node daemon.js', status: status ?? 'S', ppid: 1
  }]))
  return () => map
}

describe('daemon ledger lock', () => {
  it('writes a 0600 record describing this process', async () => {
    const directory = tempDir()
    const outcome = await acquireDaemonLock({ directory, startedBy: 'test', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    expect(outcome.status).toBe('acquired')
    const path = join(directory, DAEMON_LOCK_NAME)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    expect(record).toMatchObject({ pid: 4001, startedAt: 'Mon Jan  1 00:00:00 2026', startedBy: 'test' })
  })

  it('refuses a second daemon while the holder is alive, leaving the record untouched', async () => {
    const directory = tempDir()
    const lister = snapshot([[4001, 'Mon Jan  1 00:00:00 2026'], [4002, 'Mon Jan  1 00:00:01 2026']])
    expect((await acquireDaemonLock({ directory, startedBy: 'first', pid: 4001, lister })).status).toBe('acquired')
    const before = readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')
    const second = await acquireDaemonLock({ directory, startedBy: 'second', pid: 4002, lister })
    expect(second.status).toBe('already-running')
    expect(second.status === 'already-running' && second.holder.pid).toBe(4001)
    expect(readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')).toBe(before)
  })

  it('takes over when the holder is gone or a zombie', async () => {
    for (const [status, row] of [['missing', undefined], ['zombie', 'Z+']] as const) {
      const directory = tempDir()
      expect((await acquireDaemonLock({
        directory, startedBy: 'first', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']])
      })).status).toBe('acquired')
      const next = await acquireDaemonLock({
        directory, startedBy: 'second', pid: 4002,
        lister: snapshot([[4002, 'Tue Feb  2 00:00:01 2026'], ...(row ? [[4001, 'Mon Jan  1 00:00:00 2026', row] as [number, string, string]] : [])])
      })
      expect(next.status, status).toBe('replaced-stale')
    }
  })

  it('treats an unparsable lock as stale rather than blocking startup', async () => {
    const directory = tempDir()
    writeFileSync(join(directory, DAEMON_LOCK_NAME), 'not json')
    const outcome = await acquireDaemonLock({ directory, startedBy: 'test', pid: 4003, lister: snapshot([[4003, 'Mon Jan  1 00:00:00 2026']]) })
    expect(outcome.status).toBe('replaced-stale')
  })

  it('release removes only its own record', async () => {
    const directory = tempDir()
    const first = await acquireDaemonLock({ directory, startedBy: 'first', pid: 4001, lister: snapshot([[4001, 'Mon Jan  1 00:00:00 2026']]) })
    expect(first.status).toBe('acquired')
    if (first.status !== 'acquired') return
    const successor = await acquireDaemonLock({
      directory, startedBy: 'second', pid: 4002,
      lister: snapshot([[4002, 'Tue Feb  2 00:00:01 2026']])
    })
    expect(successor.status).toBe('replaced-stale')
    first.release()
    expect(JSON.parse(readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')).pid).toBe(4002)
  })
})

describe('daemon lock L1: PID reuse must not lock the daemon out', () => {
  it('takes over a reused pid instead of refusing to start', async () => {
    const directory = tempDir()
    await acquireDaemonLock({ directory, startedBy: 'first', pid: 5001, lister: snapshot([[5001, 'Mon Jan  1 00:00:00 2026']]) })
    // Same pid, different start time, different program: the daemon that wrote this
    // lock is gone and the pid now belongs to someone else.
    const next = await acquireDaemonLock({
      directory, startedBy: 'second', pid: 5002,
      lister: snapshot([[5001, 'Tue Feb  2 00:00:00 2026', 'S', '/usr/bin/other'], [5002, 'Tue Feb  2 00:00:01 2026']]),
      daemonEntry: 'scry-daemon'
    })
    expect(next.status).toBe('replaced-stale')
    expect(next.status === 'replaced-stale' && next.reason).toBe('pid-reused')
    expect(JSON.parse(readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')).pid).toBe(5002)
  })

  it('can never signal the process that reused the pid', () => {
    // Takeover is a file operation only; the module has no way to kill anyone.
    const source = readFileSync(join(__dirname, 'ledger-lock.ts'), 'utf8')
    expect(source).not.toMatch(/process\.kill|signalProcessTree/)
  })

  it('takes over a stale lock whose pid is this live process with a different identity', async () => {
    const directory = tempDir()
    // A previous boot left a lock under a pid the OS has since handed to this process.
    writeFileSync(join(directory, DAEMON_LOCK_NAME), `${JSON.stringify({
      pid: process.pid,
      startedAt: 'Mon Jan  1 00:00:00 2026',
      identityKey: `${process.pid}:Mon Jan  1 00:00:00 2026`,
      startedBy: 'previous-boot'
    })}\n`)
    const next = await acquireDaemonLock({
      directory,
      startedBy: 'this-boot',
      lister: snapshot([[process.pid, 'Tue Feb  2 00:00:00 2026', 'S', '/Applications/Scry.app/Contents/MacOS/Scry']])
    })
    expect(next.status).toBe('replaced-stale')
    expect(next.status === 'replaced-stale' && next.reason).toBe('pid-reused')
    expect(JSON.parse(readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')).startedBy).toBe('this-boot')
  })

  it('takes over when a comparable start identity proves the previous holder is gone', async () => {
    const directory = tempDir()
    // A lock whose recorded identity uses the platform's comparable format: macOS lstart
    // comes from the kernel's absolute start time, so a different value is real evidence.
    writeFileSync(join(directory, DAEMON_LOCK_NAME), `${JSON.stringify({
      pid: 5003,
      startedAt: 'Tue Feb  2 00:00:00 2026',
      identityKey: '5003:Tue Feb  2 00:00:00 2026',
      startedBy: 'previous-boot'
    })}\n`)
    const next = await acquireDaemonLock({
      directory, startedBy: 'this-boot', pid: 5004,
      lister: snapshot([
        [5003, 'Tue Feb  2 00:00:01 2026', 'S', '/Applications/Scry.app/Contents/MacOS/Scry'],
        [5004, 'Tue Feb  2 00:00:02 2026']
      ])
    })
    expect(next.status).toBe('replaced-stale')
    expect(next.status === 'replaced-stale' && next.reason).toBe('pid-reused')
  })

  it('refuses to take over a legacy record whose identity format cannot be compared', async () => {
    const directory = tempDir()
    writeFileSync(join(directory, DAEMON_LOCK_NAME), `${JSON.stringify({
      pid: 5003,
      startedAt: 'Mon Jan  1 00:00:00 2026',
      identityKey: '',
      startedBy: 'previous-boot'
    })}\n`)
    const next = await acquireDaemonLock({
      directory, startedBy: 'second', pid: 5004,
      lister: snapshot([
        [5003, 'Tue Feb  2 00:00:01 2026', 'S', '/Applications/Scry.app/Contents/MacOS/Scry'],
        [5004, 'Tue Feb  2 00:00:02 2026']
      ]),
      daemonEntry: 'scry-daemon'
    })
    expect(next.status).toBe('already-running')
    expect(next.status === 'already-running' && next.reason).toBe('identity-unverifiable')
  })

  it('reads start times under TZ=UTC so a timezone change cannot fake a new identity', () => {
    const originalTz = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      const eastern = readDaemonIdentity(process.pid)
      process.env.TZ = 'Asia/Tokyo'
      const tokyo = readDaemonIdentity(process.pid)
      expect(eastern?.startedAt).toBeTruthy()
      expect(tokyo?.startedAt).toBe(eastern?.startedAt)
      expect(tokyo?.identityKey).toBe(eastern?.identityKey)
    } finally {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    }
  })
})

describe('daemon lock L2: concurrent takeover yields one owner', () => {
  it('lets exactly one daemon replace a stale lock', async () => {
    const directory = tempDir()
    await acquireDaemonLock({ directory, startedBy: 'first', pid: 6001, lister: snapshot([[6001, 'Mon Jan  1 00:00:00 2026']]) })
    // 6001 is now a zombie (stale), 6002 and 6003 are the two candidates.
    const lister = snapshot([
      [6001, 'Mon Jan  1 00:00:00 2026', 'Z+'],
      [6002, 'Tue Feb  2 00:00:01 2026'],
      [6003, 'Tue Feb  2 00:00:02 2026']
    ])
    let second: Promise<Awaited<ReturnType<typeof acquireDaemonLock>>> | undefined
    // The hook runs after this daemon decided to take over and while it holds the
    // takeover mutex: exactly the window that used to let two writers in.
    const first = await acquireDaemonLock({
      directory, startedBy: 'first-again', pid: 6002, lister,
      afterValidate: () => { second ??= acquireDaemonLock({ directory, startedBy: 'second', pid: 6003, lister }) }
    })
    const other = await second!
    expect([first.status, other.status].sort()).toEqual(['already-running', 'replaced-stale'])
    expect(JSON.parse(readFileSync(join(directory, DAEMON_LOCK_NAME), 'utf8')).pid).toBe(6002)
  })
})
