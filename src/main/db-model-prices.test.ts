import { describe, expect, it } from 'vitest'
import { DDL_V4, DDL_V15 } from './span-ledger'
import { catalogPriceRows, type ModelPrice } from '../shared/model-price'

const nodeSqlite = (await import('node:sqlite').catch(() => null)) as typeof import('node:sqlite') | null
const sqliteIt = nodeSqlite ? it : it.skip

// 生产用 better-sqlite3（Electron ABI，Node 版 vitest 加载不了）；这里用 node:sqlite 跑同一条 SQL，
// 并用 BEGIN IMMEDIATE、提交和回滚模拟本测试用到的 transaction()。
class TestDatabase {
  private readonly db = new nodeSqlite!.DatabaseSync(':memory:')
  prepare(sql: string): ReturnType<typeof this.db.prepare> { return this.db.prepare(sql) }
  exec(sql: string): void { this.db.exec(sql) }
  transaction<A extends unknown[], T>(operation: (...args: A) => T): (...args: A) => T {
    return (...args: A) => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = operation(...args)
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }
  close(): void { this.db.close() }
  asConnection<T>(): T { return this as unknown as T }
}
const version = (id: string, input: number): ModelPrice => ({
  id, provider: 'openai-codex', model: id, currency: 'USD',
  inputPerMillion: input, outputPerMillion: 20, cacheReadPerMillion: null,
  cacheWritePerMillion: null, reasoningPerMillion: null,
  effectiveFrom: 1_700_000_000_000, effectiveTo: null, source: 'pi_model_catalog'
})

// Q6：验证 Pi 模型目录单价的转换、存储和变更检测。
describe('模型目录价格', () => {
  it('只保留有输入与输出单价的模型，并记下每个百万 Token 的美元单价', () => {
    const rows = catalogPriceRows([
      { id: 'model-x', provider: 'openai-codex', cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } },
      { id: 'model-free', provider: 'openai-codex', cost: { input: 0, output: 0 } },
      { id: 'model-partial', provider: 'openai-codex', cost: { input: 1 } },
      { model: 'model-noid', provider: 'openai-codex', cost: { input: 1, output: 2 } }
    ], 1_700_000_000_000)

    expect(rows).toEqual([{
      id: 'pi_model_catalog:openai-codex:model-x',
      provider: 'openai-codex',
      model: 'model-x',
      currency: 'USD',
      inputPerMillion: 4,
      outputPerMillion: 20,
      cacheReadPerMillion: 0.4,
      cacheWritePerMillion: 5,
      reasoningPerMillion: null,
      effectiveFrom: 1_700_000_000_000,
      effectiveTo: null,
      source: 'pi_model_catalog'
    }])
  })
})

describe('价格表写入', () => {
  sqliteIt('同一份目录重复写入只保留一行，金额变化才更新', async () => {
    const db = new TestDatabase()
    try {
      for (const stmt of [...DDL_V4, ...DDL_V15]) db.exec(stmt)
      const { writePrices, currentModelPrices } = await import('./db-model-prices')
      const connection = db.asConnection<Parameters<typeof writePrices>[0]>()
      expect(writePrices(connection, [version('model-x', 4)])).toBe(1)
      expect(writePrices(connection, [version('model-x', 4)])).toBe(1)
      expect(db.prepare('SELECT COUNT(*) n FROM model_price_versions').get()).toEqual({ n: 1 })
      expect(currentModelPrices(connection, 1_700_000_001_000).map((row) => row.inputPerMillion)).toEqual([4])
      writePrices(connection, [version('model-x', 5)])
      expect(db.prepare('SELECT COUNT(*) n FROM model_price_versions').get()).toEqual({ n: 1 })
      expect(currentModelPrices(connection, 1_700_000_001_000).map((row) => row.inputPerMillion)).toEqual([5])
    } finally {
      db.close()
    }
  })
})

describe('价格表跳过重复写入', () => {
  it('单价没变就不写，变了才写', async () => {
    const { changedPrices } = await import('./db-model-prices')
    const existing = [version('model-x', 4)]
    expect(changedPrices(existing, [version('model-x', 4)])).toEqual([])
    expect(changedPrices(existing, [version('model-x', 5)]).map((row) => row.id)).toEqual(['model-x'])
    expect(changedPrices(existing, [version('model-y', 4)]).map((row) => row.id)).toEqual(['model-y'])
  })
})
