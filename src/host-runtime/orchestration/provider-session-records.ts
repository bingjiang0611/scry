import type Database from 'better-sqlite3'

type SqliteDb = Database.Database

export interface ProviderSessionRecord {
  key: string
  provider: string
  /** Empty until the Provider reports its native session id for this process. */
  nativeSessionId?: string
  at: number
}

/**
 * C1: a session that was opened is a stored fact, so "reused" and "released because idle" are
 * claims the App can check instead of trusting a log line. Rows are never pruned.
 */
export function recordProviderSessionOpened(db: SqliteDb, record: ProviderSessionRecord): void {
  db.prepare(
    `INSERT INTO orch_provider_session (key, provider, session_key, native_session_id, opened_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET last_used_at = excluded.last_used_at`
  ).run(record.key, record.provider, null, record.nativeSessionId ?? null, record.at, record.at)
}

/** The native id arrives after `session/new`; the row must not claim a session it did not open. */
export function recordProviderSessionNativeId(db: SqliteDb, key: string, nativeSessionId: string): void {
  db.prepare(
    'UPDATE orch_provider_session SET native_session_id = ? WHERE key = ? AND native_session_id IS NULL'
  ).run(nativeSessionId, key)
}

export function recordProviderSessionReleased(
  db: SqliteDb,
  key: string,
  reason: string,
  at: number
): void {
  db.prepare(
    `UPDATE orch_provider_session SET released_at = ?, release_reason = ?, last_used_at = ?
     WHERE key = ? AND released_at IS NULL`
  ).run(at, reason, at, key)
}

export interface ProviderSessionRow {
  key: string
  provider: string
  sessionKey: string | null
  nativeSessionId: string | null
  openedAt: number
  lastUsedAt: number
  releasedAt: number | null
  releaseReason: string | null
}

export function readProviderSessions(db: SqliteDb, limit = 50): ProviderSessionRow[] {
  const rows = db.prepare(
    `SELECT key, provider, session_key, native_session_id, opened_at, last_used_at, released_at, release_reason
     FROM orch_provider_session ORDER BY opened_at DESC LIMIT ?`
  ).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    key: String(row.key),
    provider: String(row.provider),
    sessionKey: row.session_key === null ? null : String(row.session_key),
    nativeSessionId: row.native_session_id === null ? null : String(row.native_session_id),
    openedAt: Number(row.opened_at),
    lastUsedAt: Number(row.last_used_at),
    releasedAt: row.released_at === null ? null : Number(row.released_at),
    releaseReason: row.release_reason === null ? null : String(row.release_reason)
  }))
}
