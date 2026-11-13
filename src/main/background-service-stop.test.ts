import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { DaemonLockRecord } from '../daemon/ledger-lock'
import type { ProcessRow } from './process-diagnostics'
import { backgroundServiceLeftovers, prepareBackgroundServiceStop, stopBackgroundService, type BackgroundServiceStopDeps } from './background-service-stop'

// The §13.2 stop chain: only the daemon.lock holder, only while its identity still
// verifies, one SIGTERM, a bounded wait, and a named refusal for everything else.

const STATE = '/u/daemon'
const USER = '/u'
const LOCK = join(STATE, 'daemon.lock')
const KEY = '4242:linux:boot:777'
const holder: DaemonLockRecord = { pid: 4242, startedAt: 'linux:boot:777', identityKey: KEY, startedBy: 'supervisor:4000' }
const daemonRow: ProcessRow = { pid: 4242, ppid: 4000, status: 'S', startedAt: 'linux:boot:777', identityKey: KEY, command: '/Scry --daemon out/main/daemon.js' }
const supervisorRow: ProcessRow = { pid: 4000, ppid: 1, status: 'S', startedAt: 'linux:boot:700', identityKey: '4000:linux:boot:700', command: '/Scry out/main/daemon-supervisor.js' }

interface World {
  files: Map<string, string>
  rows: Map<number, ProcessRow>
  signals: Array<[number, string]>
  clock: number
}

function world(): World {
  return { files: new Map([[LOCK, JSON.stringify(holder)]]), rows: new Map([[4242, daemonRow], [4000, supervisorRow]]), signals: [], clock: 0 }
}

function deps(w: World, extra: Partial<BackgroundServiceStopDeps> = {}): BackgroundServiceStopDeps {
  return {
    paths: { stateDirectory: STATE, userDataDir: USER },
    readText: async (path) => w.files.get(path),
    readIdentity: async (pid) => w.rows.get(pid),
    exists: async (path) => w.files.has(path),
    signal: (pid, name) => { w.signals.push([pid, name]) },
    sleep: async (ms) => { w.clock += ms },
    now: () => w.clock,
    pollMs: 100,
    stopTimeoutMs: 1_000,
    supervisorTimeoutMs: 500,
    ...extra
  }
}

/** The daemon exits (and drops its lock) once it has been signalled. */
function exitOnSignal(w: World): BackgroundServiceStopDeps['signal'] {
  return (pid, name) => {
    w.signals.push([pid, name])
    w.rows.delete(4242)
    w.rows.delete(4000)
    w.files.delete(LOCK)
  }
}

describe('prepareBackgroundServiceStop', () => {
  it('names the lock holder only when its live identity matches the record', async () => {
    const w = world()
    await expect(prepareBackgroundServiceStop(deps(w))).resolves.toEqual({ status: 'running', holder })
    expect(w.signals).toEqual([])
  })

  it('reports nothing to stop without a lock, or when the holder already exited', async () => {
    const empty = world()
    empty.files.clear()
    await expect(prepareBackgroundServiceStop(deps(empty))).resolves.toEqual({ status: 'not-running' })
    const exited = world()
    exited.rows.delete(4242)
    await expect(prepareBackgroundServiceStop(deps(exited))).resolves.toEqual({ status: 'not-running' })
  })

  it('treats a comparable identity change as a reused pid, and refuses what it cannot read', async () => {
    const reused = world()
    reused.rows.set(4242, { ...daemonRow, startedAt: 'linux:boot:999', identityKey: '4242:linux:boot:999' })
    await expect(prepareBackgroundServiceStop(deps(reused))).resolves.toEqual({ status: 'not-running' })
    const corrupt = world()
    corrupt.files.set(LOCK, '{not json')
    await expect(prepareBackgroundServiceStop(deps(corrupt))).resolves.toEqual({ status: 'refused', reason: 'lock-unreadable' })
    const unreadable = world()
    await expect(prepareBackgroundServiceStop(deps(unreadable, { readIdentity: async () => { throw new Error('ps failed') } })))
      .resolves.toEqual({ status: 'refused', reason: 'identity-unreadable' })
    const unrecorded = world()
    unrecorded.files.set(LOCK, JSON.stringify({ ...holder, identityKey: '' }))
    await expect(prepareBackgroundServiceStop(deps(unrecorded))).resolves.toMatchObject({ status: 'refused', reason: 'identity-unrecorded' })
  })
})

