// P0（RFC v2.4）：可信数据底座的 electron 胶水层。schema/行映射/查询 SQL 在纯模块 span-ledger.ts，
// 本文件只负责 electron 路径解析 + 预编译语句执行 + 迁移闸控。WAL + user_version 增量迁移。
// 原生模块，打包要 asarUnpack。加载失败（EDR/ABI）整体降级 no-op，不连累 app 启动。
import type Database from 'better-sqlite3'
import { app } from 'electron'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { maskSecrets, type TraceEvent, type DbStats } from '../shared/trace'
import {
  SPAN_COLS,
  MODEL_USAGE_COLS,
  FILE_OP_COLS,
  HUMAN_INTERVENTION_COLS,
  PROVIDER_RAW_USAGE_COLS,
  USAGE_LEDGER_COLS,
  MODEL_PRICE_VERSION_COLS,
  TEAM_LABEL_COLS,
  GATEWAY_POLICY_COLS,
  BILLING_AUDIT_LOG_COLS,
  BILLING_RETENTION_POLICY_COLS,
  CONTRACT_PRICE_COLS,
  CHARGEBACK_ENTRY_COLS,
  TOTALS_SQL,
  TOP_TOOLS_SQL,
  BY_CWD_SQL,
  BY_MODEL_SQL,
  TOOL_STATS_SQL,
  DANGER_TREND_SQL,
  INTERVENTION_STATS_SQL,
  ANALYTICS_RESULTS_SQL,
  ANALYTICS_TOOLS_SQL,
  ANALYTICS_DANGER_SQL,
  ANALYTICS_MCP_SQL,
  UPSERT_SESSION_REF_SQL,
  buildAnalyticsStats,
  type AnalyticsResultRow,
  type AnalyticsToolRow,
  type AnalyticsDangerRow,
  type AnalyticsMcpRow,
  canonicalUsdCostWhere,
  sqlInsert,
  spanRowsFromItems
} from './span-ledger'
import { migrateDatabase } from './db-migrations'
import { adminKeyStatus, fetchAnthropicAdminUsageAndCosts, fetchOpenAiAdminUsageAndCosts, fetchQoderUsageAndCosts, type AdminFetchResult } from './billing-admin'
import { billingRowsFromAnthropicGatewayPayload, billingRowsFromItems, reconcileUsageLedger, type LocalModelPriceVersion } from './billing-ledger'
import type { BillingFixtureImportResult, BillingGuardianState, BillingProvider, BillingSyncResult, UsageLedgerObject } from '../shared/billing'
import type { RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import { scrySessionId } from './session-id'
import { deleteSessionDataRows, resolveSessionDataRunIds, type SessionDeleteDatabase } from './session-data-delete'

let db: Database.Database | null = null
let dbFilePath: string | null = null
const require = createRequire(import.meta.url)
let billingEnvProvider: () => NodeJS.ProcessEnv = () => process.env

export function setBillingEnvProvider(provider: () => NodeJS.ProcessEnv): void {
  billingEnvProvider = provider
}

function gatewayAccountLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  const baseUrl = env.ANTHROPIC_BASE_URL
  const token = env.ANTHROPIC_AUTH_TOKEN
  if (!baseUrl || !token) return null
  try {
    return new URL(baseUrl).origin
  } catch {
    return 'custom-anthropic-gateway'
  }
}

function safeJson(v: unknown): string {
  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') return maskSecrets(input)
    if (Array.isArray(input)) return input.map(scrub)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, val]) => [k, scrub(val)]))
    return input
  }
  return JSON.stringify(scrub(v ?? {}))
}

