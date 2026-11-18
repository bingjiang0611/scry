import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processIdentityKey, readProcessIdentitySync, type ProcessRow } from '../process-diagnostics'
import { USERDATA_LOCK_NAME } from '../../daemon/userdata-lock'
import { startDaemon } from '../../daemon/lifecycle'
import { claimAppUserData, checkDaemonBeforeSignal, decideUserDataHolder, type ClaimAppUserDataOptions, type UserDataQuitReason } from './userdata-owner'
import { QUIT_BUTTON, quitNotice, STOP_DAEMON_BUTTON, stopDaemonPrompt } from './userdata-owner-messages'

// Switch-off App and a leftover daemon on the same userData (P3-userdata-lock.md case 1).
// The fake daemon is a real child process this test spawns, so identity comes from the
// same /proc or ps reader production uses; every userData is a fresh temp directory.
const dirs: string[] = []
const children: ChildProcess[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  // Only the children this test spawned, by handle; nothing is looked up by name.
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type HolderMode = 'release' | 'exit-only' | 'ignore'
// `release` behaves like the daemon's dispose: drop the userData record, then exit 0.
const HOLDER_SCRIPT = `
const fs = require('node:fs')
const [mode, lock, marker] = process.argv.slice(1)
process.on('SIGTERM', () => {
  fs.appendFileSync(marker, 'SIGTERM\\n')
  if (mode === 'ignore') return
  if (mode === 'release') fs.rmSync(lock, { force: true })
  process.exit(0)
})
setInterval(() => {}, 1000)
process.stdout.write('ready\\n')
`

async function spawnHolder(userDataDir: string, mode: HolderMode): Promise<{ child: ChildProcess; marker: string }> {
  // The marker lives outside userData so "nothing written to userData" stays checkable.
  const marker = join(tempDir('scry-owner-marker-'), 'signals')
  const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT, mode, join(userDataDir, USERDATA_LOCK_NAME), marker], { stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdout?.once('data', () => resolve())
  })
  return { child, marker }
}

function identityOf(pid: number): ProcessRow {
  const row = readProcessIdentitySync(pid)
  if (!row) throw new Error(`no identity for ${pid}`)
  return row
}

function writeDaemonRecord(userDataDir: string, pid: number, overrides: Record<string, unknown> = {}): string {
  const row = identityOf(pid)
  const text = `${JSON.stringify({ pid, startedAt: row.startedAt, identityKey: processIdentityKey(row), startedBy: 'supervisor:1', role: 'daemon', ...overrides })}\n`
  writeFileSync(join(userDataDir, USERDATA_LOCK_NAME), text, { mode: 0o600 })
  return text
}

const lockText = (userDataDir: string): string => readFileSync(join(userDataDir, USERDATA_LOCK_NAME), 'utf8')
const lockRecord = (userDataDir: string): Record<string, unknown> => JSON.parse(lockText(userDataDir)) as Record<string, unknown>
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const exited = (child: ChildProcess): Promise<void> => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise((resolve) => { child.once('exit', () => resolve()) })

function signalSpy(): { calls: Array<[number, string]>; signal: NonNullable<ClaimAppUserDataOptions['signal']> } {
  const calls: Array<[number, string]> = []
  return { calls, signal: (pid, name) => { calls.push([pid, name]); process.kill(pid, name) } }
}

