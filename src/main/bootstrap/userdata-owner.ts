import type { DaemonLockRecord } from '../../daemon/ledger-lock'
import { acquireUserDataLock, readUserDataLockRecord, type UserDataLockOutcome } from '../../daemon/userdata-lock'
import { processIdentityKey, readProcessIdentitySync, type ProcessRow } from '../process-diagnostics'

// The switch-off App's claim on its userData (P3-userdata-lock.md, case 1, options A + B).
// A daemon left behind by a switch-on session can still be writing scry.db, the outbox and
// the session ledger; the App must not start a second writer next to it. So, before any
// userData writer starts, the App tries to take `scry-userdata.lock` with role `app`:
//
// - nobody holds it, or the holder is provably gone (dead, zombie, pid reused): the App takes
//   it over as a file operation, signalling nothing, and keeps it until it quits (B);
// - a daemon whose identity verifies holds it: the user chooses to stop it or to quit (A);
// - anything else (another App, a legacy record, a holder this module cannot verify): quit.
//
// Stopping re-verifies the record and the pid's identity right before the one SIGTERM, then
// waits a bounded time. Every failure ends in "quit without writing", never in "write anyway".
// No Electron here: the dialog lives in userdata-owner-dialog.ts.

export const USERDATA_STOP_TIMEOUT_MS = 10_000
const STOP_POLL_MS = 100

export type UserDataRefusal =
  /** A Scry-looking process holds the record and its identity cannot be compared. */
  | 'holder-unverifiable'
  /** A live owner that is not a daemon (another App, a record without a role). */
  | 'holder-not-daemon'

export type UserDataHolderDecision =
  | { action: 'ask-stop'; holder: DaemonLockRecord }
  | { action: 'refuse'; holder: DaemonLockRecord; reason: UserDataRefusal }

/** What to do about a live holder; the lock module has already ruled out stale ones. */
export function decideUserDataHolder(owned: Extract<UserDataLockOutcome, { status: 'owned' }>): UserDataHolderDecision {
  if (owned.reason === 'identity-unverifiable') return { action: 'refuse', holder: owned.holder, reason: 'holder-unverifiable' }
  // Only a daemon is ours to stop. A live `app` holder means another App instance on this
  // userData slipped past the single-instance lock (an owned test App); that is the user's
  // window, not something to signal.
  if (owned.holder.role !== 'daemon') return { action: 'refuse', holder: owned.holder, reason: 'holder-not-daemon' }
  return { action: 'ask-stop', holder: owned.holder }
}

export type SignalCheckFailure =
  /** The holder released the lock on its own; nothing to signal. */
  | 'lock-released'
  /** The process is gone or a zombie; its record is stale and the takeover rules apply. */
  | 'holder-exited'
  /** The lock now describes another holder than the one the user agreed to stop. */
  | 'lock-changed'
  /** The pid now belongs to a process with another start identity (pid reuse). */
  | 'identity-changed'
  /** The pid's identity could not be read, so it cannot be proven to be the daemon. */
  | 'identity-unreadable'
  /** The record carries no identity key to compare with. */
  | 'identity-unrecorded'

export type SignalCheck = { ok: true } | { ok: false; reason: SignalCheckFailure }

/**
 * Last check before SIGTERM: the record still names the holder the user saw, and the pid
 * still has the identity that record captured. Same evidence as daemon.lock, but stricter:
 * only an exact identity key match permits a signal.
 */
export function checkDaemonBeforeSignal(
  asked: DaemonLockRecord,
  current: DaemonLockRecord | undefined,
  row: ProcessRow | undefined | 'unreadable'
): SignalCheck {
  if (!asked.identityKey) return { ok: false, reason: 'identity-unrecorded' }
  if (!current) return { ok: false, reason: 'lock-released' }
  if (!sameHolder(asked, current) || current.role !== asked.role) return { ok: false, reason: 'lock-changed' }
  if (row === 'unreadable') return { ok: false, reason: 'identity-unreadable' }
  if (!row || row.status.startsWith('Z')) return { ok: false, reason: 'holder-exited' }
  if (processIdentityKey(row) !== asked.identityKey) return { ok: false, reason: 'identity-changed' }
  return { ok: true }
}

function sameHolder(a: DaemonLockRecord, b: DaemonLockRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.identityKey === b.identityKey
}

export type UserDataQuitReason =
  | 'user-quit'
  | UserDataRefusal
  | Exclude<SignalCheckFailure, 'lock-released' | 'holder-exited'>
  /** The daemon was signalled but still held the lock at the deadline. */
  | 'stop-timeout'
  /** The signal itself was refused (for example EPERM). */
  | 'signal-failed'
  /** The daemon went away but another live owner took the lock before the App could. */
  | 'owned-after-stop'
  /** The lock file or this process's own identity could not be read or written. */
  | 'lock-error'

