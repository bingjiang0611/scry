import type Database from 'better-sqlite3'
import { mapEventRow, mapOutboxRow, type EventSinkStatements } from './event-sink-statements'
import { mapInteractionRow, mapReceiptRow, mapRunRow, mapSessionRow, mapTurnRow } from './projection'
import type {
  CommandReceiptRow,
  InteractionProjectionRow,
  OrchestrationEventRow,
  OutboxEffectRow,
  RunProjectionRow,
  SessionProjectionRow,
  TurnProjectionRow
} from './types'

export function readReceiptRaw(stmts: EventSinkStatements, commandId: string, actor: string): CommandReceiptRow | undefined {
  const row = stmts.readReceipt.get(commandId, actor) as Record<string, unknown> | undefined
  return row ? mapReceiptRow(row) : undefined
}

export function readRunRaw(stmts: EventSinkStatements, runId: string): RunProjectionRow | undefined {
  const row = stmts.readRun.get(runId) as Record<string, unknown> | undefined
  return row ? mapRunRow(row) : undefined
}

export function readSessionRaw(stmts: EventSinkStatements, sessionKey: string): SessionProjectionRow | undefined {
  const row = stmts.readSession.get(sessionKey) as Record<string, unknown> | undefined
  return row ? mapSessionRow(row) : undefined
}

export function readTurnRaw(db: Database.Database, sessionKey: string, ordinal: number): TurnProjectionRow | undefined {
  const row = db
    .prepare('SELECT * FROM orch_p_turn WHERE session_key = ? AND ordinal = ?')
    .get(sessionKey, ordinal) as Record<string, unknown> | undefined
  return row ? mapTurnRow(row) : undefined
}

export function readTurnByRunIdRaw(stmts: EventSinkStatements, runId: string): TurnProjectionRow | undefined {
  const row = stmts.readTurnByRunId.get(runId) as Record<string, unknown> | undefined
  return row ? mapTurnRow(row) : undefined
}

export function readTurnByOrdinalRaw(
  stmts: EventSinkStatements,
  sessionKey: string,
  ordinal: number
): TurnProjectionRow | undefined {
  const row = stmts.readTurnByOrdinal.get(sessionKey, ordinal) as Record<string, unknown> | undefined
  return row ? mapTurnRow(row) : undefined
}

export function readNextTurnOrdinalRaw(stmts: EventSinkStatements, sessionKey: string): number {
  const row = stmts.nextOrdinal.get(sessionKey) as { next_ordinal: number }
  return Number(row.next_ordinal)
}

export function readInteractionRaw(
  stmts: EventSinkStatements,
  runId: string,
  questionId: string
): InteractionProjectionRow | undefined {
  const row = stmts.readInteraction.get(runId, questionId) as Record<string, unknown> | undefined
  return row ? mapInteractionRow(row) : undefined
}

export function listNonTerminalChildRunsRaw(stmts: EventSinkStatements, parentRunId: string): RunProjectionRow[] {
  const rows = stmts.listNonTerminalChildRuns.all(parentRunId) as Array<Record<string, unknown>>
  return rows.map(mapRunRow)
}

export function listNonTerminalChildRunsBySessionRaw(stmts: EventSinkStatements, sessionKey: string): RunProjectionRow[] {
  const rows = stmts.listNonTerminalChildRunsBySession.all(sessionKey) as Array<Record<string, unknown>>
  return rows.map(mapRunRow)
}

export function listAllEventsRaw(db: Database.Database): OrchestrationEventRow[] {
  const rows = db.prepare('SELECT * FROM orch_event ORDER BY seq ASC').all() as Array<Record<string, unknown>>
  return rows.map(mapEventRow)
}

export function listAllOutboxRaw(db: Database.Database): OutboxEffectRow[] {
  const rows = db
    .prepare('SELECT * FROM orch_outbox ORDER BY causation_seq ASC, effect_id ASC')
    .all() as Array<Record<string, unknown>>
  return rows.map(mapOutboxRow)
}

/** D1: the session's queued runs in release order: held ones last, then by position. */
export function listQueuedRunsRaw(stmts: EventSinkStatements, sessionKey: string): RunProjectionRow[] {
  const rows = stmts.listQueuedRuns.all(sessionKey) as Array<Record<string, unknown>>
  return rows.map(mapRunRow)
}
