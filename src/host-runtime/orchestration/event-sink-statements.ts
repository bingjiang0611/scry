import type Database from 'better-sqlite3'
import type { OrchestrationEventRow, OrchestrationScope, OutboxEffectRow } from './types'

export interface EventSinkStatements {
  insertEvent: Database.Statement
  insertOutbox: Database.Statement
  insertCommand: Database.Statement
  insertLegacyRun: Database.Statement
  advanceLegacySeq: Database.Statement
  readReceipt: Database.Statement
  readRun: Database.Statement
  readSession: Database.Statement
  readTurnByRunId: Database.Statement
  readTurnByOrdinal: Database.Statement
  nextOrdinal: Database.Statement
  readInteraction: Database.Statement
  hasActiveSessionRun: Database.Statement
  activeRunCount: Database.Statement
  listNonTerminalChildRuns: Database.Statement
  listNonTerminalChildRunsBySession: Database.Statement
}

export function prepareEventSinkStatements(db: Database.Database): EventSinkStatements {
  return {
    insertEvent: db.prepare(
      `INSERT INTO orch_event (
        event_id, at, type, stream, session_key, run_id, cwd, command_id,
        actor, scope, payload, evidence, principal, via, actor_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertOutbox: db.prepare(
      `INSERT INTO orch_outbox (
        effect_id, kind, policy, run_id, causation_seq, payload, state,
        expires_at, attempts, lease_owner, claimed_at, completed_at, result_seq, last_error, session_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?)`
    ),
    insertCommand: db.prepare(
      `INSERT INTO orch_command (
        command_id, actor, type, payload_sha256, accepted_at, status,
        reason, result, result_seq, principal, via, actor_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertLegacyRun: db.prepare(
      'INSERT OR IGNORE INTO orch_legacy_run (ledger_run_id, run_id) VALUES (?, ?)'
    ),
    advanceLegacySeq: db.prepare(
      `INSERT INTO orch_meta (key, value) VALUES ('legacy_ledger_seq', ?)
       ON CONFLICT(key) DO UPDATE SET value = CASE
         WHEN CAST(excluded.value AS INTEGER) > CAST(orch_meta.value AS INTEGER) THEN excluded.value
         ELSE orch_meta.value
       END`
    ),
    readReceipt: db.prepare('SELECT * FROM orch_command WHERE command_id = ? AND actor = ?'),
    readRun: db.prepare('SELECT * FROM orch_p_run WHERE run_id = ?'),
    readSession: db.prepare('SELECT * FROM orch_p_session WHERE session_key = ?'),
    readTurnByRunId: db.prepare('SELECT * FROM orch_p_turn WHERE run_id = ?'),
    readTurnByOrdinal: db.prepare('SELECT * FROM orch_p_turn WHERE session_key = ? AND ordinal = ?'),
    nextOrdinal: db.prepare(
      'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM orch_p_turn WHERE session_key = ?'
    ),
    readInteraction: db.prepare('SELECT * FROM orch_p_interaction WHERE run_id = ? AND question_id = ?'),
    hasActiveSessionRun: db.prepare(
      `SELECT 1 FROM orch_p_run
       WHERE session_key = ? AND lifecycle NOT IN ('settled', 'failed', 'cancelled', 'interrupted')
       LIMIT 1`
    ),
    activeRunCount: db.prepare(
      "SELECT COUNT(*) AS count FROM orch_p_run WHERE lifecycle NOT IN ('settled', 'failed', 'cancelled', 'interrupted')"
    ),
    listNonTerminalChildRuns: db.prepare(
      `SELECT * FROM orch_p_run
       WHERE parent_run_id = ? AND lifecycle NOT IN ('settled', 'failed', 'cancelled', 'interrupted')`
    ),
    listNonTerminalChildRunsBySession: db.prepare(
      `SELECT * FROM orch_p_run
       WHERE session_key = ? AND parent_run_id IS NOT NULL
         AND lifecycle NOT IN ('settled', 'failed', 'cancelled', 'interrupted')`
    )
  }
}

export function mapEventRow(row: Record<string, unknown>): OrchestrationEventRow {
  return {
    seq: Number(row.seq),
    eventId: String(row.event_id),
    at: Number(row.at),
    type: String(row.type) as OrchestrationEventRow['type'],
    stream: String(row.stream),
    sessionKey: (row.session_key as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    commandId: (row.command_id as string | null) ?? null,
    actor: String(row.actor),
    scope: String(row.scope) as OrchestrationScope,
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    evidence: row.evidence ? (JSON.parse(String(row.evidence)) as string[]) : null,
    principal: String(row.principal),
    via: (row.via as string | null) ?? null,
    actorRunId: (row.actor_run_id as string | null) ?? null
  }
}

export function mapOutboxRow(row: Record<string, unknown>): OutboxEffectRow {
  return {
    effectId: String(row.effect_id),
    kind: String(row.kind),
    policy: String(row.policy) as 'process_bound' | 'replayable',
    runId: (row.run_id as string | null) ?? null,
    causationSeq: Number(row.causation_seq),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    state: String(row.state) as OutboxEffectRow['state'],
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    attempts: Number(row.attempts),
    leaseOwner: (row.lease_owner as string | null) ?? null,
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    resultSeq: row.result_seq === null ? null : Number(row.result_seq),
    lastError: (row.last_error as string | null) ?? null
  }
}