export type AppUserDataClaim =
  | {
    status: 'owned'
    record: DaemonLockRecord
    /** Removes the record only while it still names this process. Idempotent. */
    release: () => void
    /** Whether the user was shown the stop dialog; startup timing excludes their time. */
    asked: boolean
    previous?: DaemonLockRecord
    stopped?: DaemonLockRecord
  }
  | { status: 'quit'; reason: UserDataQuitReason; asked: boolean; holder?: DaemonLockRecord }

export interface ClaimAppUserDataOptions {
  userDataDir: string
  /** Shown only for a verified live daemon. */
  ask: (holder: DaemonLockRecord) => Promise<'stop' | 'quit'>
  signal?: (pid: number, signal: 'SIGTERM') => void
  /** Identity reader used for the pre-signal check and while waiting. */
  readIdentity?: (pid: number) => ProcessRow | undefined
  stopTimeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

async function acquireForApp(userDataDir: string): Promise<UserDataLockOutcome | undefined> {
  try {
    // Synchronous file calls inside: the lock module is shared with the daemon, and this
    // runs once in whenReady before initDb, which is itself synchronous.
    return await acquireUserDataLock({ userDataDir, role: 'app', startedBy: 'app' })
  } catch {
    // Unwritable userData or no readable identity for this process: a lock that cannot be
    // taken cannot keep a daemon out, so the App does not start writing.
    return undefined
  }
}

export async function claimAppUserData(options: ClaimAppUserDataOptions): Promise<AppUserDataClaim> {
  const first = await acquireForApp(options.userDataDir)
  if (!first) return { status: 'quit', reason: 'lock-error', asked: false }
  if (first.status === 'acquired') return owned(first, false)

  const decision = decideUserDataHolder(first)
  if (decision.action === 'refuse') return { status: 'quit', reason: decision.reason, holder: decision.holder, asked: false }
  const holder = decision.holder
  if (await options.ask(holder) !== 'stop') return { status: 'quit', reason: 'user-quit', holder, asked: true }

  const stop = await stopVerifiedDaemon(holder, options)
  if (stop) return { status: 'quit', reason: stop, holder, asked: true }
  const second = await acquireForApp(options.userDataDir)
  if (!second) return { status: 'quit', reason: 'lock-error', holder, asked: true }
  // Something took the lock between the daemon's exit and this attempt (a supervisor
  // that relaunched it, say). Asking again could loop; the App quits and says so.
  if (second.status === 'owned') return { status: 'quit', reason: 'owned-after-stop', holder: second.holder, asked: true }
  return owned(second, true, holder)
}

function owned(outcome: Extract<UserDataLockOutcome, { status: 'acquired' }>, asked: boolean, stopped?: DaemonLockRecord): AppUserDataClaim {
  return {
    status: 'owned',
    record: outcome.record,
    release: outcome.release,
    asked,
    ...(outcome.previous ? { previous: outcome.previous } : {}),
    ...(stopped ? { stopped } : {})
  }
}

function readRow(read: (pid: number) => ProcessRow | undefined, pid: number): ProcessRow | undefined | 'unreadable' {
  try { return read(pid) } catch { return 'unreadable' }
}

/** Undefined once the holder is gone; otherwise the reason the App must quit instead. */
async function stopVerifiedDaemon(holder: DaemonLockRecord, options: ClaimAppUserDataOptions): Promise<UserDataQuitReason | undefined> {
  const readIdentity = options.readIdentity ?? ((pid: number) => readProcessIdentitySync(pid))
  // The dialog may have been open for minutes: re-read both the record and the identity
  // immediately before signalling, so the signal can only reach the process the user saw.
  const check = checkDaemonBeforeSignal(holder, readUserDataLockRecord(options.userDataDir), readRow(readIdentity, holder.pid))
  if (!check.ok) {
    // Gone by itself: no signal; the second acquisition applies the takeover rules.
    if (check.reason === 'lock-released' || check.reason === 'holder-exited') return undefined
    return check.reason
  }
  try {
    (options.signal ?? ((pid, name) => { process.kill(pid, name) }))(holder.pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined
    return 'signal-failed'
  }
  // One signal, then only observation. The daemon's dispose drops its userData record
  // before it exits; a daemon that dies without that leaves a stale record, which also
  // counts as gone. No second signal and no SIGKILL: an unresponsive daemon is reported.
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const deadline = now() + (options.stopTimeoutMs ?? USERDATA_STOP_TIMEOUT_MS)
  for (;;) {
    const current = readUserDataLockRecord(options.userDataDir)
    if (!current || !sameHolder(holder, current)) return undefined
    const row = readRow(readIdentity, holder.pid)
    if (row !== 'unreadable' && (!row || row.status.startsWith('Z') || processIdentityKey(row) !== holder.identityKey)) return undefined
    if (now() >= deadline) return 'stop-timeout'
    await wait(options.pollMs ?? STOP_POLL_MS)
  }
}
