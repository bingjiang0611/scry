import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'

export const SESSION_FAILURE_SUSPEND_AFTER = 3
export const SESSION_FAILURE_RETRY_MS = 60 * 60 * 1_000
const MAX_ERROR_LENGTH = 300

export interface SessionFailureRecord {
  failures: number
  lastError: string
  lastAt: string
  /** Set once the session reached the suspend threshold; the clock restarts on every retry. */
  suspendedAt?: string
}

export type SessionFailureLedger = Record<string, SessionFailureRecord>

export function sessionFailureKey(provider: ProviderId, sessionKey: string): string {
  return `${provider}__${sessionKey}`
}

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

export async function noteSessionFailure(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string,
  error: unknown
): Promise<SessionFailureRecord> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
  const key = sessionFailureKey(provider, sessionKey)
  return withDirectoryLock(join(dataRoot, 'locks', 'session-failures.lock'), async () => {
    const ledger = await readSessionFailures(dataRoot)
    const previous = ledger[key]
    const now = new Date()
    const failures = (previous?.failures ?? 0) + 1
    const suspended = failures >= SESSION_FAILURE_SUSPEND_AFTER
    const record: SessionFailureRecord = {
      failures,
      lastError: message,
      lastAt: now.toISOString(),
      ...(suspended ? { suspendedAt: now.toISOString() } : {})
    }
    ledger[key] = record
    await writeJsonAtomic(sessionFailureLedgerPath(dataRoot), ledger)
    if (suspended && !previous?.suspendedAt) {
      await appendRotatingLog(
        join(dataRoot, 'logs', 'recorder.log'),
        `${now.toISOString()} WARN session suspended after ${failures} failed passes: ${key}: ${message}`
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
  options: { present?: boolean } = {}
): Promise<void> {
  if (options.present === false) return
  const key = sessionFailureKey(provider, sessionKey)
  await withDirectoryLock(join(dataRoot, 'locks', 'session-failures.lock'), async () => {
    const ledger = await readSessionFailures(dataRoot)
    if (!ledger[key]) return
    delete ledger[key]
    await writeJsonAtomic(sessionFailureLedgerPath(dataRoot), ledger)
  })
}

export async function suspendedSessionCount(dataRoot: string, now = Date.now()): Promise<number> {
  return suspendedSessionKeys(await readSessionFailures(dataRoot), now).size
}
