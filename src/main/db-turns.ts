// Writing a turn into SQLite, plus the session-scoped deletes and ownership reads
// that share its tables. Caches and the connection live in db-connection.ts.
// P0（RFC v2.4）：可信数据底座的 electron 胶水层。schema/行映射/查询 SQL 在纯模块 span-ledger.ts，
// 本文件只负责 electron 路径解析 + 预编译语句执行 + 迁移闸控。WAL + user_version 增量迁移。
// 原生模块，打包要 asarUnpack。加载失败（EDR/ABI）整体降级 no-op，不连累 app 启动。
import { protectToolContent } from '../core/turn-recorder/content-policy.js'
import { basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { SPAN_COLS, MODEL_USAGE_COLS, DELETE_MODEL_USAGE_FOR_SPAN_SQL, FILE_OP_COLS, HUMAN_INTERVENTION_COLS, USAGE_LEDGER_COLS, UPSERT_SESSION_REF_SQL, sqlInsert, spanRowsFromItems } from './span-ledger'
import { billingRowsFromItems, type LocalModelPriceVersion } from './billing-ledger'
import { scrySessionId } from './session-id'
import { billingEnvProvider, db, invalidateQueryCaches } from './db-connection'
import { queueTurnForDatabase, turnOutboxPath } from './db-outbox'
import type { RecordTurnArgs } from './db-types'
import { gatewayAccountLabel } from './db-billing-state'

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
