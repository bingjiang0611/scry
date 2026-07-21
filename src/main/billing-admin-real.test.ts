// P1 真实 Admin 对账验证。默认跳过，只有显式打开时才会调用官方 Admin API。
// 运行示例：
//   BILLING_ADMIN_REAL=1 OPENAI_ADMIN_API_KEY=... npm test -- src/main/billing-admin-real.test.ts
//   BILLING_ADMIN_REAL=1 ANTHROPIC_ADMIN_API_KEY=... npm test -- src/main/billing-admin-real.test.ts
// 本测试不打印、不落盘、不快照 key；只把官方响应写入临时内存 SQLite，验证 raw usage、usage_ledger、
// SDK estimate 与官方来源 reconciliation 路径都能跑通。
import { describe, expect, it } from 'vitest'
import { fetchAnthropicAdminUsageAndCosts, fetchOpenAiAdminUsageAndCosts } from './billing-admin'
import { billingRowsFromItems, reconcileUsageLedger } from './billing-ledger'
import {
  DDL_V1,
  DDL_V2,
  DDL_V3,
  DDL_V4,
  PROVIDER_RAW_USAGE_COLS,
  USAGE_LEDGER_COLS,
  sqlInsert
} from './span-ledger'
import type { UsageLedgerObject } from '../shared/billing'
import type { TraceEvent } from '../shared/trace'

const RUN = process.env.BILLING_ADMIN_REAL === '1'

type Stmt = { run: (...p: unknown[]) => unknown; get: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] }
type Db = { prepare: (s: string) => Stmt; close: () => void }

function resultEvent(provider: 'anthropic' | 'openai'): TraceEvent {
  return {
    id: `sdk-${provider}-result`,
    ts: new Date().toISOString(),
    runId: `sdk-${provider}`,
    kind: 'harness',
    stage: 'result',
    costUsd: 0.01,
    tokensIn: 100,
    tokensOut: 20,
    modelUsage: [
      {
        model: provider === 'anthropic' ? 'claude-opus-4-1m' : 'gpt-5',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.01,
        costSource: 'sdk_estimate',
        costConfidence: 'estimated',
        costUnit: 'usd'
      }
    ]
  } as TraceEvent
}

function rowToLedger(row: Record<string, unknown>): UsageLedgerObject {
  return {
    id: String(row.id),
    provider: row.provider as UsageLedgerObject['provider'],
    source: String(row.source),
    sourceKind: row.source_kind as UsageLedgerObject['sourceKind'],
    sessionId: row.session_id as string | null,
    runId: row.run_id as string | null,
    spanId: row.span_id as string | null,
    projectKey: row.project_key as string | null,
    accountLabel: row.account_label as string | null,
    bucketStart: row.bucket_start as number | null,
    bucketEnd: row.bucket_end as number | null,
    model: row.model as string | null,
    usageKind: String(row.usage_kind),
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
    cacheReadTokens: row.cache_read_tokens as number | null,
    cacheWriteTokens: row.cache_write_tokens as number | null,
    reasoningTokens: row.reasoning_tokens as number | null,
    toolTokens: row.tool_tokens as number | null,
    requestCount: row.request_count as number | null,
    cost: row.cost as number | null,
    currency: row.currency as string | null,
    costUnit: row.cost_unit as UsageLedgerObject['costUnit'],
    costSource: row.cost_source as UsageLedgerObject['costSource'],
    confidence: row.confidence as UsageLedgerObject['confidence'],
    attributionMethod: row.attribution_method as UsageLedgerObject['attributionMethod'],
    rawUsageId: row.raw_usage_id as string | null,
    priceVersionId: row.price_version_id as string | null,
    createdTs: row.created_ts as number
  }
}

;(RUN ? describe : describe.skip)('P1 real Admin billing reconciliation', () => {
  it(
    '真实 Admin usage/cost 拉取 → provider_raw_usage → usage_ledger → reconciliation',
    async () => {
      const now = Date.now()
      const start = now - 7 * 24 * 60 * 60 * 1000
      const provider = process.env.OPENAI_ADMIN_API_KEY ? 'openai' : 'anthropic'
      const admin = process.env.OPENAI_ADMIN_API_KEY
        ? await fetchOpenAiAdminUsageAndCosts({
            apiKey: process.env.OPENAI_ADMIN_API_KEY,
            startTime: Math.floor(start / 1000),
            endTime: Math.floor(now / 1000),
            nowMs: now
          })
        : process.env.ANTHROPIC_ADMIN_API_KEY
          ? await fetchAnthropicAdminUsageAndCosts({
              apiKey: process.env.ANTHROPIC_ADMIN_API_KEY,
              startingAt: new Date(start).toISOString(),
              endingAt: new Date(now).toISOString(),
              nowMs: now
            })
          : null
      expect(admin, 'set OPENAI_ADMIN_API_KEY or ANTHROPIC_ADMIN_API_KEY').toBeTruthy()
      expect(admin!.rows.providerRawUsage.length).toBeGreaterThan(0)
      expect(admin!.rows.usageLedger.length).toBeGreaterThan(0)

      const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Db }
      const db = new sqlite.DatabaseSync(':memory:')
      for (const stmt of [...DDL_V1, ...DDL_V2, ...DDL_V3, ...DDL_V4]) db.prepare(stmt).run()

      const sdk = billingRowsFromItems({
        runId: `sdk-${provider}`,
        sessionId: 'real-admin-smoke',
        cwd: process.cwd(),
        items: [resultEvent(provider)],
        nowMs: now
      })
      const insRaw = db.prepare(sqlInsert('provider_raw_usage', PROVIDER_RAW_USAGE_COLS))
      const insLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
      for (const r of admin!.rows.providerRawUsage) insRaw.run(...r)
      for (const r of [...admin!.rows.usageLedger, ...sdk.usageLedger]) insLedger.run(...r)

      const raw = db.prepare(`SELECT COUNT(*) n FROM provider_raw_usage`).get() as { n: number }
      const ledger = db.prepare(`SELECT COUNT(*) n FROM usage_ledger`).get() as { n: number }
      const rows = db.prepare(`SELECT * FROM usage_ledger`).all() as Record<string, unknown>[]
      const reconciliation = reconcileUsageLedger(rows.map(rowToLedger))
      const rec = reconciliation.find((r) => r.provider === provider)

      expect(raw.n).toBe(admin!.rows.providerRawUsage.length)
      expect(ledger.n).toBe(admin!.rows.usageLedger.length + sdk.usageLedger.length)
      expect(rec?.sdkEstimate).toBeGreaterThan(0)
      expect((rec?.officialBill ?? 0) + (rec?.officialTelemetry ?? 0)).toBeGreaterThan(0)
      db.close()
    },
    60000
  )
})
