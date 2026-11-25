import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIdentitiesComparable, processIdentityKey, readProcessIdentitySync, type ProcessRow } from '../main/process-diagnostics'

export const DAEMON_LOCK_NAME = 'daemon.lock'
const TAKEOVER_SUFFIX = '.takeover'
const TAKEOVER_STALE_MS = 10_000
const TAKEOVER_ATTEMPTS = 200
const TAKEOVER_WAIT_MS = 5

export interface DaemonLockRecord {
  pid: number
  startedAt: string
  identityKey: string
  startedBy: string
  role?: string
}

export type TakeoverReason = 'holder-missing' | 'holder-zombie' | 'unreadable-record' | 'pid-reused'

export type DaemonLockOutcome =
  | { status: 'acquired'; record: DaemonLockRecord; release: () => void }
  | { status: 'already-running'; holder: DaemonLockRecord; reason?: 'live-holder' | 'identity-unverifiable' }
  | { status: 'replaced-stale'; record: DaemonLockRecord; previous?: DaemonLockRecord; reason: TakeoverReason; release: () => void }

export interface AcquireDaemonLockOptions {
  directory: string
  name?: string
  restrictDirectory?: boolean
  role?: string
  startedBy: string
  pid?: number
  lister?: () => ReadonlyMap<number, ProcessRow>
  daemonEntry?: string
  afterValidate?: () => void | Promise<void>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

export function readDaemonIdentity(pid: number): DaemonLockRecord | undefined {
  const row = readProcessIdentitySync(pid)
  if (!row) return undefined
  return { pid, startedAt: row.startedAt, identityKey: processIdentityKey(row), startedBy: '' }
}

export function readDaemonLockRecord(path: string): DaemonLockRecord | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  return parseDaemonLockRecord(text)
}

export function parseDaemonLockRecord(text: string): DaemonLockRecord | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<DaemonLockRecord>
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return undefined
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      identityKey: typeof parsed.identityKey === 'string' ? parsed.identityKey : '',
      startedBy: typeof parsed.startedBy === 'string' ? parsed.startedBy : '',
      ...(typeof parsed.role === 'string' ? { role: parsed.role } : {})
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
  if (previous.pid === selfPid) return { kind: 'stale', holder: previous, reason: 'pid-reused' }
  if (processIdentitiesComparable(previous.identityKey, processIdentityKey(row))) {
    return { kind: 'stale', holder: previous, reason: 'pid-reused' }
  }
  const scryCommand = row.command.includes('Scry.app/') || /(?:^|\/)Scry(?:\s|$)/.test(row.command) ||
    /out\/main\/daemon(?:-supervisor)?\.js/.test(row.command)
  if (scryCommand || (daemonEntry && row.command.includes(daemonEntry))) {
    return { kind: 'unverifiable', holder: previous }
  }
  return { kind: 'stale', holder: previous, reason: 'pid-reused' }
}

export async function acquireDaemonLock(options: AcquireDaemonLockOptions): Promise<DaemonLockOutcome> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  if (options.restrictDirectory ?? true) chmodSync(options.directory, 0o700)
  const name = options.name ?? DAEMON_LOCK_NAME
  const path = join(options.directory, name)
  const takeoverPath = join(options.directory, `${name}${TAKEOVER_SUFFIX}`)
  const pid = options.pid ?? process.pid
  const rowOf = (target: number): ProcessRow | undefined => options.lister
    ? options.lister().get(target)
    : readProcessIdentitySync(target)
  const self = rowOf(pid)
  const record: DaemonLockRecord = {
    pid,
    startedAt: self?.startedAt ?? '',
    identityKey: self ? processIdentityKey(self) : '',
    startedBy: options.startedBy,
    ...(options.role ? { role: options.role } : {})
  }
  if (!record.startedAt) throw new Error('daemon_lock_identity_unavailable')

  const write = (): void => {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  }
  const release = (): void => {
    const current = readDaemonLockRecord(path)
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
    const previous = readDaemonLockRecord(path)
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
      }
      await wait(TAKEOVER_WAIT_MS)
    }
  }
  if (!takenOver) return { status: 'already-running', holder: readDaemonLockRecord(path) ?? record, reason: 'identity-unverifiable' }

  try {
    await options.afterValidate?.()
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
