import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DAEMON_LOCK_NAME, parseDaemonLockRecord, type DaemonLockRecord } from '../daemon/ledger-lock'
import { USERDATA_LOCK_NAME } from '../daemon/userdata-lock'
import { LOCAL_SOCKET_NAME } from '../daemon/local-channel'
import { LOCAL_ENROLL_SOCKET_NAME } from '../daemon/local-enrollment'
import { checkDaemonBeforeSignal, type SignalCheckFailure } from './bootstrap/userdata-owner'
import { processIdentitiesComparable, processIdentityKey, readProcessIdentity, type ProcessRow } from './process-diagnostics'

// Stopping the App's own background service from the settings section (B4-S S0-1, the
// §13.2 chain). The only process this module signals is the one `daemon.lock` names, and
// only while that pid still has the identity the lock recorded: read before the user is
// asked, and read again immediately before the one SIGTERM. Then it only observes. No
// second signal, no SIGKILL, no pattern match on process names: a daemon that does not
// exit in time is reported, and the caller stops there (fail closed).
//
// The supervisor writes no identity record, so it is never signalled. It exits on its own
// once the daemon exits cleanly (supervisor.ts: code 0 means stopped); when the daemon's
// parent is visibly the supervisor, its exit is observed and a survivor is reported.
//
// No Electron, and no synchronous file or process calls: this runs behind IPC handlers.

export const BACKGROUND_SERVICE_STOP_TIMEOUT_MS = 15_000
export const BACKGROUND_SERVICE_SUPERVISOR_TIMEOUT_MS = 5_000
const POLL_MS = 100

export interface BackgroundServicePaths {
  /** `<userData>/daemon`: daemon.lock and the two sockets. */
  stateDirectory: string
  userDataDir: string
}

export type StopRefusal =
  | Exclude<SignalCheckFailure, 'lock-released' | 'holder-exited'>
  /** daemon.lock exists but could not be read or parsed: nobody can be identified. */
  | 'lock-unreadable'
  /** The signal itself failed (EPERM, for example). */
  | 'signal-failed'
  /** SIGTERM was sent once and the daemon still ran at the deadline. */
  | 'stop-timeout'

export type PreparedStop =
  | { status: 'running'; holder: DaemonLockRecord }
  // No lock, or a lock whose holder is provably gone: there is nothing to signal.
  | { status: 'not-running' }
  | { status: 'refused'; reason: StopRefusal }

export type StopOutcome =
  | { status: 'stopped'; holder: DaemonLockRecord; leftovers: string[] }
  // The holder went away between the check and the signal; nothing was signalled.
  | { status: 'already-stopped'; leftovers: string[] }
  | { status: 'refused'; reason: StopRefusal }

