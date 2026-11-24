import type Database from 'better-sqlite3'

type SqliteDb = Database.Database

/** A usage limit with a reset time is stored so the resume survives a restart. */
export interface UsageLimitRow {
  sessionKey: string
  resetAt: number | null
  provider: string
  profile: string | null
  cwd: string
  prompt: string
  source: string | null
  window: string | null
  recordedAt: number
  resumedAt: number | null
}

/**
 * C4: the pending item is a row, not a timer. A timer dies with the daemon; the row is what lets the
 * next process arm the same resume, and `resumed_at` is the single-write fence that stops a second
 * submit after a restart.
 */
export function recordUsageLimit(db: SqliteDb, row: UsageLimitRow): void {
  db.prepare(
    `INSERT INTO orch_usage_limit
       (session_key, reset_at, provider, profile, cwd, prompt, source, window, recorded_at, resumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_key, recorded_at) DO NOTHING`
  ).run(
    row.sessionKey, row.resetAt, row.provider, row.profile, row.cwd, row.prompt,
    row.source, row.window, row.recordedAt, row.resumedAt
  )
}

/** Every item that is still waiting for its reset time; a null reset time never becomes due. */
export function listPendingUsageLimits(db: SqliteDb): UsageLimitRow[] {
  return db.prepare(
    `SELECT session_key AS sessionKey, reset_at AS resetAt, provider, profile, cwd, prompt,
            source, window, recorded_at AS recordedAt, resumed_at AS resumedAt
       FROM orch_usage_limit
      WHERE resumed_at IS NULL AND reset_at IS NOT NULL
      ORDER BY reset_at ASC`
  ).all() as UsageLimitRow[]
}

/**
 * Claims one resume. Returns false when another caller (or an earlier daemon) already claimed it, so
 * the caller must not submit in that case.
 */
export function claimUsageLimitResume(db: SqliteDb, sessionKey: string, recordedAt: number, at: number): boolean {
  const result = db.prepare(
    'UPDATE orch_usage_limit SET resumed_at = ? WHERE session_key = ? AND recorded_at = ? AND resumed_at IS NULL'
  ).run(at, sessionKey, recordedAt)
  return result.changes === 1
}
