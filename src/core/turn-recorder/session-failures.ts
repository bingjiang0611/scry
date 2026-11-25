import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'

export const SESSION_FAILURE_SUSPEND_AFTER = 3
// The daemon polls every 1–15 seconds. A five-minute streak spans many polls, not one burst.
export const TURN_FAILURE_MIN_AGE_MS = 5 * 60_000
const TRANSIENT_SYSTEM_CODES = new Set(['EMFILE', 'ENFILE', 'ENOSPC', 'EAGAIN', 'EBUSY', 'EIO'])
export const SESSION_FAILURE_RETRY_MS = 60 * 60 * 1_000
const MAX_ERROR_LENGTH = 300

/** What failed: enumerating the session entry, or a pass over a readable session. */
export type SessionFailureScope = 'session' | 'turn'

export interface SessionFailureRecord {
  failures: number
  lastError: string
  lastAt: string
  firstAt?: string
  code?: string
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
 * These are skipped on the first occurrence and keep the original session-entry suspension rule.
 * Failures inside a readable session have a separate minimum streak age.
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
 * Count one failed pass for a session. Turn scope additionally requires a sustained streak.
 * A repeat after an hourly re-probe restarts the pause without another suspension log.
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
): Promise<SessionFailureRecord | undefined> {
  const rawCode = (error as NodeJS.ErrnoException | undefined)?.code
  const code = typeof rawCode === 'string' ? rawCode : undefined
  // The same resource shortage can affect every session. Do not turn it into a per-session pause.
  if (code && TRANSIENT_SYSTEM_CODES.has(code)) return undefined
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
  const key = sessionFailureKey(provider, sessionKey)
  return withDirectoryLock(join(dataRoot, 'locks', 'session-failures.lock'), async () => {
    const ledger = await readSessionFailures(dataRoot)
    const previous = ledger[key]
    const now = new Date(Date.now())
    const repeats = previous?.lastError === message && (previous.scope ?? 'session') === scope &&
      (scope === 'session' || previous.code === code)
    const firstAt = repeats && previous.firstAt ? previous.firstAt : now.toISOString()
    const failures = repeats ? previous.failures + 1 : 1
    const suspended = failures >= SESSION_FAILURE_SUSPEND_AFTER &&
      (scope === 'session' || now.getTime() - Date.parse(firstAt) >= TURN_FAILURE_MIN_AGE_MS)
    const record: SessionFailureRecord = {
      failures,
      lastError: message,
      lastAt: now.toISOString(),
      firstAt,
      ...(code ? { code } : {}),
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

export async function suspendedSessionCount(dataRoot: string, now = Date.now()): Promise<number> {
  return suspendedSessionKeys(await readSessionFailures(dataRoot), now).size
}
