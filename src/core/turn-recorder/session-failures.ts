import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'

/**
 * Sessions whose every pass fails the same way, with no new evidence to act on: an unreadable
 * session directory, or an index entry that stopped being a session. A recovery pass used to retry
 * them forever and the whole pass paid for it, so every enumeration now stops treating a repeated
 * failure as work: it records why, skips the session, and retries once an hour so a repaired
 * workspace heals without a restart.
 *
 * The ledger is a report, never authority: skipping a session never closes its turn, drops its
 * marker, or deletes evidence. A suspended session keeps its `open.json` and its attention marker.
 */
export const SESSION_FAILURE_SUSPEND_AFTER = 3
export const SESSION_FAILURE_RETRY_MS = 60 * 60 * 1_000
const MAX_ERROR_LENGTH = 300

/** What failed: enumerating the session entry, or a pass over a readable session. */
export type SessionFailureScope = 'session' | 'turn'

export interface SessionFailureRecord {
  failures: number
  lastError: string
  lastAt: string
  /**
   * Absent in records written before the scope existed, and read as `session`. The scope decides who
   * may clear the streak: a readable directory clears only an entry-level failure, never a turn that
   * keeps failing while its own files sit right there.
   */
  scope?: SessionFailureScope
  /** Set once the session reached the suspend threshold; the clock restarts on every retry. */
  suspendedAt?: string
}

export type SessionFailureLedger = Record<string, SessionFailureRecord>

export function sessionFailureKey(provider: ProviderId, sessionKey: string): string {
  return `${provider}__${sessionKey}`
}

/**
 * Failures that say "this entry is not a session I can read", never "the evidence I read is bad".
 * These are skipped on the first occurrence; every other failure is counted by message and only
 * suspends once the same one repeats, because a read error can still change a verdict.
 */
const UNUSABLE_SESSION_CODES = new Set(['ENOTDIR', 'ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'])

export function isUnusableSessionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && UNUSABLE_SESSION_CODES.has(code)
}

export function sessionFailureLedgerPath(dataRoot: string): string {
  return join(dataRoot, 'session-failures.json')
}

export async function readSessionFailures(dataRoot: string): Promise<SessionFailureLedger> {
  const ledger = await readJson<SessionFailureLedger>(sessionFailureLedgerPath(dataRoot))
  if (!ledger || typeof ledger !== 'object') return {}
  const result: SessionFailureLedger = {}
  for (const [key, record] of Object.entries(ledger)) {
    if (!record || typeof record !== 'object') continue
    if (typeof record.failures !== 'number') continue
    result[key] = record
  }
  return result
}

/** Suspended sessions that are not yet due for their hourly re-probe. */
export function suspendedSessionKeys(ledger: SessionFailureLedger, now = Date.now()): Set<string> {
  const keys = new Set<string>()
  for (const [key, record] of Object.entries(ledger)) {
    if (!record.suspendedAt) continue
    const suspendedAt = Date.parse(record.suspendedAt)
    if (Number.isFinite(suspendedAt) && now - suspendedAt < SESSION_FAILURE_RETRY_MS) keys.add(key)
  }
  return keys
}

/**
 * Count one failed pass for a session. Reaching the threshold suspends it and leaves one log line;
 * every later failure re-suspends from now, so the retry stays hourly instead of every pass.
 *
 * Only the same failure counts twice. A pass that fails differently has learned something new
 * (a different file, a lock that was not there before), so the streak restarts: the ledger suspends a
 * reason, never a session with changing reasons. Read errors inside a turn are recorded here too —
 * an `ERR_STRING_TOO_LONG` on the same window cannot turn into evidence by being retried every pass —
 * but the suspension still only skips recovery passes and never closes, drops or rewrites a turn.
 */
export async function noteSessionFailure(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string,
  error: unknown,
  scope: SessionFailureScope = 'session'
): Promise<SessionFailureRecord> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
  const key = sessionFailureKey(provider, sessionKey)
  return withDirectoryLock(join(dataRoot, 'locks', 'session-failures.lock'), async () => {
    const ledger = await readSessionFailures(dataRoot)
    const previous = ledger[key]
    const now = new Date()
    const repeats = previous?.lastError === message && (previous.scope ?? 'session') === scope
    const failures = repeats ? previous.failures + 1 : 1
    const suspended = failures >= SESSION_FAILURE_SUSPEND_AFTER
    const record: SessionFailureRecord = {
      failures,
      lastError: message,
      lastAt: now.toISOString(),
      scope,
      ...(suspended ? { suspendedAt: now.toISOString() } : {})
    }
    ledger[key] = record
    await writeJsonAtomic(sessionFailureLedgerPath(dataRoot), ledger)
    if (suspended && !previous?.suspendedAt) {
      await appendRotatingLog(
        join(dataRoot, 'logs', 'recorder.log'),
        `${now.toISOString()} WARN session suspended after ${failures} identical failed passes (retry in ${Math.round(SESSION_FAILURE_RETRY_MS / 60_000)} min): ${key}: ${message}`
      ).catch(() => undefined)
    }
    return record
  })
}

/**
 * Forget a session's failures after a pass that finished its work. `present: false` skips the read
 * and the lock: a healthy workspace has no entries, and a pass visits every session.
 */
export async function clearSessionFailure(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string,
  options: { present?: boolean; scope?: SessionFailureScope } = {}
): Promise<void> {
  if (options.present === false) return
  const key = sessionFailureKey(provider, sessionKey)
  await withDirectoryLock(join(dataRoot, 'locks', 'session-failures.lock'), async () => {
    const ledger = await readSessionFailures(dataRoot)
    const record = ledger[key]
    if (!record) return
    // A caller that only proved the entry readable cannot speak for a failure inside the turn.
    if (options.scope && (record.scope ?? 'session') !== options.scope) return
    delete ledger[key]
    await writeJsonAtomic(sessionFailureLedgerPath(dataRoot), ledger)
  })
}

/** How many sessions are currently skipped, for the health report every reader already reads. */
export async function suspendedSessionCount(dataRoot: string, now = Date.now()): Promise<number> {
  return suspendedSessionKeys(await readSessionFailures(dataRoot), now).size
}
