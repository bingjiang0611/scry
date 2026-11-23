import type Database from 'better-sqlite3'
import { canonicalJson } from './canonical-json'
import type { OrchestrationEventRow } from './types'

/**
 * Deterministic SQL projection applier for P6 task & delegation policy events (tools §6.5).
 */
export function applyTaskEventToProjection(db: Database.Database, event: OrchestrationEventRow): boolean {
  const p = event.payload
  switch (event.type) {
    case 'delegation.project_policy_set':
      db.prepare(
        `INSERT INTO orch_p_delegation_policy (scope_kind, scope_key, enabled, updated_at, updated_by, rev_seq)
         VALUES ('project', ?, ?, ?, ?, ?)
         ON CONFLICT(scope_kind, scope_key) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           rev_seq = excluded.rev_seq`
      ).run(String(p.cwd), p.enabled === true ? 1 : 0, event.at, event.actor, event.seq)
      return true

    case 'delegation.session_full_access_set':
      db.prepare(
        `INSERT INTO orch_p_delegation_policy (scope_kind, scope_key, enabled, updated_at, updated_by, rev_seq)
         VALUES ('session', ?, ?, ?, ?, ?)
         ON CONFLICT(scope_kind, scope_key) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           rev_seq = excluded.rev_seq`
      ).run(String(p.sessionKey), p.enabled === true ? 1 : 0, event.at, event.actor, event.seq)
      return true

    case 'task.requested':
      db.prepare(
        `INSERT INTO orch_p_task (
          task_id, parent_session_key, parent_run_id, actor, principal, via, command_id,
          child_session_key, child_run_id, provider, profile, cwd, status, state_version,
          permission_mode, permission_mode_source, title, role, target_model, target_effort,
          isolation, confirmation_question_id, cancel_confirmation_question_id, body,
          summary, reason, created_at, settled_at, rev_seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'awaiting_confirmation', 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, ?)`
      ).run(
        String(p.taskId),
        String(p.parentSessionKey),
        String(p.parentRunId),
        event.actor,
        event.principal,
        event.via,
        event.commandId ?? '',
        String(p.provider),
        (p.profile as string | null) ?? null,
        String(p.cwd),
        String(p.permissionMode),
        String(p.permissionModeSource),
        (p.title as string | null) ?? null,
        (p.role as string | null) ?? null,
        (p.targetModel as string | null) ?? null,
        (p.targetEffort as string | null) ?? null,
        p.isolation === 'worktree' ? 'worktree' : 'shared',
        (p.confirmationQuestionId as string | null) ?? null,
        p.body ? canonicalJson(p.body) : null,
        event.at,
        event.seq
      )
      return true

    case 'task.declined':
      db.prepare(
        `UPDATE orch_p_task
         SET status = 'declined', state_version = state_version + 1, reason = ?, settled_at = ?, rev_seq = ?
         WHERE task_id = ?`
      ).run((p.reason as string | null) ?? 'user_declined', event.at, event.seq, String(p.taskId))
      return true

    case 'task.child_bound':
      db.prepare(
        `UPDATE orch_p_task
         SET child_session_key = ?, child_run_id = ?, status = 'queued',
             state_version = state_version + 1, rev_seq = ?
         WHERE task_id = ?`
      ).run(String(p.childSessionKey), String(p.childRunId), event.seq, String(p.taskId))
      return true

    case 'task.cancel_requested':
      db.prepare(
        `UPDATE orch_p_task
         SET cancel_confirmation_question_id = ?, state_version = state_version + 1, rev_seq = ?
         WHERE task_id = ?`
      ).run((p.confirmationQuestionId as string | null) ?? null, event.seq, String(p.taskId))
      return true

    case 'task.settled':
      db.prepare(
        `UPDATE orch_p_task
         SET status = ?, state_version = state_version + 1,
             summary = COALESCE(?, summary),
             reason = COALESCE(?, reason),
             settled_at = ?, rev_seq = ?
         WHERE task_id = ?`
      ).run(
        String(p.status),
        p.summary ? canonicalJson(p.summary) : null,
        (p.reason as string | null) ?? null,
        typeof p.settledAt === 'number' ? p.settledAt : event.at,
        event.seq,
        String(p.taskId)
      )
      return true

    default:
      return false
  }
}

/**
 * Keeps `orch_p_task.status` and `state_version` in sync when a child run dispatches or
 * opens/closes a user interaction (B6 edge-triggered stateVersion).
 */
export function syncTaskProjectionOnChildRunEvent(db: Database.Database, event: OrchestrationEventRow): void {
  if (!event.runId) return
  if (event.type === 'run.admitted') {
    db.prepare(
      `UPDATE orch_p_task
       SET status = 'starting', state_version = state_version + 1, rev_seq = ?
       WHERE child_run_id = ? AND status IN ('queued')`
    ).run(event.seq, event.runId)
    return
  }
  if (event.type === 'run.dispatched') {
    db.prepare(
      `UPDATE orch_p_task
       SET status = 'running', state_version = state_version + 1, rev_seq = ?
       WHERE child_run_id = ? AND status IN ('queued', 'starting')`
    ).run(event.seq, event.runId)
    return
  }
  if (event.type === 'run.question_opened') {
    db.prepare(
      `UPDATE orch_p_task
       SET status = 'waiting_interaction', state_version = state_version + 1, rev_seq = ?
       WHERE child_run_id = ? AND status IN ('queued', 'starting', 'running')`
    ).run(event.seq, event.runId)
    return
  }
  if (event.type === 'run.question_closed') {
    const openLeft = db
      .prepare("SELECT 1 FROM orch_p_interaction WHERE run_id = ? AND state = 'open' LIMIT 1")
      .get(event.runId)
    if (!openLeft) {
      db.prepare(
        `UPDATE orch_p_task
         SET status = 'running', state_version = state_version + 1, rev_seq = ?
         WHERE child_run_id = ? AND status = 'waiting_interaction'`
      ).run(event.seq, event.runId)
    }
  }
}

export function deleteSessionTasksAndPolicy(db: Database.Database, sessionKey: string): void {
  db.prepare('DELETE FROM orch_p_task WHERE parent_session_key = ?').run(sessionKey)
  db.prepare("DELETE FROM orch_p_delegation_policy WHERE scope_kind = 'session' AND scope_key = ?").run(sessionKey)
}