export interface BackgroundServiceStopDeps {
  paths: BackgroundServicePaths
  /** File text, undefined when absent; a thrown error means "exists but unreadable". */
  readText?: (path: string) => Promise<string | undefined>
  readIdentity?: (pid: number) => Promise<ProcessRow | undefined>
  signal?: (pid: number, signal: 'SIGTERM') => void
  exists?: (path: string) => Promise<boolean>
  stopTimeoutMs?: number
  supervisorTimeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

async function readTextDefault(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function existsDefault(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

type LockRead = { kind: 'absent' } | { kind: 'record'; record: DaemonLockRecord } | { kind: 'unreadable' }

async function readLock(deps: BackgroundServiceStopDeps, name: string, directory: string): Promise<LockRead> {
  let text: string | undefined
  try { text = await (deps.readText ?? readTextDefault)(join(directory, name)) } catch { return { kind: 'unreadable' } }
  if (text === undefined) return { kind: 'absent' }
  const record = parseDaemonLockRecord(text)
  return record ? { kind: 'record', record } : { kind: 'unreadable' }
}

async function readRow(deps: BackgroundServiceStopDeps, pid: number): Promise<ProcessRow | undefined | 'unreadable'> {
  try { return await (deps.readIdentity ?? readProcessIdentity)(pid) } catch { return 'unreadable' }
}

/** Who holds daemon.lock, verified against the live process; asked before any confirmation. */
export async function prepareBackgroundServiceStop(deps: BackgroundServiceStopDeps): Promise<PreparedStop> {
  const lock = await readLock(deps, DAEMON_LOCK_NAME, deps.paths.stateDirectory)
  if (lock.kind === 'absent') return { status: 'not-running' }
  if (lock.kind === 'unreadable') return { status: 'refused', reason: 'lock-unreadable' }
  const holder = lock.record
  const row = await readRow(deps, holder.pid)
  const check = checkDaemonBeforeSignal(holder, holder, row)
  if (check.ok) return { status: 'running', holder }
  if (check.reason === 'holder-exited') return { status: 'not-running' }
  // A different identity in a format both sides can interpret proves the pid was reused,
  // so the daemon that wrote the lock is gone (the lock module's own rule). A legacy
  // record that cannot be compared proves nothing and is refused.
  if (check.reason === 'identity-changed' && row !== 'unreadable' && row &&
    processIdentitiesComparable(holder.identityKey, processIdentityKey(row))) return { status: 'not-running' }
  return { status: 'refused', reason: check.reason as StopRefusal }
}

function gone(row: ProcessRow | undefined | 'unreadable', identityKey: string): boolean {
  // An unreadable identity is not proof of exit; keep waiting until the deadline.
  if (row === 'unreadable') return false
  return !row || row.status.startsWith('Z') || processIdentityKey(row) !== identityKey
}

/**
 * Re-verify the holder the user agreed to stop, send it one SIGTERM, and wait (bounded)
 * for it to exit; then wait for its supervisor and list what the stop left behind.
 */
export async function stopBackgroundService(holder: DaemonLockRecord, deps: BackgroundServiceStopDeps): Promise<StopOutcome> {
  const now = deps.now ?? Date.now
  const wait = deps.sleep ?? sleep
  const pollMs = deps.pollMs ?? POLL_MS
  // The confirmation may have been open for minutes: both the record and the identity are
  // read again here, so the signal can only reach the process the user was asked about.
  const lock = await readLock(deps, DAEMON_LOCK_NAME, deps.paths.stateDirectory)
  if (lock.kind === 'unreadable') return { status: 'refused', reason: 'lock-unreadable' }
  const row = await readRow(deps, holder.pid)
  const check = checkDaemonBeforeSignal(holder, lock.kind === 'record' ? lock.record : undefined, row)
  if (!check.ok) {
    if (check.reason === 'lock-released' || check.reason === 'holder-exited') {
      return { status: 'already-stopped', leftovers: await backgroundServiceLeftovers(deps, holder) }
    }
    return { status: 'refused', reason: check.reason }
  }
  // Observation only: the parent is watched for exit when it is visibly the supervisor.
  const parent = row !== 'unreadable' && row && row.ppid > 1 ? await readRow(deps, row.ppid) : undefined
  const supervisor = parent && parent !== 'unreadable' && /daemon-supervisor\.js/.test(parent.command)
    ? { pid: parent.pid, identityKey: processIdentityKey(parent) }
    : undefined

  try {
    (deps.signal ?? ((pid, name) => { process.kill(pid, name) }))(holder.pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { status: 'already-stopped', leftovers: await backgroundServiceLeftovers(deps, holder) }
    }
    return { status: 'refused', reason: 'signal-failed' }
  }

  const deadline = now() + (deps.stopTimeoutMs ?? BACKGROUND_SERVICE_STOP_TIMEOUT_MS)
  for (;;) {
    if (gone(await readRow(deps, holder.pid), holder.identityKey)) break
    if (now() >= deadline) return { status: 'refused', reason: 'stop-timeout' }
    await wait(pollMs)
  }
  const leftovers: string[] = []
  if (supervisor) {
    const until = now() + (deps.supervisorTimeoutMs ?? BACKGROUND_SERVICE_SUPERVISOR_TIMEOUT_MS)
    for (;;) {
      if (gone(await readRow(deps, supervisor.pid), supervisor.identityKey)) break
      if (now() >= until) { leftovers.push(`supervisor:${supervisor.pid}`); break }
      await wait(pollMs)
    }
  }
  leftovers.push(...await backgroundServiceLeftovers(deps, holder))
  return { status: 'stopped', holder, leftovers }
}

/**
 * What a stopped daemon must not leave behind: its two lock records, its sockets, and the
 * remote host's durable leases. Lock records count only while they still name the stopped
 * holder; a successor's record is not this daemon's leftover.
 */
export async function backgroundServiceLeftovers(deps: BackgroundServiceStopDeps, holder: DaemonLockRecord): Promise<string[]> {
  const exists = deps.exists ?? existsDefault
  const { stateDirectory, userDataDir } = deps.paths
  const left: string[] = []
  const names = (record: DaemonLockRecord): boolean => record.pid === holder.pid && record.startedAt === holder.startedAt
  const daemonLock = await readLock(deps, DAEMON_LOCK_NAME, stateDirectory)
  if (daemonLock.kind === 'unreadable' || (daemonLock.kind === 'record' && names(daemonLock.record))) left.push(DAEMON_LOCK_NAME)
  const userDataLock = await readLock(deps, USERDATA_LOCK_NAME, userDataDir)
  if (userDataLock.kind === 'unreadable' || (userDataLock.kind === 'record' && names(userDataLock.record))) left.push(USERDATA_LOCK_NAME)
  const files: Array<[string, string]> = [
    [LOCAL_SOCKET_NAME, join(stateDirectory, LOCAL_SOCKET_NAME)],
    [LOCAL_ENROLL_SOCKET_NAME, join(stateDirectory, LOCAL_ENROLL_SOCKET_NAME)],
    ['remote/pairing/pairing-state.lock', join(userDataDir, 'remote', 'pairing', 'pairing-state.lock')],
    ['remote/ledger/session-ledger.lock', join(userDataDir, 'remote', 'ledger', 'session-ledger.lock')]
  ]
  for (const [name, path] of files) if (await exists(path)) left.push(name)
  return left
}
