import type Database from 'better-sqlite3'
import { canonicalJson } from './canonical-json'
import type { OrchestrationEventRow } from './types'
import { projectSessionBinding } from './native-session-bindings'

/**
 * D3/D5: the row a `session.created` / `session.forked` event writes. Both carry the same catalog
 * identity fields, so one upsert covers them; the lineage columns are COALESCEd so a later event
 * that only knows the native session never erases a parent it did not name.
 */
export function upsertSessionRow(db: Database.Database, event: OrchestrationEventRow, p: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO orch_p_session (
      session_key, conversation_id, provider, profile, cwd, title, ts,
      pinned_at, archived_at, last_run_id, last_run_outcome, active_run_id,
      pending_questions, legacy, rev_seq,
      parent_session_key, root_session_key, lineage, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      conversation_id = COALESCE(excluded.conversation_id, orch_p_session.conversation_id),
      provider = COALESCE(excluded.provider, orch_p_session.provider),
      profile = COALESCE(excluded.profile, orch_p_session.profile),
      cwd = COALESCE(excluded.cwd, orch_p_session.cwd),
      title = COALESCE(excluded.title, orch_p_session.title),
      ts = MAX(orch_p_session.ts, excluded.ts),
      rev_seq = excluded.rev_seq,
      parent_session_key = COALESCE(excluded.parent_session_key, orch_p_session.parent_session_key),
      root_session_key = COALESCE(excluded.root_session_key, orch_p_session.root_session_key),
      lineage = COALESCE(excluded.lineage, orch_p_session.lineage),
      created_by = COALESCE(excluded.created_by, orch_p_session.created_by)`
  ).run(
    String(p.sessionKey),
    (p.conversationId as string | null) ?? null,
    (p.provider as string | null) ?? null,
    (p.profile as string | null) ?? null,
    (p.cwd as string | null) ?? null,
    (p.title as string | null) ?? null,
    event.at,
    event.seq,
    (p.parentSessionKey as string | null) ?? null,
    (p.rootSessionKey as string | null) ?? null,
    p.lineage ? canonicalJson(p.lineage) : null,
    (p.createdBy as string | null) ?? event.actor
  )
  projectSessionBinding(db, {
    sessionKey: String(p.sessionKey),
    provider: (p.provider as string | null) ?? null,
    profile: (p.profile as string | null) ?? null,
    cwd: (p.cwd as string | null) ?? null,
    catalog: p.catalog ?? null,
    at: event.at
  })
}