describe('switch-off App claims userData', () => {
  it('takes the lock with role app when nobody holds it, and releases only its own record', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const ask = vi.fn(async () => 'quit' as const)
    const claim = await claimAppUserData({ userDataDir, ask })
    expect(claim.status).toBe('owned')
    expect(ask).not.toHaveBeenCalled()
    expect(lockRecord(userDataDir)).toMatchObject({ pid: process.pid, role: 'app', startedBy: 'app' })
    if (claim.status !== 'owned') throw new Error('expected owned')
    claim.release()
    expect(existsSync(join(userDataDir, USERDATA_LOCK_NAME))).toBe(false)
  })

  it('writes nothing and signals nobody when the user picks 退出 for a live daemon', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const { child, marker } = await spawnHolder(userDataDir, 'release')
    const before = writeDaemonRecord(userDataDir, child.pid!)
    const listing = readdirSync(userDataDir)
    const spy = signalSpy()
    const ask = vi.fn(async () => 'quit' as const)
    const claim = await claimAppUserData({ userDataDir, ask, signal: spy.signal })
    expect(claim).toMatchObject({ status: 'quit', reason: 'user-quit', holder: { pid: child.pid, role: 'daemon' } })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(spy.calls).toEqual([])
    expect(readdirSync(userDataDir)).toEqual(listing)
    expect(lockText(userDataDir)).toBe(before)
    expect(alive(child.pid!)).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('on 停止后台服务 sends SIGTERM only to the re-verified pid, waits for the release, then owns userData', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const { child, marker } = await spawnHolder(userDataDir, 'release')
    writeDaemonRecord(userDataDir, child.pid!)
    const spy = signalSpy()
    const claim = await claimAppUserData({ userDataDir, ask: async () => 'stop', signal: spy.signal })
    expect(spy.calls).toEqual([[child.pid, 'SIGTERM']])
    expect(claim).toMatchObject({ status: 'owned', asked: true, stopped: { pid: child.pid } })
    await exited(child)
    expect(readFileSync(marker, 'utf8')).toBe('SIGTERM\n')
    expect(lockRecord(userDataDir)).toMatchObject({ pid: process.pid, role: 'app' })
  })

  it('owns userData after the stopped daemon exits without releasing its record', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const { child } = await spawnHolder(userDataDir, 'exit-only')
    writeDaemonRecord(userDataDir, child.pid!)
    const spy = signalSpy()
    const claim = await claimAppUserData({ userDataDir, ask: async () => 'stop', signal: spy.signal })
    expect(spy.calls).toEqual([[child.pid, 'SIGTERM']])
    expect(claim.status).toBe('owned')
    expect(lockRecord(userDataDir)).toMatchObject({ pid: process.pid, role: 'app' })
  })

  it('does not signal and quits when the pid identity changes between the dialog and the signal', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const { child, marker } = await spawnHolder(userDataDir, 'release')
    const before = writeDaemonRecord(userDataDir, child.pid!)
    const spy = signalSpy()
    let answered = false
    // After the user answers, the same pid reports another start: the daemon died and
    // the pid now belongs to an unrelated process.
    const readIdentity = (pid: number): ProcessRow | undefined => {
      const row = readProcessIdentitySync(pid)
      if (!row || !answered) return row
      return { ...row, startedAt: `${row.startedAt}-reused`, identityKey: `${processIdentityKey(row)}-reused` }
    }
    const claim = await claimAppUserData({
      userDataDir, signal: spy.signal, readIdentity,
      ask: async () => { answered = true; return 'stop' }
    })
    expect(claim).toMatchObject({ status: 'quit', reason: 'identity-changed' })
    expect(spy.calls).toEqual([])
    expect(alive(child.pid!)).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(lockText(userDataDir)).toBe(before)
  })

  it('does not signal and quits when another owner rewrote the lock while the dialog was open', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const first = await spawnHolder(userDataDir, 'release')
    const second = await spawnHolder(userDataDir, 'release')
    writeDaemonRecord(userDataDir, first.child.pid!)
    const spy = signalSpy()
    let replaced = ''
    const claim = await claimAppUserData({
      userDataDir, signal: spy.signal,
      ask: async () => { replaced = writeDaemonRecord(userDataDir, second.child.pid!); return 'stop' }
    })
    expect(claim).toMatchObject({ status: 'quit', reason: 'lock-changed' })
    expect(spy.calls).toEqual([])
    expect(alive(first.child.pid!)).toBe(true)
    expect(alive(second.child.pid!)).toBe(true)
    expect(lockText(userDataDir)).toBe(replaced)
  })

  it('quits without writing when the daemon does not exit in time, and sends no second signal', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const { child, marker } = await spawnHolder(userDataDir, 'ignore')
    const before = writeDaemonRecord(userDataDir, child.pid!)
    const spy = signalSpy()
    const claim = await claimAppUserData({ userDataDir, ask: async () => 'stop', signal: spy.signal, stopTimeoutMs: 300, pollMs: 20 })
    expect(claim).toMatchObject({ status: 'quit', reason: 'stop-timeout', holder: { pid: child.pid } })
    expect(spy.calls).toEqual([[child.pid, 'SIGTERM']])
    await vi.waitFor(() => { expect(readFileSync(marker, 'utf8')).toBe('SIGTERM\n') })
    expect(alive(child.pid!)).toBe(true)
    expect(lockText(userDataDir)).toBe(before)
  })

  it('takes over a lock whose holder is dead without asking or signalling', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const { child } = await spawnHolder(userDataDir, 'release')
    writeDaemonRecord(userDataDir, child.pid!)
    child.kill('SIGKILL')
    await exited(child)
    const spy = signalSpy()
    const ask = vi.fn(async () => 'stop' as const)
    const claim = await claimAppUserData({ userDataDir, ask, signal: spy.signal })
    expect(claim).toMatchObject({ status: 'owned', asked: false, previous: { pid: child.pid } })
    expect(ask).not.toHaveBeenCalled()
    expect(spy.calls).toEqual([])
    expect(lockRecord(userDataDir)).toMatchObject({ pid: process.pid, role: 'app' })
  })

  it('takes over a lock whose pid was reused and leaves the process that reused it alone', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const { child, marker } = await spawnHolder(userDataDir, 'release')
    const row = identityOf(child.pid!)
    // Same pid, an earlier start in the same comparable format: the recorded holder is gone.
    const startedAt = row.startedAt.replace(/:(\d+)$/, (_, start: string) => `:${Math.max(0, Number(start) - 1)}`)
    const reused = startedAt === row.startedAt ? `${row.startedAt.slice(0, -4)}2001` : startedAt
    writeDaemonRecord(userDataDir, child.pid!, { startedAt: reused, identityKey: `${child.pid}:${reused}` })
    const spy = signalSpy()
    const ask = vi.fn(async () => 'stop' as const)
    const claim = await claimAppUserData({ userDataDir, ask, signal: spy.signal })
    expect(claim).toMatchObject({ status: 'owned', asked: false })
    expect(ask).not.toHaveBeenCalled()
    expect(spy.calls).toEqual([])
    expect(alive(child.pid!)).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(lockRecord(userDataDir)).toMatchObject({ pid: process.pid, role: 'app' })
  })

  it('makes a daemon started later on the same userData refuse with daemon_userdata_owned', async () => {
    const userDataDir = tempDir('scry-owner-ud-')
    const claim = await claimAppUserData({ userDataDir, ask: async () => 'quit' })
    if (claim.status !== 'owned') throw new Error('expected owned')
    const before = lockText(userDataDir)
    const lines: string[] = []
    let hostBuilt = false
    const error = await startDaemon({
      stateDirectory: join(userDataDir, 'daemon'), userDataDir, startedBy: 'supervisor:1', log: (line) => lines.push(line),
      startHost: async () => { hostBuilt = true; return { dispose: async () => {} } }
    }).then(() => undefined, (reason: unknown) => reason)
    expect((error as Error | undefined)?.message).toBe('daemon_userdata_owned')
    expect(hostBuilt).toBe(false)
    expect(lines.some((line) => line.startsWith(`daemon.userdata-owned holderPid=${process.pid} holderRole=app`))).toBe(true)
    expect(lockText(userDataDir)).toBe(before)
    claim.release()
  })
})

