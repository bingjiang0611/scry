import { describe, expect, it } from 'vitest'
import { DDL_V4, DDL_V15, USAGE_ANALYTICS_COSTS_SQL, USAGE_LEDGER_COLS, sqlInsert } from './span-ledger'
import type { UsageLedgerObject } from '../shared/billing'
import type { SQLInputValue } from 'node:sqlite'
import { usageLedgerObjectToRow } from './billing-ledger'

const nodeSqlite = (await import('node:sqlite').catch(() => null)) as typeof import('node:sqlite') | null
const sqliteIt = nodeSqlite ? it : it.skip

const at = (daysAgo: number): number => new Date(2026, 8, 3 - daysAgo, 10).getTime()

// 账单导入的成本行可能完全没有 Token 字段；那不是「报了 0」，不能整行丢掉。
describe('成本查询的 Token 过滤', () => {
  sqliteIt('没有 Token 字段的成本行仍计入成本，明确报全 0 的记录才丢弃', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    try {
      for (const stmt of [...DDL_V4, ...DDL_V15]) db.prepare(stmt).run()
      const insert = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
      const add = (row: UsageLedgerObject): void => { insert.run(...(usageLedgerObjectToRow(row) as SQLInputValue[])) }
      const base: UsageLedgerObject = {
        id: 'cost-only', provider: 'codex', source: 'repair', sourceKind: 'provider_reported',
        sessionId: 'session', runId: null, model: 'model-a', usageKind: 'model',
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
        cost: 0.25, costUnit: 'usd', costSource: 'provider_reported', confidence: 'provider_reported',
        attributionMethod: 'direct', bucketStart: at(0), bucketEnd: at(0), createdTs: at(0)
      }
      add(base)
      add({ ...base, id: 'reported-zero', inputTokens: 0, outputTokens: 0, cost: 0, costSource: 'price_table', confidence: 'estimated' })

      expect(db.prepare(USAGE_ANALYTICS_COSTS_SQL).all(at(2), at(-1))).toEqual([
        expect.objectContaining({ costUsd: 0.25 })
      ])
    } finally {
      db.close()
    }
  })
})