export function initDb(): void {
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    dbFilePath = join(app.getPath('userData'), 'scry.db')
    db = new Database(dbFilePath)
    db.pragma('journal_mode = WAL')
    migrateDatabase(db)
  } catch (e) {
    try { db?.close() } catch { /* retain the original initialization error */ }
    db = null // 降级：sqlite 不可用就不写不查，app 照常跑
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

export function recordTurn(args: {
  runId: string
  sessionId?: string
  cwd?: string
  userText: string
  items: TraceEvent[]
  runtimeProvider?: RuntimeProvider
  providerId?: ProviderId
  billingProvider?: BillingProvider
}): void {
  if (!db) return
  try {
    const ts = Date.now()
    const cwd = args.cwd ?? ''
    db.prepare(
      `INSERT INTO projects (cwd, name, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(cwd) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    ).run(cwd, cwd ? basename(cwd) : '不绑定项目', ts)
    const internalSessionId = args.sessionId && args.providerId
      ? scrySessionId(args.providerId, cwd, args.sessionId)
      : undefined
    if (internalSessionId && args.sessionId && args.providerId && args.runtimeProvider) {
      db.prepare(UPSERT_SESSION_REF_SQL).run(
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
    const insMu = db.prepare(sqlInsert('model_usage', MODEL_USAGE_COLS))
    const insFo = db.prepare(
      `INSERT INTO file_ops (${FILE_OP_COLS.join(', ')}) VALUES (${FILE_OP_COLS.map(() => '?').join(', ')})`
    )
    const insIntervention = db.prepare(sqlInsert('human_interventions', HUMAN_INTERVENTION_COLS))
    const insLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
    const tx = db.transaction(() => {
      for (const r of rows.spans) insSpan.run(...(r as never[]))
      for (const r of rows.modelUsage) insMu.run(...(r as never[]))
      for (const r of rows.fileOps) insFo.run(...(r as never[]))
      for (const r of rows.interventions) insIntervention.run(...(r as never[]))
      for (const r of billing.usageLedger) insLedger.run(...(r as never[]))
    })
    tx()
  } catch (e) {
    console.warn('[scry] recordTurn 失败:', (e as Error)?.message)
  }
}

function envConnections(state: {
  lastOpenAiSync?: number
  lastAnthropicSync?: number
  lastOpenAiError?: string
  lastAnthropicError?: string
  lastQoderSync?: number
  lastQoderError?: string
} = {}): BillingGuardianState['adminConnections'] {
  const keys = adminKeyStatus(billingEnvProvider())
  return [
    {
      provider: 'anthropic',
      envVar: 'ANTHROPIC_ADMIN_API_KEY',
      configured: keys.anthropic,
      status: state.lastAnthropicError ? 'last_sync_error' : state.lastAnthropicSync ? 'last_sync_ok' : keys.anthropic ? 'ready' : 'missing_key',
      lastSyncTs: state.lastAnthropicSync,
      lastError: state.lastAnthropicError
    },
    {
      provider: 'openai',
      envVar: 'OPENAI_ADMIN_API_KEY',
      configured: keys.openai,
      status: state.lastOpenAiError ? 'last_sync_error' : state.lastOpenAiSync ? 'last_sync_ok' : keys.openai ? 'ready' : 'missing_key',
      lastSyncTs: state.lastOpenAiSync,
      lastError: state.lastOpenAiError
    },
    {
      provider: 'qoder',
      envVar: 'QODER_ADMIN_API_KEY + QODER_ORGANIZATION_ID',
      configured: keys.qoder,
      status: state.lastQoderError ? 'last_sync_error' : state.lastQoderSync ? 'last_sync_ok' : keys.qoder ? 'ready' : 'missing_key',
      lastSyncTs: state.lastQoderSync,
      lastError: state.lastQoderError
    }
  ]
}

function gatewayConnections(env: NodeJS.ProcessEnv = billingEnvProvider()): BillingGuardianState['gatewayConnections'] {
  const accountLabel = gatewayAccountLabel(env)
  return [
    {
      provider: 'anthropic',
      label: accountLabel ?? 'Anthropic-compatible gateway',
      baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
      tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
      configured: !!accountLabel,
      status: accountLabel ? 'ready' : 'missing_config',
      sourceKind: 'gateway_reported',
      note: accountLabel
        ? '三方网关已配置；SDK usage 可观测，官方账单仍为 unavailable'
        : '配置 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 后启用三方网关观测'
    }
  ]
}

function usageLedgerObjectFromDb(row: Record<string, unknown>): UsageLedgerObject {
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

function baseBillingState(): BillingGuardianState {
  return {
    adminConnections: envConnections(),
    gatewayConnections: gatewayConnections(),
    rawUsageRows: 0,
    ledgerRows: 0,
    sourceSummaries: [],
    reconciliation: [],
    rollups: [],
    priceVersions: [],
    preflight: {
      status: 'refused',
      confidence: 'inferred',
      evidence: 'usage_ledger has no historical rows; refusing PR estimate'
    },
    advice: [],
    teamCosts: [],
    gatewayPolicies: [],
    sharedReportExport: {
      availableFormats: ['markdown', 'json'],
      plannedFormats: ['csv', 'bi'],
      includesTranscript: false,
      evidence: 'normalized usage_ledger/team_labels export; transcript excluded by default'
    },
    audit: {
      auditRows: 0,
      retentionMode: 'aggregate-only',
      redactionMode: 'default',
      contractPriceRows: 0,
      chargebackRows: 0,
      showbackCost: 0
    }
  }
}

export function billingStateQuery(): BillingGuardianState {
  if (!db) {
    return baseBillingState()
  }
  try {
    const rawUsageRows = (db.prepare(`SELECT COUNT(*) n FROM provider_raw_usage`).get() as { n: number }).n
    const ledgerRows = (db.prepare(`SELECT COUNT(*) n FROM usage_ledger`).get() as { n: number }).n
    const sourceSummaries = db
      .prepare(
        `SELECT source, source_kind sourceKind, cost_source costSource, confidence,
                COUNT(*) rows, COALESCE(SUM(cost), 0) cost,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) tokens,
                MAX(created_ts) latestTs
         FROM usage_ledger GROUP BY source, source_kind, cost_source, confidence
         ORDER BY latestTs DESC`
      )
      .all() as BillingGuardianState['sourceSummaries']
    const rows = db.prepare(`SELECT * FROM usage_ledger ORDER BY created_ts DESC LIMIT 5000`).all() as Record<string, unknown>[]
    const reconciliation = reconcileUsageLedger(rows.map(usageLedgerObjectFromDb))
    const rollups = db
      .prepare(
        `SELECT 'day' granularity, COALESCE(project_key, 'unattributed') projectKey,
                COALESCE(model, 'unavailable') model, cost_source costSource, confidence,
                COUNT(*) rows, COALESCE(SUM(cost), 0) cost,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) tokens
         FROM usage_ledger
         WHERE ${canonicalUsdCostWhere()}
         GROUP BY date(bucket_start / 1000, 'unixepoch'), project_key, model, cost_source, confidence
         UNION ALL
         SELECT 'week' granularity, COALESCE(project_key, 'unattributed') projectKey,
                COALESCE(model, 'unavailable') model, cost_source costSource, confidence,
                COUNT(*) rows, COALESCE(SUM(cost), 0) cost,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) tokens
         FROM usage_ledger
         WHERE ${canonicalUsdCostWhere()}
         GROUP BY strftime('%Y-W%W', bucket_start / 1000, 'unixepoch'), project_key, model, cost_source, confidence
         ORDER BY cost DESC LIMIT 8`
      )
      .all() as BillingGuardianState['rollups']
    const priceVersions = db
      .prepare(
        `SELECT mp.id, mp.provider, mp.model, mp.currency, mp.source, mp.effective_from effectiveFrom,
                COUNT(ul.id) frozenLedgerRows
         FROM model_price_versions mp
         LEFT JOIN usage_ledger ul ON ul.price_version_id = mp.id
         GROUP BY mp.id, mp.provider, mp.model, mp.currency, mp.source, mp.effective_from
         ORDER BY mp.effective_from DESC LIMIT 8`
      )
      .all() as BillingGuardianState['priceVersions']
    const priced = db
      .prepare(`SELECT COUNT(*) n, COALESCE(AVG(cost), 0) avgCost FROM usage_ledger WHERE ${canonicalUsdCostWhere()}`)
      .get() as { n: number; avgCost: number }
    const preflight =
      priced.n < 3
        ? {
            status: 'refused' as const,
            confidence: 'inferred' as const,
            evidence: `usage_ledger priced rows=${priced.n}; history too sparse for PR estimate`
          }
        : {
            status: 'ready' as const,
            confidence: 'estimated' as const,
            low: Number((priced.avgCost * 0.5).toFixed(4)),
            expected: Number(priced.avgCost.toFixed(4)),
            high: Number((priced.avgCost * 1.8).toFixed(4)),
            evidence: `usage_ledger priced rows=${priced.n}; based on historical session costs`
          }
    const advice: BillingGuardianState['advice'] = []
    const cacheHeavy = db
      .prepare(
        `SELECT source, COUNT(*) rows, COALESCE(SUM(cache_write_tokens),0) writeTokens, COALESCE(SUM(cache_read_tokens),0) readTokens
         FROM usage_ledger GROUP BY source ORDER BY writeTokens DESC LIMIT 1`
      )
      .get() as { source: string; rows: number; writeTokens: number; readTokens: number } | undefined
    if (cacheHeavy && cacheHeavy.writeTokens > cacheHeavy.readTokens) {
      advice.push({
        title: '缓存写入高于读取',
        detail: '优先复用稳定 prompt 或拆分 session，避免重复写入缓存。',
        confidence: 'estimated',
        evidence: `usage_ledger:source=${cacheHeavy.source}`
      })
    }
    if (rollups.length > 0) {
      advice.push({
        title: '按项目查看高成本窗口',
        detail: '先从最高 day/week rollup 对应项目回看 expensive sessions。',
        confidence: 'inferred',
        evidence: `usage_rollup:${rollups[0].granularity}:${rollups[0].projectKey}`
      })
    }
    const teamCosts = db
      .prepare(
        `SELECT COALESCE(t.team, 'local') team, COALESCE(ul.project_key, 'unattributed') project,
                COALESCE(t.owner, ul.account_label, 'unassigned') owner,
                COALESCE(t.workflow, ul.source) workflow,
                COALESCE(SUM(ul.cost), 0) cost,
                CASE WHEN SUM(CASE WHEN ul.confidence='estimated' THEN 1 ELSE 0 END) > 0 THEN 'estimated'
                     WHEN SUM(CASE WHEN ul.confidence='provider_reported' THEN 1 ELSE 0 END) > 0 THEN 'provider_reported'
                     ELSE 'inferred' END confidence
         FROM usage_ledger ul
         LEFT JOIN team_labels t ON t.project_key = ul.project_key
         WHERE ${canonicalUsdCostWhere('ul')}
         GROUP BY team, project, owner, workflow
         ORDER BY cost DESC LIMIT 8`
      )
      .all() as BillingGuardianState['teamCosts']
    const gatewayPolicies = db
      .prepare(
        `SELECT provider, label, source, budget_usd budgetUsd, rpm, tpm, keys_hosted keysHosted
         FROM gateway_policies ORDER BY imported_ts DESC LIMIT 8`
      )
      .all()
      .map((r) => ({ ...(r as BillingGuardianState['gatewayPolicies'][number]), keysHosted: !!(r as { keysHosted: number }).keysHosted }))
    const retention =
      (db
        .prepare(`SELECT raw_payload_mode retentionMode, redaction_mode redactionMode FROM billing_retention_policies ORDER BY updated_ts DESC LIMIT 1`)
        .get() as { retentionMode: string; redactionMode: string } | undefined) ?? null
    const auditRows = (db.prepare(`SELECT COUNT(*) n FROM billing_audit_log`).get() as { n: number }).n
    const contractPriceRows = (db.prepare(`SELECT COUNT(*) n FROM contract_prices`).get() as { n: number }).n
    const chargeback = db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(ul.cost),0) cost
         FROM usage_ledger ul
         LEFT JOIN team_labels t ON t.project_key = ul.project_key
         WHERE ${canonicalUsdCostWhere('ul')}`
      )
      .get() as { n: number; cost: number }
    return {
      adminConnections: envConnections(),
      gatewayConnections: gatewayConnections(),
      rawUsageRows,
      ledgerRows,
      sourceSummaries,
      reconciliation,
      rollups,
      priceVersions,
      preflight,
      advice,
      teamCosts,
      gatewayPolicies,
      sharedReportExport: {
        availableFormats: ['markdown', 'json'],
        plannedFormats: ['csv', 'bi'],
        includesTranscript: false,
        evidence: `available markdown report + normalized JSON state; teamCosts=${teamCosts.length}; usage_ledger rows=${ledgerRows}; transcript excluded by default`
      },
      audit: {
        auditRows,
        retentionMode: retention?.retentionMode ?? 'aggregate-only',
        redactionMode: retention?.redactionMode ?? 'default',
        contractPriceRows,
        chargebackRows: chargeback.n,
        showbackCost: chargeback.cost
      }
    }
  } catch (e) {
    console.warn('[scry] billingStateQuery 失败:', (e as Error)?.message)
    return baseBillingState()
  }
}

