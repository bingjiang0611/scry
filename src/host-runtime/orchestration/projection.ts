import type Database from 'better-sqlite3'
import { canonicalJson } from './canonical-json'
import type {
  BodyDescriptor,
  CommandReceiptRow,
  InteractionProjectionRow,
  OrchestrationEventRow,
  OrchestrationOrigin,
  OrchestrationScope,
  OrdinalOrigin,
  RunLifecycleState,
  RunProjectionRow,
  SessionLineage,
  SessionProjectionRow,
  TurnAuthor,
  TurnDeliveryState,
  TurnProjectionRow
} from './types'
import type { Evidence } from '../../shared/turn-record-contracts'

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  return JSON.parse(raw) as T
}

export function mapSessionRow(row: Record<string, unknown>): SessionProjectionRow {
  return {
    sessionKey: String(row.session_key),
    conversationId: (row.conversation_id as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    profile: (row.profile as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    ts: Number(row.ts),
    pinnedAt: row.pinned_at === null ? null : Number(row.pinned_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    lastRunId: (row.last_run_id as string | null) ?? null,
    lastRunOutcome: parseJson<Evidence<string>>(row.last_run_outcome as string | null),
    activeRunId: (row.active_run_id as string | null) ?? null,
    pendingQuestions: Number(row.pending_questions ?? 0),
    legacy: Number(row.legacy ?? 0) === 1,
    revSeq: Number(row.rev_seq),
    parentSessionKey: (row.parent_session_key as string | null) ?? null,
    rootSessionKey: (row.root_session_key as string | null) ?? null,
    lineage: parseJson<SessionLineage>(row.lineage as string | null),
    createdBy: (row.created_by as string | null) ?? null
  }
}

export function mapTurnRow(row: Record<string, unknown>): TurnProjectionRow {
  return {
    sessionKey: String(row.session_key),
    ordinal: Number(row.ordinal),
    runId: String(row.run_id),
    ordinalOrigin: String(row.ordinal_origin) as OrdinalOrigin,
    userTextPreview: (row.user_text_preview as string | null) ?? null,
    delivery: String(row.delivery) as TurnDeliveryState,
    outcome: parseJson<Evidence<string>>(row.outcome as string | null),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    recoveredAt: row.recovered_at === null ? null : Number(row.recovered_at),
    contentRef: (row.content_ref as string | null) ?? null,
    evidence: parseJson<string[]>(row.evidence as string | null),
    revSeq: Number(row.rev_seq),
    author: String(row.author) as TurnAuthor
  }
}

export function mapRunRow(row: Record<string, unknown>): RunProjectionRow {
  return {
    runId: String(row.run_id),
    sessionKey: (row.session_key as string | null) ?? null,
    ownerActor: String(row.owner_actor),
    scope: String(row.scope) as OrchestrationScope,
    origin: String(row.origin) as OrchestrationOrigin,
    provider: (row.provider as string | null) ?? null,
    profile: (row.profile as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    promptPreview: (row.prompt_preview as string | null) ?? null,
    lifecycle: String(row.lifecycle) as RunLifecycleState,
    stopState: (row.stop_state as string | null) ?? null,
    outputSeq: row.output_seq === null || row.output_seq === undefined ? null : Number(row.output_seq),
    intentSeq: Number(row.intent_seq),
    body: parseJson<BodyDescriptor>(row.body as string | null),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    recoveredAt: row.recovered_at === null ? null : Number(row.recovered_at),
    outcome: parseJson<Evidence<string>>(row.outcome as string | null),
    revSeq: Number(row.rev_seq),
    parentRunId: (row.parent_run_id as string | null) ?? null
  }
}

export function mapInteractionRow(row: Record<string, unknown>): InteractionProjectionRow {
  return {
    runId: String(row.run_id),
    questionId: String(row.question_id),
    kind: String(row.kind),
    source: String(row.source),
    state: String(row.state) as 'open' | 'answered' | 'closed',
    answerId: (row.answer_id as string | null) ?? null,
    answerSha256: (row.answer_sha256 as string | null) ?? null,
    openedSeq: Number(row.opened_seq),
    closedSeq: row.closed_seq === null ? null : Number(row.closed_seq),
    answeredBy: (row.answered_by as string | null) ?? null
  }
}

export function mapReceiptRow(row: Record<string, unknown>): CommandReceiptRow {
  return {
    commandId: String(row.command_id),
    actor: String(row.actor),
    type: String(row.type),
    payloadSha256: String(row.payload_sha256),
    acceptedAt: Number(row.accepted_at),
    status: String(row.status) as 'accepted' | 'rejected',
    reason: (row.reason as string | null) ?? null,
    result: parseJson<Record<string, unknown>>(row.result as string | null),
    resultSeq: row.result_seq === null ? null : Number(row.result_seq),
    principal: String(row.principal),
    via: (row.via as string | null) ?? null,
    actorRunId: (row.actor_run_id as string | null) ?? null
  }
}

function ensureSessionForRun(db: Database.Database, event: OrchestrationEventRow, p: Record<string, unknown>): void {
  if (!event.sessionKey) return
  db.prepare(
    `INSERT INTO orch_p_session (
      session_key, provider, profile, cwd, ts, last_run_id, active_run_id, rev_seq, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      provider = COALESCE(excluded.provider, orch_p_session.provider),
      profile = COALESCE(excluded.profile, orch_p_session.profile),
      cwd = COALESCE(excluded.cwd, orch_p_session.cwd),
      ts = MAX(orch_p_session.ts, excluded.ts),
      last_run_id = excluded.last_run_id,
      active_run_id = excluded.active_run_id,
      rev_seq = excluded.rev_seq`
  ).run(
    event.sessionKey,
    (p.provider as string | null) ?? null,
    (p.profile as string | null) ?? null,
    event.cwd,
    event.at,
    event.runId,
    event.runId,
    event.seq,
    event.actor
  )
}

/**
 * Deterministic SQL projection applier (data §4.4).
 * Executed inside the same SQLite transaction as event insertion, and reused verbatim for
 * replay-from-empty consistency verification.
 */
export function applyEventToProjection(db: Database.Database, event: OrchestrationEventRow): void {
  const p = event.payload
  switch (event.type) {
    case 'run.intent_recorded': {
      db.prepare(
        `INSERT INTO orch_p_run (
          run_id, session_key, owner_actor, scope, origin, provider, profile, cwd,
          prompt_preview, lifecycle, stop_state, output_seq, intent_seq, body,
          settled_at, recovered_at, outcome, rev_seq, parent_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`
      ).run(
        event.runId,
        event.sessionKey,
        event.actor,
        event.scope,
        String(p.origin ?? event.scope),
        (p.provider as string | null) ?? null,
        (p.profile as string | null) ?? null,
        event.cwd,
        (p.promptPreview as string | null) ?? null,
        event.seq,
        p.body ? canonicalJson(p.body) : null,
        event.seq,
        (p.parentRunId as string | null) ?? null
      )
      ensureSessionForRun(db, event, p)
      return
    }

    case 'run.admitted':
    case 'run.dispatched': {
      const lifecycle = event.type === 'run.admitted' ? 'admitted' : 'dispatched'
      db.prepare('UPDATE orch_p_run SET lifecycle = ?, rev_seq = ? WHERE run_id = ?').run(
        lifecycle,
        event.seq,
        event.runId
      )
      return
    }

    case 'run.stop_requested': {
      db.prepare("UPDATE orch_p_run SET stop_state = 'requested', rev_seq = ? WHERE run_id = ?").run(
        event.seq,
        event.runId
      )
      return
    }

    case 'run.question_opened': {
      db.prepare(
        `INSERT OR REPLACE INTO orch_p_interaction (
          run_id, question_id, kind, source, state, answer_id, answer_sha256,
          opened_seq, closed_seq, answered_by
        ) VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?, NULL, NULL)`
      ).run(
        event.runId,
        String(p.questionId),
        String(p.kind ?? 'question'),
        String(p.source ?? 'provider'),
        event.seq
      )
      if (event.sessionKey) {
        db.prepare(
          'UPDATE orch_p_session SET pending_questions = pending_questions + 1, rev_seq = ? WHERE session_key = ?'
        ).run(event.seq, event.sessionKey)
      }
      return
    }

    case 'run.question_answered': {
      db.prepare(
        `UPDATE orch_p_interaction
         SET state = 'answered', answer_id = ?, answer_sha256 = ?, answered_by = ?
         WHERE run_id = ? AND question_id = ?`
      ).run(
        String(p.answerId ?? ''),
        String(p.answerSha256 ?? ''),
        String(p.answeredBy ?? event.actor),
        event.runId,
        String(p.questionId)
      )
      return
    }

    case 'run.question_closed': {
      const prev = db
        .prepare('SELECT state FROM orch_p_interaction WHERE run_id = ? AND question_id = ?')
        .get(event.runId, String(p.questionId)) as { state: string } | undefined
      db.prepare(
        "UPDATE orch_p_interaction SET state = 'closed', closed_seq = ? WHERE run_id = ? AND question_id = ?"
      ).run(event.seq, event.runId, String(p.questionId))
      if (event.sessionKey && prev && prev.state !== 'closed') {
        db.prepare(
          'UPDATE orch_p_session SET pending_questions = MAX(0, pending_questions - 1), rev_seq = ? WHERE session_key = ?'
        ).run(event.seq, event.sessionKey)
      }
      return
    }

    case 'run.finalized': {
      if (typeof p.outputSeq === 'number') {
        db.prepare('UPDATE orch_p_run SET output_seq = ?, rev_seq = ? WHERE run_id = ?').run(
          p.outputSeq,
          event.seq,
          event.runId
        )
      }
      if (event.runId) {
        db.prepare(
          'UPDATE orch_p_turn SET content_ref = COALESCE(?, content_ref), evidence = COALESCE(?, evidence), rev_seq = ? WHERE run_id = ?'
        ).run(
          (p.contentRef as string | null) ?? null,
          event.evidence ? canonicalJson(event.evidence) : null,
          event.seq,
          event.runId
        )
      }
      return
    }

    case 'run.settled':
    case 'run.failed':
    case 'run.cancelled':
    case 'run.interrupted': {
      const lifecycle = event.type.slice(4)
      const outcomeJson = p.outcome ? canonicalJson(p.outcome) : null
      const settledAt = p.settledAt === undefined ? null : (p.settledAt as number | null)
      const recoveredAt = p.recoveredAt === undefined ? null : (p.recoveredAt as number | null)
      db.prepare(
        `UPDATE orch_p_run
         SET lifecycle = ?, settled_at = ?, recovered_at = ?, outcome = ?, rev_seq = ?
         WHERE run_id = ?`
      ).run(lifecycle, settledAt, recoveredAt, outcomeJson, event.seq, event.runId)
      if (event.sessionKey) {
        db.prepare(
          `UPDATE orch_p_session
           SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
               last_run_id = ?, last_run_outcome = ?, ts = MAX(ts, ?), rev_seq = ?
           WHERE session_key = ?`
        ).run(event.runId, event.runId, outcomeJson, event.at, event.seq, event.sessionKey)
      }
      if (event.runId) {
        db.prepare(
          `UPDATE orch_p_turn
           SET settled_at = ?, recovered_at = ?, outcome = COALESCE(?, outcome), rev_seq = ?
           WHERE run_id = ?`
        ).run(settledAt, recoveredAt, outcomeJson, event.seq, event.runId)
      }
      return
    }

    case 'turn.began': {
      db.prepare(
        `INSERT INTO orch_p_turn (
          session_key, ordinal, run_id, ordinal_origin, user_text_preview,
          delivery, outcome, started_at, settled_at, recovered_at,
          content_ref, evidence, rev_seq, author
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`
      ).run(
        String(p.sessionKey),
        Number(p.ordinal),
        String(p.runId),
        String(p.ordinalOrigin ?? 'native'),
        (p.userTextPreview as string | null) ?? null,
        event.at,
        event.seq,
        String(p.author ?? 'unavailable')
      )
      return
    }

    case 'turn.delivery': {
      db.prepare(
        `UPDATE orch_p_turn
         SET delivery = ?,
             outcome = COALESCE(?, outcome),
             settled_at = COALESCE(?, settled_at),
             evidence = COALESCE(?, evidence),
             rev_seq = ?
         WHERE run_id = ?`
      ).run(
        String(p.delivery),
        p.outcome ? canonicalJson(p.outcome) : null,
        p.settledAt === undefined ? null : (p.settledAt as number | null),
        event.evidence ? canonicalJson(event.evidence) : null,
        event.seq,
        String(p.runId)
      )
      return
    }

    case 'session.created':
    case 'session.forked': {
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
      return
    }

    case 'session.discovered': {
      db.prepare(
        `INSERT INTO orch_p_session (
          session_key, provider, profile, cwd, title, ts, legacy, rev_seq, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          title = COALESCE(excluded.title, orch_p_session.title),
          ts = MAX(orch_p_session.ts, excluded.ts),
          rev_seq = excluded.rev_seq`
      ).run(
        String(p.sessionKey),
        (p.provider as string | null) ?? null,
        (p.profile as string | null) ?? null,
        (p.cwd as string | null) ?? null,
        (p.title as string | null) ?? null,
        event.at,
        event.seq,
        event.actor
      )
      return
    }

    case 'session.imported': {
      db.prepare(
        `INSERT INTO orch_p_session (
          session_key, conversation_id, provider, profile, cwd, title, ts,
          pinned_at, archived_at, last_run_id, last_run_outcome, active_run_id,
          pending_questions, legacy, rev_seq,
          parent_session_key, root_session_key, lineage, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          conversation_id = COALESCE(excluded.conversation_id, orch_p_session.conversation_id),
          provider = COALESCE(excluded.provider, orch_p_session.provider),
          profile = COALESCE(excluded.profile, orch_p_session.profile),
          cwd = COALESCE(excluded.cwd, orch_p_session.cwd),
          title = excluded.title,
          ts = MAX(orch_p_session.ts, excluded.ts),
          pinned_at = excluded.pinned_at,
          archived_at = excluded.archived_at,
          last_run_id = COALESCE(excluded.last_run_id, orch_p_session.last_run_id),
          last_run_outcome = COALESCE(excluded.last_run_outcome, orch_p_session.last_run_outcome),
          legacy = 1,
          rev_seq = excluded.rev_seq,
          parent_session_key = COALESCE(excluded.parent_session_key, orch_p_session.parent_session_key),
          root_session_key = COALESCE(excluded.root_session_key, orch_p_session.root_session_key),
          lineage = COALESCE(excluded.lineage, orch_p_session.lineage)`
      ).run(
        String(p.sessionKey),
        (p.conversationId as string | null) ?? null,
        (p.provider as string | null) ?? null,
        (p.profile as string | null) ?? null,
        (p.cwd as string | null) ?? null,
        (p.title as string | null) ?? null,
        Number(p.ts ?? event.at),
        (p.pinnedAt as number | null) ?? null,
        (p.archivedAt as number | null) ?? null,
        (p.lastRunId as string | null) ?? null,
        p.lastRunOutcome ? canonicalJson(p.lastRunOutcome) : null,
        event.seq,
        (p.parentSessionKey as string | null) ?? null,
        (p.rootSessionKey as string | null) ?? null,
        p.lineage ? canonicalJson(p.lineage) : null,
        event.actor
      )
      return
    }

    case 'session.renamed':
      db.prepare('UPDATE orch_p_session SET title = ?, rev_seq = ? WHERE session_key = ?').run(
        String(p.title ?? ''),
        event.seq,
        event.sessionKey
      )
      return
    case 'session.pinned':
      db.prepare('UPDATE orch_p_session SET pinned_at = ?, rev_seq = ? WHERE session_key = ?').run(
        event.at,
        event.seq,
        event.sessionKey
      )
      return
    case 'session.unpinned':
      db.prepare('UPDATE orch_p_session SET pinned_at = NULL, rev_seq = ? WHERE session_key = ?').run(
        event.seq,
        event.sessionKey
      )
      return
    case 'session.archived':
      db.prepare('UPDATE orch_p_session SET archived_at = ?, rev_seq = ? WHERE session_key = ?').run(
        event.at,
        event.seq,
        event.sessionKey
      )
      return
    case 'session.restored':
      db.prepare('UPDATE orch_p_session SET archived_at = NULL, rev_seq = ? WHERE session_key = ?').run(
        event.seq,
        event.sessionKey
      )
      return
    case 'session.deleted':
      if (event.sessionKey) {
        db.prepare('DELETE FROM orch_p_interaction WHERE run_id IN (SELECT run_id FROM orch_p_run WHERE session_key = ?)').run(event.sessionKey)
        db.prepare('DELETE FROM orch_p_turn WHERE session_key = ?').run(event.sessionKey)
        db.prepare('DELETE FROM orch_p_run WHERE session_key = ?').run(event.sessionKey)
        db.prepare('DELETE FROM orch_p_session WHERE session_key = ?').run(event.sessionKey)
      }
      return
    case 'run.session_bound':
    case 'run.provider_settled':
    case 'run.content_gap':
    case 'effect.voided':
    case 'host.started':
      return
  }
}