describe('stopBackgroundService', () => {
  it('re-verifies, signals the holder once with SIGTERM, waits, and observes the supervisor exit', async () => {
    const w = world()
    const outcome = await stopBackgroundService(holder, deps(w, { signal: exitOnSignal(w) }))
    expect(outcome).toEqual({ status: 'stopped', holder, leftovers: [] })
    // Only the daemon: the supervisor has no identity record and is never signalled.
    expect(w.signals).toEqual([[4242, 'SIGTERM']])
  })

  it('sends no signal when the pid changed identity after the user was asked', async () => {
    const w = world()
    // Between the confirmation and the signal the pid was reused by another process.
    w.rows.set(4242, { ...daemonRow, startedAt: 'linux:boot:999', identityKey: '4242:linux:boot:999', command: '/usr/bin/vim' })
    await expect(stopBackgroundService(holder, deps(w))).resolves.toEqual({ status: 'refused', reason: 'identity-changed' })
    expect(w.signals).toEqual([])
  })

  it('sends no signal when the lock now names another holder or cannot be read', async () => {
    const changed = world()
    changed.files.set(LOCK, JSON.stringify({ ...holder, pid: 5000, identityKey: '5000:linux:boot:1' }))
    await expect(stopBackgroundService(holder, deps(changed))).resolves.toEqual({ status: 'refused', reason: 'lock-changed' })
    const unreadable = world()
    unreadable.files.set(LOCK, '')
    await expect(stopBackgroundService(holder, deps(unreadable))).resolves.toEqual({ status: 'refused', reason: 'lock-unreadable' })
    const blind = world()
    await expect(stopBackgroundService(holder, deps(blind, { readIdentity: async () => { throw new Error('ps') } })))
      .resolves.toEqual({ status: 'refused', reason: 'identity-unreadable' })
    expect([...changed.signals, ...unreadable.signals, ...blind.signals]).toEqual([])
  })

  it('does not signal a holder that already went away', async () => {
    const w = world()
    w.files.delete(LOCK)
    w.rows.delete(4242)
    await expect(stopBackgroundService(holder, deps(w))).resolves.toEqual({ status: 'already-stopped', leftovers: [] })
    expect(w.signals).toEqual([])
  })

  it('fails closed at the deadline: one signal, no second one, a named timeout', async () => {
    const w = world()
    const outcome = await stopBackgroundService(holder, deps(w))
    expect(outcome).toEqual({ status: 'refused', reason: 'stop-timeout' })
    expect(w.signals).toEqual([[4242, 'SIGTERM']])
    expect(w.clock).toBeGreaterThanOrEqual(1_000)
  })

  it('keeps waiting while the identity is unreadable instead of calling that an exit', async () => {
    const w = world()
    let signalled = false
    const outcome = await stopBackgroundService(holder, deps(w, {
      signal: (pid, name) => { w.signals.push([pid, name]); signalled = true },
      readIdentity: async (pid) => { if (signalled) throw new Error('ps timed out'); return w.rows.get(pid) }
    }))
    expect(outcome).toEqual({ status: 'refused', reason: 'stop-timeout' })
  })

  it('reports a refused signal and treats ESRCH as already gone', async () => {
    const denied = world()
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' })
    await expect(stopBackgroundService(holder, deps(denied, { signal: () => { throw eperm } })))
      .resolves.toEqual({ status: 'refused', reason: 'signal-failed' })
    const raced = world()
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    await expect(stopBackgroundService(holder, deps(raced, { signal: () => { throw esrch } })))
      .resolves.toMatchObject({ status: 'already-stopped' })
  })

  it('names a supervisor that outlives the daemon and what the daemon left behind', async () => {
    const w = world()
    w.files.set(join(STATE, 'local.sock'), '')
    w.files.set(join(USER, 'scry-userdata.lock'), JSON.stringify({ ...holder, role: 'daemon' }))
    const outcome = await stopBackgroundService(holder, deps(w, {
      signal: (pid, name) => { w.signals.push([pid, name]); w.rows.delete(4242) }
    }))
    expect(outcome).toEqual({ status: 'stopped', holder, leftovers: ['supervisor:4000', 'daemon.lock', 'scry-userdata.lock', 'local.sock'] })
    expect(w.signals).toEqual([[4242, 'SIGTERM']])
  })
})

describe('backgroundServiceLeftovers', () => {
  it('does not count a successor\'s lock as the stopped daemon\'s leftover', async () => {
    const w = world()
    w.files.set(LOCK, JSON.stringify({ ...holder, pid: 5000, startedAt: 'linux:boot:1', identityKey: '5000:linux:boot:1' }))
    w.files.set(join(USER, 'remote', 'ledger', 'session-ledger.lock'), '{}')
    await expect(backgroundServiceLeftovers(deps(w), holder)).resolves.toEqual(['remote/ledger/session-ledger.lock'])
  })

  it('never touches the files it checks', async () => {
    const w = world()
    const readText = vi.fn(async (path: string) => w.files.get(path))
    await backgroundServiceLeftovers(deps(w, { readText }), holder)
    expect(w.files.get(LOCK)).toBe(JSON.stringify(holder))
    expect(readText).toHaveBeenCalledTimes(2)
  })
})