export async function syncBillingAdmin(): Promise<BillingSyncResult> {
  if (!db) return { ok: false, rowsImported: 0, ledgerRowsImported: 0, error: 'sqlite unavailable', state: billingStateQuery() }
  const now = Date.now()
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000
  const env = billingEnvProvider()
  const openAiKey = env.OPENAI_ADMIN_API_KEY
  const anthropicKey = env.ANTHROPIC_ADMIN_API_KEY
  const qoderKey = env.QODER_ADMIN_API_KEY
  const qoderOrganizationId = env.QODER_ORGANIZATION_ID
  try {
    const results: AdminFetchResult[] = []
    if (openAiKey) {
      results.push(await fetchOpenAiAdminUsageAndCosts({
          apiKey: openAiKey,
          startTime: Math.floor(oneWeekAgo / 1000),
          endTime: Math.floor(now / 1000),
          nowMs: now
        }))
    }
    if (anthropicKey) {
      results.push(await fetchAnthropicAdminUsageAndCosts({
          apiKey: anthropicKey,
          startingAt: new Date(oneWeekAgo).toISOString(),
          endingAt: new Date(now).toISOString(),
          nowMs: now
        }))
    }
    if (qoderKey && qoderOrganizationId) {
      results.push(await fetchQoderUsageAndCosts({
        apiKey: qoderKey,
        organizationId: qoderOrganizationId,
        memberId: env.QODER_MEMBER_ID,
        startDate: new Date(oneWeekAgo).toISOString(),
        endDate: new Date(now).toISOString(),
        nowMs: now
      }))
    }
    if (results.length === 0) {
      return { ok: false, rowsImported: 0, ledgerRowsImported: 0, error: 'missing Anthropic/OpenAI/Qoder Admin configuration', state: billingStateQuery() }
    }
    const insRaw = db.prepare(sqlInsert('provider_raw_usage', PROVIDER_RAW_USAGE_COLS))
    const insLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
    const tx = db.transaction(() => {
      for (const result of results) {
        for (const r of result.rows.providerRawUsage) insRaw.run(...(r as never[]))
        for (const r of result.rows.usageLedger) insLedger.run(...(r as never[]))
      }
    })
    tx()
    return {
      ok: true,
      provider: results.length === 1 ? results[0].provider : 'multiple',
      rowsImported: results.reduce((sum, result) => sum + result.rows.providerRawUsage.length, 0),
      ledgerRowsImported: results.reduce((sum, result) => sum + result.rows.usageLedger.length, 0),
      state: billingStateQuery()
    }
  } catch (e) {
    return { ok: false, rowsImported: 0, ledgerRowsImported: 0, error: String((e as Error).message), state: billingStateQuery() }
  }
}

