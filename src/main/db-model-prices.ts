// model_price_versions 的读写：Pi 模型目录里的单价写进这张表，
// 分析页在读取时用它给没有金额的轮次折算，不改写已有的账本行。
import type Database from 'better-sqlite3'
import { catalogPriceRows, type ModelPrice } from '../shared/model-price'
import { readPiCatalogPrices } from './pi-price-catalog'
import { MODEL_PRICE_VERSION_COLS } from './span-ledger-schema'
import { db, invalidateQueryCaches } from './db-connection'

/** 最近一条价格优先；只保留美元行。 */
export function currentModelPrices(db: Database.Database, nowMs = Date.now()): ModelPrice[] {
  const rows = db.prepare(
    `SELECT id, provider, model, currency,
            input_per_million inputPerMillion, output_per_million outputPerMillion,
            cache_read_per_million cacheReadPerMillion, cache_write_per_million cacheWritePerMillion,
            reasoning_per_million reasoningPerMillion, effective_from effectiveFrom, effective_to effectiveTo,
            source
     FROM model_price_versions WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
     ORDER BY effective_from DESC`
  ).all(nowMs, nowMs) as ModelPrice[]
  return rows.filter((row) => row.currency.toUpperCase() === 'USD')
}

/** 幂等写入：id 由来源与模型决定，同名价格只更新，不重复插入。 */
export function writePrices(connection: Database.Database, rows: readonly ModelPrice[]): number {
  if (rows.length === 0) return 0
  const insert = connection.prepare(`INSERT OR REPLACE INTO model_price_versions (${MODEL_PRICE_VERSION_COLS.join(', ')})
    VALUES (${MODEL_PRICE_VERSION_COLS.map(() => '?').join(', ')})`)
  const write = connection.transaction((items: readonly ModelPrice[]) => {
    for (const row of items) {
      insert.run(row.id, row.provider, row.model, row.currency,
        row.inputPerMillion ?? null, row.outputPerMillion ?? null,
        row.cacheReadPerMillion ?? null, row.cacheWritePerMillion ?? null,
        row.reasoningPerMillion ?? null, row.effectiveFrom, row.effectiveTo ?? null,
        row.source ?? 'pi_model_catalog', null)
    }
  })
  write(rows)
  return rows.length
}

/** 只有单价真的变了才写；打开模型选择器会反复带同一份目录进来。 */
export function changedPrices(existing: readonly ModelPrice[], incoming: readonly ModelPrice[]): ModelPrice[] {
  const byId = new Map(existing.map((row) => [row.id, row]))
  return incoming.filter((row) => {
    const previous = byId.get(row.id)
    return !previous || previous.currency !== row.currency ||
      previous.inputPerMillion !== row.inputPerMillion || previous.outputPerMillion !== row.outputPerMillion ||
      previous.cacheReadPerMillion !== row.cacheReadPerMillion || previous.cacheWritePerMillion !== row.cacheWritePerMillion ||
      previous.reasoningPerMillion !== row.reasoningPerMillion
  })
}

/** 目录读取是只读操作；记录价格失败只影响估算，不能让读取失败。 */
export function rememberCatalogPrices(prices: readonly ModelPrice[] | undefined): void {
  if (!prices?.length) return
  try {
    if (!db) return
    if (writePrices(db, changedPrices(currentModelPrices(db), prices)) > 0) invalidateQueryCaches()
  } catch (error) {
    console.warn('[scry] 模型目录价格未记录:', (error as Error)?.message)
  }
}

/** 启动时把本机 Pi 目录里的单价只读地记进价格表；历史轮次不必先跑一轮才有金额。 */
export function rememberPiCatalogPrices(homeDir: string): void {
  rememberCatalogPrices(readPiCatalogPrices(homeDir))
}

export { catalogPriceRows }
