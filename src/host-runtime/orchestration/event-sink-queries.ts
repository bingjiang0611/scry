import type Database from 'better-sqlite3'
import type { DelegationLimits } from './delegation-limits'
import { mapEventRow, mapOutboxRow, type EventSinkStatements } from './event-sink-statements'
import type { NativeSessionIdentity } from './native-session-lookup'
import type { OrchestratorReadView } from './orchestrator-handlers'
import { mapInteractionRow, mapReceiptRow, mapRunRow, mapSessionRow, mapTaskRow, mapTurnRow } from './projection'
import type {
  CommandReceiptRow,
  InteractionProjectionRow,
  OrchestrationEventRow,
  OutboxEffectRow,
  RunProjectionRow,
  SessionProjectionRow,
  TaskProjectionRow,
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

export function readTaskRaw(stmts: EventSinkStatements, taskId: string): TaskProjectionRow | undefined {
  const row = stmts.readTask.get(taskId) as Record<string, unknown> | undefined
  return row ? mapTaskRow(row) : undefined
}

export function listTasksByParentRunRaw(stmts: EventSinkStatements, parentRunId: string): TaskProjectionRow[] {
  const rows = stmts.listTasksByParentRun.all(parentRunId) as Array<Record<string, unknown>>
  return rows.map(mapTaskRow)
}

export function listTasksByParentSessionRaw(stmts: EventSinkStatements, sessionKey: string): TaskProjectionRow[] {
  const rows = stmts.listTasksByParentSession.all(sessionKey) as Array<Record<string, unknown>>
  return rows.map(mapTaskRow)
}

export function readDelegationPolicyEnabledRaw(
  stmts: EventSinkStatements,
  scopeKind: 'project' | 'session',
  scopeKey: string
): boolean {
  const row = stmts.readDelegationPolicy.get(scopeKind, scopeKey) as { enabled: number } | undefined
  return Number(row?.enabled ?? 0) === 1
}

export function buildOrchestratorReadView(
  stmts: EventSinkStatements,
  deps: {
    authorizedActors: ReadonlySet<string>
    maxActiveRuns: number
    delegationLimits: DelegationLimits
    isProviderAuthenticating: (provider: string, profile: string | null) => boolean
    getNativeSession: (identity: NativeSessionIdentity) => SessionProjectionRow | undefined
  }
): OrchestratorReadView {
  return {
    isActorAuthorized: (actor) => actor.startsWith('effect:') || deps.authorizedActors.has(actor),
    getReceipt: (commandId, actor) => readReceiptRaw(stmts, commandId, actor),
    getRun: (runId) => readRunRaw(stmts, runId),
    getSession: (sessionKey) => readSessionRaw(stmts, sessionKey),
    getNativeSession: deps.getNativeSession,
    getTurnByRunId: (runId) => readTurnByRunIdRaw(stmts, runId),
    getNextTurnOrdinal: (sessionKey) => readNextTurnOrdinalRaw(stmts, sessionKey),
    getInteraction: (runId, questionId) => readInteractionRaw(stmts, runId, questionId),
    listNonTerminalChildRuns: (parentRunId) => listNonTerminalChildRunsRaw(stmts, parentRunId),
    listNonTerminalChildRunsBySession: (sessionKey) => listNonTerminalChildRunsBySessionRaw(stmts, sessionKey),
    hasActiveRunForSession: (sessionKey) => Boolean(stmts.hasActiveSessionRun.get(sessionKey)),
    activeRunCount: () => (stmts.activeRunCount.get() as { count: number }).count,
    maxActiveRuns: () => deps.maxActiveRuns,
    isProviderAuthenticating: deps.isProviderAuthenticating,
    getTask: (taskId) => readTaskRaw(stmts, taskId),
    listTasksByParentRun: (parentRunId) => listTasksByParentRunRaw(stmts, parentRunId),
    listTasksByParentSession: (sessionKey) => listTasksByParentSessionRaw(stmts, sessionKey),
    countNonTerminalTasksByParentRun: (parentRunId) =>
      (stmts.countNonTerminalTasksByParentRun.get(parentRunId) as { count: number }).count,
    countTotalTasksByParentRun: (parentRunId) =>
      (stmts.countTotalTasksByParentRun.get(parentRunId) as { count: number }).count,
    countNonTerminalTasksBySession: (sessionKey) =>
      (stmts.countNonTerminalTasksBySession.get(sessionKey) as { count: number }).count,
    countNonTerminalAgentRuns: () =>
      (stmts.countNonTerminalAgentRuns.get() as { count: number }).count,
    isProjectDelegationEnabled: (cwd) => readDelegationPolicyEnabledRaw(stmts, 'project', cwd),
    isSessionFullAccessEnabled: (sessionKey) => readDelegationPolicyEnabledRaw(stmts, 'session', sessionKey),
    delegationLimits: () => deps.delegationLimits
  }
}
