import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIdentityKey, readProcessIdentitySync, type ProcessRow } from '../main/process-diagnostics'

// One daemon per state directory. The lock is the only writer gate for the session
// ledger, so every decision has to come from evidence: a live holder with the same
// start time means "join it"; a live pid whose start time differs means the pid was
// reused, which proves the holder is gone; an unverifiable same-entry holder means
// "do not start a second writer".
export const DAEMON_LOCK_NAME = 'daemon.lock'
// Short-lived mutex around takeover. Two daemons can both decide the lock is stale;
// only the one that creates this file may rewrite it.
const TAKEOVER_NAME = 'daemon.lock.takeover'
const TAKEOVER_STALE_MS = 10_000
const TAKEOVER_ATTEMPTS = 200
const TAKEOVER_WAIT_MS = 5

export interface DaemonLockRecord {
  pid: number
  /** `ps lstart` text captured when the lock was written. */
  startedAt: string
  identityKey: string
  /** Who started the daemon; free text, never used for trust. */
  startedBy: string
}

export type TakeoverReason = 'holder-missing' | 'holder-zombie' | 'unreadable-record' | 'pid-reused'

export type DaemonLockOutcome =
  | { status: 'acquired'; record: DaemonLockRecord; release: () => void }
  // A live daemon holds the lock. The caller must exit without touching the ledger.
  // `identity-unverifiable` is the conservative case: same entry, different start
  // time, so this module cannot prove the holder is dead.
  | { status: 'already-running'; holder: DaemonLockRecord; reason?: 'live-holder' | 'identity-unverifiable' }
  // The previous holder is gone. Taking over is a file operation: this module never
  // signals the process that owns the reused pid.
  | { status: 'replaced-stale'; record: DaemonLockRecord; previous?: DaemonLockRecord; reason: TakeoverReason; release: () => void }

export interface AcquireDaemonLockOptions {
  /** Directory that holds the lock; created 0700 and never widened. */
  directory: string
  startedBy: string
  pid?: number
  lister?: () => ReadonlyMap<number, ProcessRow>
  /** Marker for this daemon's own command line, used only to refuse unsafe takeover. */
  daemonEntry?: string
  /** Test seam: runs after the stale decision and inside the takeover mutex. */
  afterValidate?: () => void | Promise<void>
  /** Test seam: how the waiter yields; the real one sleeps briefly. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Identity of one pid using the shared platform-exact reader. */
export function readDaemonIdentity(pid: number): DaemonLockRecord | undefined {
  const row = readProcessIdentitySync(pid)
  if (!row) return undefined
  return { pid, startedAt: row.startedAt, identityKey: processIdentityKey(row), startedBy: '' }
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
    // An unreadable lock cannot describe a live holder, so it is stale rather than a
    // permanent block.
    return undefined
  }
}

type HolderCheck =
  | { kind: 'live'; holder: DaemonLockRecord }
  | { kind: 'unverifiable'; holder: DaemonLockRecord }
  | { kind: 'stale'; holder?: DaemonLockRecord; reason: TakeoverReason }

function checkHolder(previous: DaemonLockRecord | undefined, row: ProcessRow | undefined, daemonEntry: string | undefined, selfPid: number): HolderCheck {
  if (!previous) return { kind: 'stale', reason: 'unreadable-record' }
  if (!row) return { kind: 'stale', holder: previous, reason: 'holder-missing' }
  if (row.status.startsWith('Z')) return { kind: 'stale', holder: previous, reason: 'holder-zombie' }
  const sameIdentity = previous.identityKey
    ? processIdentityKey(row) === previous.identityKey
    : row.startedAt === previous.startedAt
  if (sameIdentity) return { kind: 'live', holder: previous }
  // The record names this very process but a different identity: this process cannot
  // have written it, so the pid was reused (macOS hands out sequential pids, so a
  // relaunched daemon often gets the pid its crashed predecessor left behind).
  if (previous.pid === selfPid) return { kind: 'stale', holder: previous, reason: 'pid-reused' }
  // Someone else's pid with a different legacy wall-clock identity is not enough to
  // steal from a process that still looks like Scry. Exact Linux identities safely
  // prove reuse, but keeping this refusal also protects old records.
  const scryCommand = row.command.includes('Scry.app/') || /(?:^|\/)Scry(?:\s|$)/.test(row.command) ||
    /out\/main\/daemon(?:-supervisor)?\.js/.test(row.command)
  const exactLinuxIdentity = previous.identityKey.includes(':linux:') && row.identityKey?.includes(':linux:') === true
  if (!exactLinuxIdentity && (scryCommand || (daemonEntry && row.command.includes(daemonEntry)))) {
    return { kind: 'unverifiable', holder: previous }
  }
  return { kind: 'stale', holder: previous, reason: 'pid-reused' }
}

export async function acquireDaemonLock(options: AcquireDaemonLockOptions): Promise<DaemonLockOutcome> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  chmodSync(options.directory, 0o700)
  const path = join(options.directory, DAEMON_LOCK_NAME)
  const takeoverPath = join(options.directory, TAKEOVER_NAME)
  const pid = options.pid ?? process.pid
  const rowOf = (target: number): ProcessRow | undefined => options.lister
    ? options.lister().get(target)
    : readProcessIdentitySync(target)
  const self = rowOf(pid)
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

  const evaluate = (): HolderCheck => {
    const previous = readRecord(path)
    const row = previous ? rowOf(previous.pid) : undefined
    return checkHolder(previous, row, options.daemonEntry, pid)
  }
  const first = evaluate()
  if (first.kind === 'live') return { status: 'already-running', holder: first.holder, reason: 'live-holder' }
  if (first.kind === 'unverifiable') return { status: 'already-running', holder: first.holder, reason: 'identity-unverifiable' }

  // Takeover mutex: `wx` is atomic, so exactly one daemon owns the rewrite. A holder
  // that died inside the critical section leaves the file behind; anything older
  // than TAKEOVER_STALE_MS is treated as that leftover and cleared.
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  let takenOver = false
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS && !takenOver; attempt += 1) {
    try {
      closeSync(openSync(takeoverPath, 'wx', 0o600))
      takenOver = true
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      try {
        if (now() - statSync(takeoverPath).mtimeMs > TAKEOVER_STALE_MS) rmSync(takeoverPath, { force: true })
      } catch {
        // Someone else cleaned it first; the next attempt will compete normally.
      }
      await wait(TAKEOVER_WAIT_MS)
    }
  }
  if (!takenOver) return { status: 'already-running', holder: readRecord(path) ?? record, reason: 'identity-unverifiable' }

  try {
    await options.afterValidate?.()
    // Re-read inside the critical section: another daemon may have finished its
    // takeover while this one was waiting for the mutex.
    const second = evaluate()
    if (second.kind === 'live') return { status: 'already-running', holder: second.holder, reason: 'live-holder' }
    if (second.kind === 'unverifiable') return { status: 'already-running', holder: second.holder, reason: 'identity-unverifiable' }
    write()
    return {
      status: 'replaced-stale',
      record,
      reason: second.reason,
      ...(second.holder ? { previous: second.holder } : {}),
      release
    }
  } finally {
    rmSync(takeoverPath, { force: true })
  }
}
