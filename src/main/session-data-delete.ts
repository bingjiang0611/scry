import type { ProviderId } from '../shared/provider'
import { scrySessionId } from './session-id'

interface DeleteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint }
}

export interface SessionDeleteDatabase {
  prepare(sql: string): DeleteStatement
  transaction<T>(operation: () => T): () => T
}

export interface SessionDataDeleteResult {
  runIds: string[]
  deletedRows: number
}

export interface SessionRunIdResolution {
  runIds: string[]
  databaseRunIds: string[]
  conflicts: string[]
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function changes(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

const DELETE_BATCH_SIZE = 500

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += DELETE_BATCH_SIZE) {
    result.push(values.slice(offset, offset + DELETE_BATCH_SIZE))
  }
  return result
}

export function resolveSessionDataRunIds(
  db: SessionDeleteDatabase,
  args: {
    providerId: ProviderId
    cwd: string
    externalSessionId: string
    runIds?: Iterable<string>
  }
): SessionRunIdResolution {
  const internalSessionId = scrySessionId(args.providerId, args.cwd, args.externalSessionId)
  const discovered = new Set<string>()
  const spanIdentitySql = args.providerId === 'claude'
    ? '(session_id = ? OR (session_id = ? AND cwd = ?))'
    : 'session_id = ?'
  const spanIdentityParams = args.providerId === 'claude'
    ? [internalSessionId, args.externalSessionId, args.cwd]
    : [internalSessionId]
  const usageIdentitySql = args.providerId === 'claude'
    ? '(session_id = ? OR (session_id = ? AND project_key = ?))'
    : 'session_id = ?'
  const usageIdentityParams = args.providerId === 'claude'
    ? [internalSessionId, args.externalSessionId, args.cwd]
    : [internalSessionId]
  for (const row of db.prepare(`SELECT DISTINCT run_id runId FROM spans WHERE ${spanIdentitySql} AND run_id IS NOT NULL`).all(...spanIdentityParams) as Array<{ runId?: string }>) {
    if (row.runId) discovered.add(row.runId)
  }
  for (const row of db.prepare(`SELECT DISTINCT run_id runId FROM usage_ledger WHERE ${usageIdentitySql} AND run_id IS NOT NULL`).all(...usageIdentityParams) as Array<{ runId?: string }>) {
    if (row.runId) discovered.add(row.runId)
  }
  if (args.providerId === 'claude') {
    for (const row of db.prepare('SELECT DISTINCT run_id runId FROM turns WHERE session_id = ? AND cwd = ? AND run_id IS NOT NULL').all(args.externalSessionId, args.cwd) as Array<{ runId?: string }>) {
      if (row.runId) discovered.add(row.runId)
    }
  }

  const candidates = new Set([...discovered, ...(args.runIds ?? [])])
  const allowed: string[] = []
  const databaseRunIds: string[] = []
  const conflicts: string[] = []
  const spanConflict = db.prepare(`SELECT 1 found FROM spans WHERE run_id = ? AND NOT ${spanIdentitySql} LIMIT 1`)
  const usageConflict = db.prepare(`SELECT 1 found FROM usage_ledger WHERE run_id = ? AND session_id IS NOT NULL AND NOT ${usageIdentitySql} LIMIT 1`)
  const turnConflict = args.providerId === 'claude'
    ? db.prepare('SELECT 1 found FROM turns WHERE run_id = ? AND (session_id IS NOT ? OR cwd IS NOT ?) LIMIT 1')
    : db.prepare('SELECT 1 found FROM turns WHERE run_id = ? LIMIT 1')
  for (const runId of candidates) {
    if (!runId) continue
    const hasConflict =
      spanConflict.get(runId, ...spanIdentityParams) != null ||
      usageConflict.get(runId, ...usageIdentityParams) != null ||
      (args.providerId === 'claude'
        ? turnConflict.get(runId, args.externalSessionId, args.cwd) != null
        : turnConflict.get(runId) != null)
    if (hasConflict) {
      conflicts.push(runId)
      continue
    }
    allowed.push(runId)
    if (discovered.has(runId)) databaseRunIds.push(runId)
  }
  return { runIds: allowed, databaseRunIds, conflicts }
}

