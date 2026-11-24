import type Database from 'better-sqlite3'

type SqliteDb = Database.Database

/**
 * C4: after a daemon restart, the background work the previous process was waiting on is gone. The
 * agent must be told that, in its own words, before it continues — otherwise it resumes as if those
 * tasks were still running.
 *
 * The evidence already exists: both Pi and Qoder write `runtime:background_unresolved` when a run
 * ends with tasks that never reached a terminal. This reads those events instead of keeping a second
 * registry that could disagree with them.
 */
export interface RestartBackgroundNote {
  sessionKey: string
  taskIds: string[]
}

export const RESTART_BACKGROUND_NOTE_PREFIX = '（宿主重启提示）'

export function renderRestartNote(taskIds: readonly string[]): string {
  const listed = taskIds.length > 0 ? `：${taskIds.join('、')}` : ''
  return `${RESTART_BACKGROUND_NOTE_PREFIX}上次的后台任务在 Scry 重启时被取消${listed}。它们的结果未知，请不要当作已经完成；需要时重新执行并先核验文件。`
}

/**
 * The last run of each session that ended with unresolved background work. A later successful run
 * replaces the note, because the agent has already moved on.
 */
export function findRestartBackgroundNotes(db: SqliteDb): RestartBackgroundNote[] {
  const rows = db.prepare(
    `SELECT session_key AS sessionKey, payload
       FROM orch_event
      WHERE session_key IS NOT NULL
        AND run_id IN (
          SELECT run_id FROM orch_event
           GROUP BY run_id
          HAVING MAX(seq) = MAX(CASE WHEN payload LIKE '%runtime:background_unresolved%' THEN seq END)
        )
      ORDER BY seq DESC`
  ).all() as { sessionKey: string; payload: string }[]
  const seen = new Set<string>()
  const notes: RestartBackgroundNote[] = []
  for (const row of rows) {
    if (seen.has(row.sessionKey)) continue
    let payload: { runtimeMetadata?: { pendingTaskIds?: unknown } } | undefined
    try { payload = JSON.parse(row.payload) } catch { continue }
    if (!row.payload.includes('runtime:background_unresolved')) continue
    seen.add(row.sessionKey)
    const ids = payload?.runtimeMetadata?.pendingTaskIds
    notes.push({
      sessionKey: row.sessionKey,
      taskIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    })
  }
  return notes
}

const NOTE_KEY = (sessionKey: string): string => `restart_background_note:${sessionKey}`

/** Stores each note once, so a second restart does not stack another copy on the same session. */
export function storeRestartBackgroundNotes(db: SqliteDb, notes: readonly RestartBackgroundNote[]): number {
  const insert = db.prepare(
    `INSERT INTO orch_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  let stored = 0
  for (const note of notes) {
    insert.run(NOTE_KEY(note.sessionKey), renderRestartNote(note.taskIds))
    stored += 1
  }
  return stored
}

/**
 * Hands the note to exactly one turn: the run that continues the session. Reading it removes it, so
 * the agent is told once and the prompt does not grow on every later turn.
 */
export function takeRestartBackgroundNote(db: SqliteDb, sessionKey: string): string | undefined {
  const row = db.prepare('SELECT value FROM orch_meta WHERE key = ?').get(NOTE_KEY(sessionKey)) as { value: string } | undefined
  if (!row) return undefined
  db.prepare('DELETE FROM orch_meta WHERE key = ?').run(NOTE_KEY(sessionKey))
  return row.value
}

/**
 * Prepends the note to the prompt inside the routing detail. The stored body is untouched: the note is
 * a one-off instruction for this turn, not part of what the user wrote.
 *
 * A detail that does not parse is returned unchanged — the dispatcher's own validation reports it.
 */
export function prependRestartNoteToDetail(detail: string | undefined, note: string | undefined): string | undefined {
  if (!note || detail === undefined) return detail
  let parsed: unknown
  try { parsed = JSON.parse(detail) } catch { return detail }
  if (!parsed || typeof parsed !== 'object') return detail
  const routing = parsed as Record<string, unknown>
  if (typeof routing.prompt !== 'string' || routing.prompt.length === 0) return detail
  return JSON.stringify({ ...routing, prompt: `${note}\n\n${routing.prompt}` })
}
