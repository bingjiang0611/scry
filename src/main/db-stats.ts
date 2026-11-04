// Bounded statistics and usage analytics read from the ledger tables.
// P0（RFC v2.4）：可信数据底座的 electron 胶水层。schema/行映射/查询 SQL 在纯模块 span-ledger.ts，
// 本文件只负责 electron 路径解析 + 预编译语句执行 + 迁移闸控。WAL + user_version 增量迁移。
// 原生模块，打包要 asarUnpack。加载失败（EDR/ABI）整体降级 no-op，不连累 app 启动。
import { app } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readQoderCreditRows, reconcileQoderCreditRows, withQoderCredits, type QoderCreditScope } from './qoder-credits'
import { type DbStats, type UsageAnalytics, type UsageAnalyticsRangeDays } from '../shared/trace'
import { TOTALS_SQL, TOP_TOOLS_SQL, BY_CWD_SQL, BY_MODEL_SQL, TOOL_STATS_SQL, DANGER_TREND_SQL, INTERVENTION_STATS_SQL, ANALYTICS_RESULTS_SQL, ANALYTICS_TOOLS_SQL, ANALYTICS_DANGER_SQL, ANALYTICS_MCP_SQL, USAGE_ANALYTICS_TOKENS_SQL, USAGE_ANALYTICS_COSTS_SQL, buildAnalyticsStats, buildUsageAnalytics, usageAnalyticsBounds, type AnalyticsResultRow, type AnalyticsToolRow, type AnalyticsDangerRow, type AnalyticsMcpRow, type UsageAnalyticsTokenRow, type UsageAnalyticsCostRow, canonicalUsdCostWhere } from './span-ledger'
import { dataRevision, db, statsCacheSlot, usageAnalyticsCache } from './db-connection'

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

function computeStats(): DbStats {
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

export function statsQuery(): DbStats {
  const now = Date.now()
  if (statsCacheSlot.value?.revision === dataRevision && now - statsCacheSlot.value.observedAt < 1000) return statsCacheSlot.value.value
  const value = computeStats()
  statsCacheSlot.value = { revision: dataRevision, observedAt: now, value }
  return value
}

export async function usageAnalyticsWithCreditsQuery(rangeDays: UsageAnalyticsRangeDays): Promise<UsageAnalytics> {
  const analytics = usageAnalyticsQuery(rangeDays)
  if (!db || analytics.status !== 'ready') return analytics
  const revision = dataRevision
  const readScopes = (value: UsageAnalytics): QoderCreditScope[] => {
    const bounds = usageAnalyticsBounds(value.observedAt, rangeDays)
    return db!.prepare(`SELECT u.run_id runId, r.external_session_id sessionId, r.cwd, r.provider_id providerId,
      MAX(CASE WHEN ${canonicalUsdCostWhere('u')} THEN 1 ELSE 0 END) hasUsdCost,
      MIN(u.bucket_start) tsStart FROM usage_ledger u
      JOIN session_refs r ON r.scry_session_id=u.session_id
      WHERE u.provider='qoder' AND r.provider_id IN ('qoder','pi') AND u.run_id IS NOT NULL
        AND u.bucket_start>=? AND u.bucket_start<?
      GROUP BY u.run_id, r.external_session_id, r.cwd, r.provider_id ORDER BY tsStart DESC`).all(bounds.from, bounds.to) as QoderCreditScope[]
  }
  try {
    const scopes = readScopes(analytics)
    const credits = await readQoderCreditRows({
      scopes,
      userDataDir: app.getPath('userData'),
      projectsDir: join(process.env.QODER_CONFIG_DIR || join(process.env.QODER_CLI_HOME || homedir(), '.qoder'), 'projects')
    })
    if (revision === dataRevision) return withQoderCredits(analytics, credits)

    // Credit projection scans native transcripts asynchronously. Keep evidence
    // for unchanged turns when SQLite advances instead of dropping the entire
    // projection; deleted/changed turns are removed and new turns stay unknown.
    const latest = usageAnalyticsQuery(rangeDays)
    if (latest.status !== 'ready') return latest
    return withQoderCredits(latest, reconcileQoderCreditRows(readScopes(latest), credits))
  } catch {
    return analytics
  }
}

export function usageAnalyticsQuery(rangeDays: UsageAnalyticsRangeDays): UsageAnalytics {
  const nowMs = Date.now()
  const bounds = usageAnalyticsBounds(nowMs, rangeDays)
  const cached = usageAnalyticsCache.get(rangeDays)
  const toDay = bounds.days.at(-1)!
  if (cached?.revision === dataRevision && cached.toDay === toDay) return cached.value
  const empty = buildUsageAnalytics({ nowMs, rangeDays, tokens: [], costs: [] })
  if (!db) return { ...empty, status: 'unavailable' }
  try {
    const value = buildUsageAnalytics({
      nowMs,
      rangeDays,
      tokens: db.prepare(USAGE_ANALYTICS_TOKENS_SQL).all(bounds.from, bounds.to) as UsageAnalyticsTokenRow[],
      costs: db.prepare(USAGE_ANALYTICS_COSTS_SQL).all(bounds.from, bounds.to) as UsageAnalyticsCostRow[]
    })
    usageAnalyticsCache.set(rangeDays, { revision: dataRevision, toDay, value })
    return value
  } catch (error) {
    console.warn('[scry] usageAnalyticsQuery 失败:', (error as Error)?.message)
    return { ...empty, status: 'query_error' }
  }
}