function insertBillingRows(rows: { providerRawUsage: unknown[][]; usageLedger: unknown[][] }): void {
  if (!db) return
  const insRaw = db.prepare(sqlInsert('provider_raw_usage', PROVIDER_RAW_USAGE_COLS))
  const insLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
  const tx = db.transaction(() => {
    for (const r of rows.providerRawUsage) insRaw.run(...(r as never[]))
    for (const r of rows.usageLedger) insLedger.run(...(r as never[]))
  })
  tx()
}

export function importBillingFixture(): BillingFixtureImportResult {
  const fixture = 'fixtures/billing/anthropic-gateway-response.json'
  if (!db) return { ok: false, fixture, rowsImported: 0, ledgerRowsImported: 0, error: 'sqlite unavailable', state: billingStateQuery() }
  try {
    const fp = join(app.getAppPath(), fixture)
    if (!existsSync(fp)) return { ok: false, fixture, rowsImported: 0, ledgerRowsImported: 0, error: 'fixture missing', state: billingStateQuery() }
    const json = JSON.parse(readFileSync(fp, 'utf8')) as {
      responses?: Record<string, unknown>[]
      accountLabel?: string
      priceVersions?: Array<Record<string, unknown>>
      teamLabels?: Array<Record<string, unknown>>
      gatewayPolicies?: Array<Record<string, unknown>>
      retentionPolicy?: Record<string, unknown>
      contractPrices?: Array<Record<string, unknown>>
      chargebackEntries?: Array<Record<string, unknown>>
    }
    const fetchedAt = 1783000000000
    const rows = billingRowsFromAnthropicGatewayPayload({
      payloads: json.responses ?? [],
      fetchedAt,
      accountLabel: json.accountLabel ?? 'fixture-gateway'
    })
    insertBillingRows(rows)
    const insPrice = db.prepare(sqlInsert('model_price_versions', MODEL_PRICE_VERSION_COLS))
    const insTeam = db.prepare(sqlInsert('team_labels', TEAM_LABEL_COLS))
    const insPolicy = db.prepare(sqlInsert('gateway_policies', GATEWAY_POLICY_COLS))
    const insAudit = db.prepare(sqlInsert('billing_audit_log', BILLING_AUDIT_LOG_COLS))
    const insRetention = db.prepare(sqlInsert('billing_retention_policies', BILLING_RETENTION_POLICY_COLS))
    const insContract = db.prepare(sqlInsert('contract_prices', CONTRACT_PRICE_COLS))
    const insChargeback = db.prepare(sqlInsert('chargeback_entries', CHARGEBACK_ENTRY_COLS))
    const metaTx = db.transaction(() => {
      for (const p of json.priceVersions ?? []) {
        insPrice.run(
          p.id,
          p.provider,
          p.model,
          p.currency ?? 'USD',
          p.inputPerMillion ?? null,
          p.outputPerMillion ?? null,
          p.cacheReadPerMillion ?? null,
          p.cacheWritePerMillion ?? null,
          p.reasoningPerMillion ?? null,
          p.effectiveFrom ?? fetchedAt,
          null,
          p.source ?? 'fixture',
          safeJson({ importedFrom: fixture })
        )
      }
      for (const t of json.teamLabels ?? []) {
        insTeam.run(t.id, t.projectKey, t.team, t.owner, t.workflow, t.source ?? 'fixture', fetchedAt)
      }
      for (const p of json.gatewayPolicies ?? []) {
        insPolicy.run(
          p.id,
          p.provider,
          p.label,
          p.source ?? 'gateway-config-import',
          p.budgetUsd ?? null,
          p.rpm ?? null,
          p.tpm ?? null,
          safeJson(p.config ?? {}),
          0,
          fetchedAt
        )
      }
      const rp = json.retentionPolicy
      if (rp) {
        insRetention.run(
          rp.id,
          rp.rawPayloadMode ?? 'aggregate-only',
          rp.retentionDays ?? 30,
          rp.redactionMode ?? 'secrets-and-prompts',
          rp.exportMode ?? 'redacted',
          fetchedAt
        )
      }
      for (const p of json.contractPrices ?? []) {
        insContract.run(
          p.id,
          p.provider,
          p.model,
          p.currency ?? 'USD',
          p.inputPerMillion ?? null,
          p.outputPerMillion ?? null,
          p.cacheReadPerMillion ?? null,
          p.cacheWritePerMillion ?? null,
          p.effectiveFrom ?? fetchedAt,
          p.source ?? 'contract-import',
          safeJson({ importedFrom: fixture })
        )
      }
      for (const c of json.chargebackEntries ?? []) {
        insChargeback.run(
          c.id,
          c.team,
          c.projectKey,
          c.owner,
          c.workflow,
          c.cost ?? 0,
          c.currency ?? 'USD',
          c.source ?? 'gateway_reported',
          c.confidence ?? 'provider_reported',
          fetchedAt
        )
      }
      insAudit.run(`audit:${fetchedAt}:fixture`, 'local-user', 'import_gateway_fixture', fixture, safeJson({ rows: rows.usageLedger.length }), fetchedAt)
      insAudit.run(`audit:${fetchedAt}:retention`, 'local-user', 'apply_retention_policy', rp?.id ?? 'default', safeJson({ mode: rp?.rawPayloadMode ?? 'aggregate-only' }), fetchedAt)
    })
    metaTx()
    return {
      ok: true,
      fixture,
      provider: 'anthropic',
      rowsImported: rows.providerRawUsage.length,
      ledgerRowsImported: rows.usageLedger.length,
      state: billingStateQuery()
    }
  } catch (e) {
    return { ok: false, fixture, rowsImported: 0, ledgerRowsImported: 0, error: String((e as Error).message), state: billingStateQuery() }
  }
}

