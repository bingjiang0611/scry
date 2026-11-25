import type Database from 'better-sqlite3'
import { canonicalJson } from './canonical-json'

/**
 * A3: evidence refs are additive per turn. `run.finalized` and `turn.delivery` must not drop the
 * refs `run.transcript_referenced` already recorded for the same run, whatever their order.
 */
export function mergeTurnEvidence(db: Database.Database, runId: string, evidence: string[] | null): void {
  if (!evidence?.length) return
  db.prepare(
    `UPDATE orch_p_turn
     SET evidence = CASE
       WHEN evidence IS NULL THEN ?
       ELSE (SELECT json_group_array(value) FROM (
         SELECT value FROM json_each(evidence) UNION SELECT value FROM json_each(?)
       ))
     END
     WHERE run_id = ?`
  ).run(canonicalJson(evidence), canonicalJson(evidence), runId)
}

/**
 * A3: the terminal event records what the Provider exit proves (`inferred`). Once the trace
 * archive is durable, `run.finalized` carries recorder evidence; promote the session's last-run
 * outcome to `exact` for that same run, and only for that run.
 */
export function promoteLastRunOutcomeToExact(
  db: Database.Database,
  runId: string,
  evidence: string[] | null,
  seq: number
): void {
  if (!evidence?.length) return
  const row = db
    .prepare(
      `SELECT s.session_key AS sessionKey, s.last_run_id AS lastRunId, s.last_run_outcome AS outcome
       FROM orch_p_run r JOIN orch_p_session s ON s.session_key = r.session_key
       WHERE r.run_id = ?`
    )
    .get(runId) as { sessionKey: string; lastRunId: string | null; outcome: string | null } | undefined
  if (!row || row.lastRunId !== runId || !row.outcome) return
  const { omissionReason: _omitted, ...rest } = JSON.parse(row.outcome) as Record<string, unknown>
  const upgraded = { ...rest, status: 'available', quality: 'exact', source: evidence }
  db.prepare('UPDATE orch_p_session SET last_run_outcome = ?, rev_seq = ? WHERE session_key = ?').run(
    canonicalJson(upgraded),
    seq,
    row.sessionKey
  )
}