describe('holder decisions', () => {
  const holder = { pid: 4001, startedAt: 'linux:b:10', identityKey: '4001:linux:b:10', startedBy: 'x', role: 'daemon' }
  const row = { pid: 4001, ppid: 1, status: 'S', startedAt: 'linux:b:10', identityKey: '4001:linux:b:10', command: 'daemon.js' }

  it('offers to stop only a verified live daemon', () => {
    expect(decideUserDataHolder({ status: 'owned', holder, reason: 'live-holder' })).toEqual({ action: 'ask-stop', holder })
    expect(decideUserDataHolder({ status: 'owned', holder, reason: 'identity-unverifiable' })).toEqual({ action: 'refuse', holder, reason: 'holder-unverifiable' })
    expect(decideUserDataHolder({ status: 'owned', holder: { ...holder, role: 'app' }, reason: 'live-holder' })).toMatchObject({ action: 'refuse', reason: 'holder-not-daemon' })
    const { role: _role, ...legacy } = holder
    expect(decideUserDataHolder({ status: 'owned', holder: legacy, reason: 'live-holder' })).toMatchObject({ action: 'refuse', reason: 'holder-not-daemon' })
  })

  it('re-verifies record and identity before a signal', () => {
    expect(checkDaemonBeforeSignal(holder, holder, row)).toEqual({ ok: true })
    expect(checkDaemonBeforeSignal(holder, undefined, row)).toEqual({ ok: false, reason: 'lock-released' })
    expect(checkDaemonBeforeSignal(holder, { ...holder, startedAt: 'linux:b:11' }, row)).toEqual({ ok: false, reason: 'lock-changed' })
    expect(checkDaemonBeforeSignal(holder, holder, undefined)).toEqual({ ok: false, reason: 'holder-exited' })
    expect(checkDaemonBeforeSignal(holder, holder, { ...row, status: 'Z' })).toEqual({ ok: false, reason: 'holder-exited' })
    expect(checkDaemonBeforeSignal(holder, holder, { ...row, identityKey: '4001:linux:b:12' })).toEqual({ ok: false, reason: 'identity-changed' })
    expect(checkDaemonBeforeSignal(holder, holder, 'unreadable')).toEqual({ ok: false, reason: 'identity-unreadable' })
    const unrecorded = { ...holder, identityKey: '' }
    expect(checkDaemonBeforeSignal(unrecorded, unrecorded, row)).toEqual({ ok: false, reason: 'identity-unrecorded' })
  })
})