export function deleteSessionDataRows(
  db: SessionDeleteDatabase,
  args: {
    providerId: ProviderId
    cwd: string
    externalSessionId: string
    runIds?: Iterable<string>
  }
): SessionDataDeleteResult {
  const internalSessionId = scrySessionId(args.providerId, args.cwd, args.externalSessionId)
  const resolution = resolveSessionDataRunIds(db, args)
  const ids = resolution.databaseRunIds
  const spanIdentitySql = args.providerId === 'claude'
    ? '(session_id = ? OR (session_id = ? AND cwd = ?))'
    : 'session_id = ?'
  const spanIdentityParams = args.providerId === 'claude'
    ? [internalSessionId, args.externalSessionId, args.cwd]
    : [internalSessionId]
  const usageIdentitySql = args.providerId === 'claude'
    ? '(session_id = ? OR (session_id = ? AND project_key = ?))'
    : 'session_id = ?'
  const usageIdentityParams = args.providerId === 'claude'
    ? [internalSessionId, args.externalSessionId, args.cwd]
    : [internalSessionId]
  const spanIds = new Set(
    (db.prepare(`SELECT id FROM spans WHERE ${spanIdentitySql}`).all(...spanIdentityParams) as Array<{ id: string }>)
      .map((row) => row.id)
  )
  for (const batch of batches(ids)) {
    for (const row of db.prepare(`SELECT id FROM spans WHERE run_id IN (${placeholders(batch)})`).all(...batch) as Array<{ id: string }>) {
      spanIds.add(row.id)
    }
  }
  const targetSpanIds = [...spanIds]
  const turnRows = args.providerId === 'claude'
    ? db.prepare('SELECT id FROM turns WHERE session_id = ? AND cwd = ?').all(args.externalSessionId, args.cwd) as Array<{ id: number }>
    : []
  const turnIds = turnRows.map((row) => row.id)

  let deletedRows = 0
  db.transaction(() => {
    for (const batch of batches(turnIds)) {
      deletedRows += changes(db.prepare(`DELETE FROM tool_calls WHERE turn_id IN (${placeholders(batch)})`).run(...batch).changes)
    }
    for (const batch of batches(targetSpanIds)) {
      deletedRows += changes(db.prepare(`DELETE FROM model_usage WHERE span_id IN (${placeholders(batch)})`).run(...batch).changes)
    }
    deletedRows += changes(db.prepare('DELETE FROM file_ops WHERE session_id = ?').run(internalSessionId).changes)
    for (const batch of batches(targetSpanIds)) {
      deletedRows += changes(db.prepare(`DELETE FROM file_ops WHERE span_id IN (${placeholders(batch)})`).run(...batch).changes)
    }
    deletedRows += changes(db.prepare(`DELETE FROM usage_ledger WHERE ${usageIdentitySql}`).run(...usageIdentityParams).changes)
    for (const batch of batches(ids)) {
      deletedRows += changes(db.prepare(`DELETE FROM usage_ledger WHERE run_id IN (${placeholders(batch)})`).run(...batch).changes)
    }
    for (const batch of batches(targetSpanIds)) {
      deletedRows += changes(db.prepare(`DELETE FROM usage_ledger WHERE span_id IN (${placeholders(batch)})`).run(...batch).changes)
    }
    deletedRows += changes(db.prepare(`DELETE FROM spans WHERE ${spanIdentitySql}`).run(...spanIdentityParams).changes)
    for (const batch of batches(ids)) {
      deletedRows += changes(db.prepare(`DELETE FROM spans WHERE run_id IN (${placeholders(batch)})`).run(...batch).changes)
    }
    if (args.providerId === 'claude') {
      deletedRows += changes(db.prepare('DELETE FROM turns WHERE session_id = ? AND cwd = ?').run(args.externalSessionId, args.cwd).changes)
      deletedRows += changes(db.prepare('DELETE FROM sessions WHERE session_id = ? AND cwd = ?').run(args.externalSessionId, args.cwd).changes)
    }
    deletedRows += changes(db.prepare('DELETE FROM session_refs WHERE scry_session_id = ?').run(internalSessionId).changes)
    const remaining = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM spans WHERE cwd = ?) +
         (SELECT COUNT(*) FROM session_refs WHERE cwd = ?) +
         (SELECT COUNT(*) FROM turns WHERE cwd = ?) n`
    ).get(args.cwd, args.cwd, args.cwd) as { n: number }
    if (Number(remaining.n) === 0) {
      deletedRows += changes(db.prepare('DELETE FROM projects WHERE cwd = ?').run(args.cwd).changes)
    }
  })()
  return { runIds: resolution.runIds, deletedRows }
}
