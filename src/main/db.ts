// P0（RFC v2.4）：可信数据底座的 electron 胶水层。schema/行映射/查询 SQL 在纯模块 span-ledger.ts，
// 本文件只负责 electron 路径解析 + 预编译语句执行 + 迁移闸控。WAL + user_version 增量迁移。
// 原生模块，打包要 asarUnpack。加载失败（EDR/ABI）整体降级 no-op，不连累 app 启动。
import { protectToolContent } from '../core/turn-recorder/content-policy.js'
import type { ToolContentPolicy } from '../core/turn-recorder/tool-content.js'
import { app } from 'electron'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type { TraceEvent } from '../shared/trace'
import {
  SPAN_COLS,
  MODEL_USAGE_COLS,
  DELETE_MODEL_USAGE_FOR_SPAN_SQL,
  FILE_OP_COLS,
  HUMAN_INTERVENTION_COLS,
  USAGE_LEDGER_COLS,
  UPSERT_SESSION_REF_SQL,
  sqlInsert,
  spanRowsFromItems
} from './span-ledger'
import { migrateDatabase } from './db-migrations'
import { billingRowsFromItems, type LocalModelPriceVersion } from './billing-ledger'
import type { BillingProvider } from '../shared/billing'
import type { RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import { scrySessionId } from './session-id'
import { deleteSessionDataRows, resolveSessionDataRunIds, type SessionDeleteDatabase } from './session-data-delete'

import { billingEnvProvider, db, dbFilePath, gatewayAccountLabel, invalidateQueryCaches, setDb, setDbFilePath } from './db-state'

const require = createRequire(import.meta.url)

export interface RecordTurnArgs {
  toolContentPolicy?: ToolContentPolicy
  runId: string
  sessionId?: string
  cwd?: string
  userText: string
  items: TraceEvent[]
  runtimeProvider?: RuntimeProvider
  providerId?: ProviderId
  billingProvider?: BillingProvider
}

const turnOutboxDir = (userDataDir = app.getPath('userData')): string => join(userDataDir, 'db-turn-outbox')
const turnOutboxPath = (runId: string): string => join(
  turnOutboxDir(),
  `${createHash('sha256').update(runId).digest('hex')}.json`
)

function queueTurnForDatabase(args: RecordTurnArgs): void {
  const dir = turnOutboxDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = turnOutboxPath(args.runId)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(args)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, target)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* temporary may already be renamed */ }
    throw error
  }
}

interface TurnOutboxSessionIdentity {
  providerId: ProviderId
  cwd: string
  externalSessionId: string
}

interface TurnOutboxScan {
  entries: Array<{ path: string; args: RecordTurnArgs }>
  invalid: string[]
  failed: Array<{ path: string; error: string }>
}

function scanTurnOutbox(userDataDir: string): TurnOutboxScan {
  const dir = turnOutboxDir(userDataDir)
  const scan: TurnOutboxScan = { entries: [], invalid: [], failed: [] }
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      scan.failed.push({ path: dir, error: error instanceof Error ? error.message : String(error) })
    }
    return scan
  }
  for (const name of names) {
    const path = join(dir, name)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      scan.failed.push({ path, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    try {
      const args = JSON.parse(raw) as RecordTurnArgs
      if (args.runId && Array.isArray(args.items)) scan.entries.push({ path, args })
      else scan.invalid.push(path)
    } catch {
      scan.invalid.push(path)
    }
  }
  return scan
}

function outboxBelongsToSession(args: RecordTurnArgs, identity: TurnOutboxSessionIdentity): boolean {
  return args.providerId === identity.providerId && args.cwd === identity.cwd && args.sessionId === identity.externalSessionId
}

export function turnOutboxSessionRunIds(
  userDataDir: string,
  identity: TurnOutboxSessionIdentity
): string[] {
  return scanTurnOutbox(userDataDir).entries
    .filter((entry) => outboxBelongsToSession(entry.args, identity))
    .map((entry) => entry.args.runId)
}

export function deleteTurnOutboxSessionRows(
  userDataDir: string,
  identity: TurnOutboxSessionIdentity,
  runIds: ReadonlySet<string>
): { failed: Array<{ path: string; error: string }>; preservedInvalid: number } {
  const scan = scanTurnOutbox(userDataDir)
  const failed = [...scan.failed]
  for (const entry of scan.entries) {
    if (!runIds.has(entry.args.runId) || !outboxBelongsToSession(entry.args, identity)) continue
    try {
      unlinkSync(entry.path)
    } catch (error) {
      failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { failed, preservedInvalid: scan.invalid.length }
}

export async function replayDatabaseTurnOutbox(options: {
  batchSize?: number
  yieldControl?: () => Promise<void>
  persist?: (args: RecordTurnArgs) => boolean
} = {}): Promise<void> {
  const persist = options.persist ?? (db ? (args: RecordTurnArgs) => recordTurn(args, { queueOnFailure: false }) : null)
  if (!persist) return
  let names: string[]
  try { names = readdirSync(turnOutboxDir()).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort() } catch { return }
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 25))
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    const path = join(turnOutboxDir(), name)
    try {
      const args = JSON.parse(readFileSync(path, 'utf8')) as RecordTurnArgs
      if (args.runId && Array.isArray(args.items) && persist(args)) unlinkSync(path)
    } catch (error) {
      console.warn('[scry] database turn outbox replay failed:', name, (error as Error)?.message)
    }
    if ((index + 1) % batchSize === 0 && index + 1 < names.length) await yieldControl()
  }
}