const EMPTY: DbStats = {
  status: 'unavailable',
  totals: { cost: null, tin: null, tout: null, turns: 0 },
  topTools: [],
  byCwd: [],
  byModel: [],
  toolStats: [],
  dangerTrend: [],
  tokenDaily: [],
  dangerDaily: [],
  comparison: {
    current: { tokens: null, tokenKnownTurns: 0, turns: 0, toolCalls: 0, danger: 0 },
    previous: { tokens: null, tokenKnownTurns: 0, turns: 0, toolCalls: 0, danger: 0 },
    change: { tokensPct: null, turnsPct: null, toolCallsPct: null, dangerPct: null }
  },
  cacheReuse: [],
  mcpLatency: [],
  providerCoverage: [],
  interventions: { requested: 0, total: 0, answered: 0, cancelled: 0, questions: 0, clarification: 0, permission: 0, waitMs: 0 }
}

export function statsQuery(): DbStats {
  if (!db) return EMPTY
  try {
    const now = Date.now()
    const resultStart = now - 62 * 24 * 60 * 60 * 1000
    const dangerStart = now - 92 * 24 * 60 * 60 * 1000
    const totals = db.prepare(TOTALS_SQL).get() as DbStats['totals']
    const topTools = db.prepare(TOP_TOOLS_SQL).all() as DbStats['topTools']
    const byCwd = db.prepare(BY_CWD_SQL).all() as DbStats['byCwd']
    const byModel = db.prepare(BY_MODEL_SQL).all() as DbStats['byModel']
    const toolStats = db.prepare(TOOL_STATS_SQL).all() as DbStats['toolStats']
    const dangerTrend = db.prepare(DANGER_TREND_SQL).all() as DbStats['dangerTrend']
    const interventions = db.prepare(INTERVENTION_STATS_SQL).get() as NonNullable<DbStats['interventions']>
    const analytics = buildAnalyticsStats({
      nowMs: now,
      results: db.prepare(ANALYTICS_RESULTS_SQL).all(resultStart, now + 1) as AnalyticsResultRow[],
      tools: db.prepare(ANALYTICS_TOOLS_SQL).all(resultStart, now + 1) as AnalyticsToolRow[],
      dangers: db.prepare(ANALYTICS_DANGER_SQL).all(dangerStart, now + 1) as AnalyticsDangerRow[],
      mcp: db.prepare(ANALYTICS_MCP_SQL).all(dangerStart, now + 1) as AnalyticsMcpRow[]
    })
    return { status: 'ready', totals, topTools, byCwd, byModel, toolStats, dangerTrend, interventions, ...analytics }
  } catch (e) {
    console.warn('[scry] statsQuery 失败:', (e as Error)?.message)
    return { ...EMPTY, status: 'query_error' }
  }
}