describe('dialog copy', () => {
  const holder = { pid: 4001, startedAt: 'linux:b:10', identityKey: '4001:linux:b:10', startedBy: 'x', role: 'daemon' }

  it('names the pid, defaults to 退出, and keeps 停止后台服务 as the explicit choice', () => {
    const prompt = stopDaemonPrompt(holder)
    expect(prompt.buttons[STOP_DAEMON_BUTTON]).toBe('停止后台服务')
    expect(prompt.buttons[QUIT_BUTTON]).toBe('退出')
    expect(prompt.defaultId).toBe(QUIT_BUTTON)
    expect(prompt.cancelId).toBe(QUIT_BUTTON)
    expect(prompt.detail).toContain('进程 4001')
  })

  it('explains every fail-closed quit and says nothing was written; the user\'s own 退出 needs no notice', () => {
    expect(quitNotice({ status: 'quit', reason: 'user-quit', asked: true, holder })).toBeUndefined()
    const reasons: UserDataQuitReason[] = [
      'holder-unverifiable', 'holder-not-daemon', 'identity-changed', 'identity-unreadable', 'identity-unrecorded',
      'lock-changed', 'stop-timeout', 'signal-failed', 'owned-after-stop', 'lock-error'
    ]
    for (const reason of reasons) {
      const notice = quitNotice({ status: 'quit', reason, asked: true, holder })
      expect(notice?.detail).toContain('Scry 没有写入这个数据目录')
      expect(notice?.buttons).toEqual(['退出'])
    }
    expect(quitNotice({ status: 'quit', reason: 'stop-timeout', asked: true, holder }, 10_000)?.detail).toContain('10 秒')
  })
})