export function initDb(): void {
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const filePath = join(app.getPath('userData'), 'scry.db')
    setDbFilePath(filePath)
    const openedDb = new Database(filePath)
    setDb(openedDb)
    chmodSync(filePath, 0o600)
    openedDb.pragma('journal_mode = WAL')
    openedDb.pragma('secure_delete = ON')
    migrateDatabase(openedDb)
    for (const file of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600)
    }
    invalidateQueryCaches()
  } catch (e) {
    try { db?.close() } catch { /* retain the original initialization error */ }
    setDb(null) // 降级：sqlite 不可用就不写不查，app 照常跑
    console.warn('[scry] sqlite 初始化失败，观测分析降级:', (e as Error)?.message)
  }
}

export function deleteSessionData(args: {
  providerId: ProviderId
  cwd: string
  externalSessionId: string
  runIds: Iterable<string>
}): { status: 'deleted' | 'not_present' | 'unavailable'; runIds: string[]; deletedRows: number; error?: string } {
  if (!db) {
    const file = dbFilePath ?? join(app.getPath('userData'), 'scry.db')
    return existsSync(file)
      ? { status: 'unavailable', runIds: [...args.runIds], deletedRows: 0, error: 'SQLite 当前不可用，无法确认会话数据已清除' }
      : { status: 'not_present', runIds: [...args.runIds], deletedRows: 0 }
  }
  try {
    const result = deleteSessionDataRows(db as unknown as SessionDeleteDatabase, args)
    if (result.deletedRows > 0) invalidateQueryCaches()
    return { status: 'deleted', ...result }
  } catch (error) {
    return {
      status: 'unavailable',
      runIds: [...args.runIds],
      deletedRows: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function resolveSessionRunIds(args: {
  providerId: ProviderId
  cwd: string
  externalSessionId: string
  runIds: Iterable<string>
}): { status: 'ready' | 'not_present' | 'unavailable'; runIds: string[]; conflicts: string[]; error?: string } {
  if (!db) {
    const file = dbFilePath ?? join(app.getPath('userData'), 'scry.db')
    return existsSync(file)
      ? { status: 'unavailable', runIds: [], conflicts: [], error: 'SQLite 当前不可用，无法校验会话 runId 归属' }
      : { status: 'not_present', runIds: [...args.runIds], conflicts: [] }
  }
  try {
    const resolution = resolveSessionDataRunIds(db as unknown as SessionDeleteDatabase, args)
    return { status: 'ready', runIds: resolution.runIds, conflicts: resolution.conflicts }
  } catch (error) {
    return { status: 'unavailable', runIds: [], conflicts: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export function recordTurn(args: RecordTurnArgs, options: { queueOnFailure?: boolean } = {}): boolean {
  try {
    let previous: RecordTurnArgs | undefined
    try { previous = JSON.parse(readFileSync(turnOutboxPath(args.runId), 'utf8')) as RecordTurnArgs } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    const policy = previous?.runId === args.runId && previous.cwd === args.cwd ? previous.toolContentPolicy : undefined
    args = protectToolContent({ ...args, ...(policy ? { toolContentPolicy: policy } : {}) }, args.cwd ?? '')
  } catch { return false }
  if (!db) {
    if (options.queueOnFailure !== false) queueTurnForDatabase(args)
    return false
  }
  try {
    const ts = Date.now()
    const cwd = args.cwd ?? ''
    const internalSessionId = args.sessionId && args.providerId
      ? scrySessionId(args.providerId, cwd, args.sessionId)
      : undefined
    const rows = spanRowsFromItems({ runId: args.runId, sessionId: internalSessionId, cwd, items: args.items, nowMs: ts })
    const gatewayLabel = gatewayAccountLabel(billingEnvProvider())
    const priceVersions = db.prepare(
      `SELECT id, provider, model, currency,
              input_per_million inputPerMillion, output_per_million outputPerMillion,
              cache_read_per_million cacheReadPerMillion, cache_write_per_million cacheWritePerMillion,
              reasoning_per_million reasoningPerMillion, effective_from effectiveFrom, effective_to effectiveTo
       FROM model_price_versions WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)`
    ).all(ts, ts) as LocalModelPriceVersion[]
    const billing = billingRowsFromItems({
      runId: args.runId,
      sessionId: internalSessionId,
      cwd,
      items: args.items,
      nowMs: ts,
      runtimeProvider: args.runtimeProvider,
      billingProvider: args.billingProvider,
      gateway: gatewayLabel ? { provider: 'anthropic', accountLabel: gatewayLabel } : null,
      priceVersions
    })
    const insSpan = db.prepare(sqlInsert('spans', SPAN_COLS))
    const deleteMu = db.prepare(DELETE_MODEL_USAGE_FOR_SPAN_SQL)
    const insMu = db.prepare(sqlInsert('model_usage', MODEL_USAGE_COLS))
    const insFo = db.prepare(
      `INSERT OR IGNORE INTO file_ops (${FILE_OP_COLS.join(', ')}) VALUES (${FILE_OP_COLS.map(() => '?').join(', ')})`
    )
    const insIntervention = db.prepare(sqlInsert('human_interventions', HUMAN_INTERVENTION_COLS))
    const insLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
    const deleteReconstructed = db.prepare("DELETE FROM usage_ledger WHERE span_id=? AND source='scry_persisted_usage'")
    const ledgerSpanIndex = USAGE_LEDGER_COLS.indexOf('span_id')
    const tx = db.transaction(() => {
      db!.prepare(
        `INSERT INTO projects (cwd, name, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET last_seen_at = excluded.last_seen_at`
      ).run(cwd, cwd ? basename(cwd) : 'Chats', ts)
      if (internalSessionId && args.sessionId && args.providerId && args.runtimeProvider) {
        db!.prepare(UPSERT_SESSION_REF_SQL).run(
          internalSessionId,
          args.providerId,
          args.runtimeProvider,
          cwd,
          args.sessionId,
          args.userText.slice(0, 200),
          ts,
          ts
        )
      }
      for (const r of rows.spans) insSpan.run(...(r as never[]))
      for (const spanId of new Set(rows.modelUsage.map((row) => row[0]))) deleteMu.run(spanId)
      for (const r of rows.modelUsage) insMu.run(...(r as never[]))
      for (const r of rows.fileOps) insFo.run(...(r as never[]))
      for (const r of rows.interventions) insIntervention.run(...(r as never[]))
      // A later canonical replay supersedes reconstruction for that exact result.
      // In particular, do not retain an unknown aggregate beside new model rows.
      for (const spanId of new Set(billing.usageLedger.map((row) => row[ledgerSpanIndex]))) {
        if (spanId) deleteReconstructed.run(spanId)
      }
      for (const r of billing.usageLedger) insLedger.run(...(r as never[]))
    })
    tx()
    invalidateQueryCaches()
    return true
  } catch (e) {
    console.warn('[scry] recordTurn 失败:', (e as Error)?.message)
    if (options.queueOnFailure !== false) {
      try { queueTurnForDatabase(args) } catch (queueError) {
        console.error('[scry] database turn outbox write failed:', (queueError as Error)?.message)
      }
    }
    return false
  }
}

export { setBillingEnvProvider } from './db-state'
export { billingStateQuery } from './db-billing-state'
export { UPSERT_BILLING_SYNC_STATE_SQL, syncBillingAdmin, importBillingFixture } from './db-billing-sync'
export { statsQuery, usageAnalyticsWithCreditsQuery, usageAnalyticsQuery } from './db-analytics'
