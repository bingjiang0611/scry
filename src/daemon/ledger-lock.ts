import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { processIdentityKey, readProcessSnapshot, type ProcessSnapshot } from '../main/process-diagnostics'

// One daemon per state directory. The lock is the only writer gate for the session
// ledger, so the decision has to be made from evidence: a live holder with the same
// start time means "join it", a holder whose identity changed means "stop and say
// so", never "kill whatever owns this pid now".
export const DAEMON_LOCK_NAME = 'daemon.lock'

export interface DaemonLockRecord {
  pid: number
  /** `ps lstart` text captured when the lock was written. */
  startedAt: string
  identityKey: string
  /** Who started the daemon; free text, never used for trust. */
  startedBy: string
}

export type DaemonLockOutcome =
  | { status: 'acquired'; record: DaemonLockRecord; release: () => void }
  // A live daemon holds the lock. The caller must exit without touching the ledger.
  | { status: 'already-running'; holder: DaemonLockRecord }
  // The pid now belongs to a different process; replacing the lock would hand the
  // ledger to a stranger, so the caller stops and reports.
  | { status: 'identity-changed'; holder: DaemonLockRecord }
  // The previous holder is gone (crashed or killed). Safe to take over.
  | { status: 'replaced-stale'; record: DaemonLockRecord; previous?: DaemonLockRecord; release: () => void }

export interface AcquireDaemonLockOptions {
  /** Directory that holds the lock; created 0700 and never widened. */
  directory: string
  startedBy: string
  pid?: number
  lister?: () => ProcessSnapshot
  now?: () => Date
}

function readRecord(path: string): DaemonLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DaemonLockRecord>
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return undefined
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      identityKey: typeof parsed.identityKey === 'string' ? parsed.identityKey : '',
      startedBy: typeof parsed.startedBy === 'string' ? parsed.startedBy : ''
    }
  } catch {
    // An unreadable lock cannot describe a live holder, so it is treated as stale
    // rather than blocking startup forever.
    return undefined
  }
}

export function acquireDaemonLock(options: AcquireDaemonLockOptions): DaemonLockOutcome {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  chmodSync(options.directory, 0o700)
  const path = join(options.directory, DAEMON_LOCK_NAME)
  const pid = options.pid ?? process.pid
  const snapshotOf = (): ProcessSnapshot => (options.lister ? options.lister() : readProcessSnapshot())
  const self = snapshotOf().get(pid)
  const record: DaemonLockRecord = {
    pid,
    // Without a start time the lock could never be verified later, so a caller that
    // cannot read its own identity fails instead of writing a weak record.
    startedAt: self?.startedAt ?? '',
    identityKey: self ? processIdentityKey(self) : '',
    startedBy: options.startedBy
  }
  if (!record.startedAt) throw new Error('daemon_lock_identity_unavailable')

  const write = (): void => {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  }
  const release = (): void => {
    // Only remove a lock that still describes this process; a successor that already
    // took over must keep its own record.
    const current = readRecord(path)
    if (current?.pid === record.pid && current.startedAt === record.startedAt) rmSync(path, { force: true })
  }

  try {
    closeSync(openSync(path, 'wx', 0o600))
    write()
    return { status: 'acquired', record, release }
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
  }

  const previous = readRecord(path)
  // Every takeover rewrites the record: leaving the old pid in place would make the
  // crashed daemon's release() delete a lock it no longer owns.
  const takeOver = (): DaemonLockOutcome => {
    write()
    return { status: 'replaced-stale', record, ...(previous ? { previous } : {}), release }
  }
  if (!previous) return takeOver()
  const holder = snapshotOf().get(previous.pid)
  if (!holder) return takeOver()
  if (holder.status.startsWith('Z')) return takeOver()
  // Same pid, different start time: the pid was reused, so the live process is not
  // the daemon that wrote this lock. Replacing the file would steal the ledger.
  if (holder.startedAt !== previous.startedAt) return { status: 'identity-changed', holder: previous }
  return { status: 'already-running', holder: previous }
}
