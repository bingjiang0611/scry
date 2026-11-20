// 跨会话聚合查询与 30/60/90 天窗口统计（纯函数 + SQL 常量）。
import type { DbStats } from '../shared/trace'
import { providerDangerCoverage, type ProviderId } from '../shared/provider'

// 跨会话聚合查询（从 spans/model_usage）。result span 持 cost/token（modelUsage 聚合，非顶层 usage）。
export const TOTALS_SQL = `SELECT SUM(cost_usd) cost, SUM(tokens_in) tin,
  SUM(tokens_out) tout, COUNT(*) turns,
  (SELECT COUNT(*) FROM spans WHERE kind IN ('tool','skill','agent')) toolCalls,
  (SELECT COUNT(*) FROM spans WHERE danger_level IS NOT NULL) dangerEvents
  FROM spans WHERE kind='harness' AND stage='result'`
export const TOP_TOOLS_SQL = `SELECT tool, COUNT(*) n, SUM(CASE WHEN mcp_server IS NOT NULL THEN 1 ELSE 0 END) mcp
  FROM spans WHERE kind IN ('tool','skill','agent') AND tool IS NOT NULL GROUP BY tool ORDER BY n DESC LIMIT 8`
export const BY_CWD_SQL = `SELECT cwd, SUM(cost_usd) cost, COUNT(*) turns
  FROM spans WHERE kind='harness' AND stage='result' AND cwd IS NOT NULL GROUP BY cwd ORDER BY cost DESC LIMIT 5`
export const BY_MODEL_SQL = `SELECT model, SUM(input_tokens) tin, SUM(output_tokens) tout,
  SUM(cost_usd) cost FROM model_usage GROUP BY model ORDER BY cost DESC LIMIT 8`
// P2 Analytics：工具耗时（墙钟推算，duration_ms 非空才计）+ 失败次数，按平均耗时降序。
export const TOOL_STATS_SQL = `SELECT tool, COUNT(*) n, CAST(AVG(duration_ms) AS INTEGER) avgMs,
  SUM(CASE WHEN is_error=1 THEN 1 ELSE 0 END) errors
  FROM spans WHERE kind IN ('tool','skill','agent') AND tool IS NOT NULL AND duration_ms IS NOT NULL
  GROUP BY tool ORDER BY avgMs DESC LIMIT 8`
// P3 跨会话危险趋势：按危险原因聚合频次（danger 在 warn 前）。
export const DANGER_TREND_SQL = `SELECT danger_reason reason, danger_level level, COUNT(*) n
  FROM spans WHERE danger_level IS NOT NULL
  GROUP BY danger_reason, danger_level ORDER BY (danger_level='danger') DESC, n DESC LIMIT 10`
export const INTERVENTION_STATS_SQL = `SELECT
  COUNT(*) requested,
  COALESCE(SUM(CASE WHEN resolution IN ('answered','user_cancelled') THEN 1 ELSE 0 END), 0) total,
  COALESCE(SUM(CASE WHEN resolution='answered' THEN 1 ELSE 0 END), 0) answered,
  COALESCE(SUM(CASE WHEN resolution='user_cancelled' THEN 1 ELSE 0 END), 0) cancelled,
  COALESCE(SUM(CASE WHEN resolution IN ('answered','user_cancelled') THEN question_count ELSE 0 END), 0) questions,
  COALESCE(SUM(CASE WHEN resolution IN ('answered','user_cancelled') AND kind='clarification' THEN 1 ELSE 0 END), 0) clarification,
  COALESCE(SUM(CASE WHEN resolution IN ('answered','user_cancelled') AND kind='permission' THEN 1 ELSE 0 END), 0) permission,
  COALESCE(SUM(CASE WHEN resolution IN ('answered','user_cancelled') THEN duration_ms ELSE 0 END), 0) waitMs
  FROM human_interventions`

export const ANALYTICS_RESULTS_SQL = `SELECT s.ts_start tsStart, r.provider_id providerId,
  s.tokens_in inputTokens, s.tokens_out outputTokens,
  s.cache_read_tokens cacheReadTokens, s.cache_creation_tokens cacheWriteTokens
  FROM spans s LEFT JOIN session_refs r ON r.scry_session_id=s.session_id
  WHERE s.kind='harness' AND s.stage='result' AND s.ts_start>=? AND s.ts_start<?`
export const ANALYTICS_TOOLS_SQL = `SELECT ts_start tsStart FROM spans
  WHERE kind IN ('tool','skill','agent') AND ts_start>=? AND ts_start<?`
export const ANALYTICS_DANGER_SQL = `SELECT ts_start tsStart, danger_level level FROM spans
  WHERE danger_level IS NOT NULL AND ts_start>=? AND ts_start<?`
export const ANALYTICS_MCP_SQL = `SELECT mcp_server server, duration_ms durationMs, is_error isError FROM spans
  WHERE mcp_server IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms>=0 AND ts_start>=? AND ts_start<?`

export interface AnalyticsResultRow {
  tsStart: number
  providerId: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}
export interface AnalyticsToolRow { tsStart: number }
export interface AnalyticsDangerRow { tsStart: number; level: string }
export interface AnalyticsMcpRow { server: string; durationMs: number; isError: number }

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity']
export const localDay = (ms: number): string => {
  const date = new Date(ms)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
export const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
const percentChange = (current: number | null, previous: number | null): number | null =>
  current == null || previous == null || previous === 0 ? null : ((current - previous) / previous) * 100
const sumKnown = (rows: AnalyticsResultRow[], key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'): number | null => {
  const known = rows.filter((row) => row[key] != null)
  return known.length ? known.reduce((sum, row) => sum + (row[key] ?? 0), 0) : null
}

export function nearestRank(values: number[], percentile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, percentile)) * sorted.length))
  return sorted[rank - 1]
}

export function buildAnalyticsStats(args: {
  nowMs: number
  results: AnalyticsResultRow[]
  tools: AnalyticsToolRow[]
  dangers: AnalyticsDangerRow[]
  mcp: AnalyticsMcpRow[]
}): Pick<DbStats, 'tokenDaily' | 'dangerDaily' | 'comparison' | 'cacheReuse' | 'mcpLatency' | 'providerCoverage'> {
  const today = startOfLocalDay(args.nowMs)
  const currentStart = new Date(new Date(today).setDate(new Date(today).getDate() - 29)).getTime()
  const previousStart = new Date(new Date(today).setDate(new Date(today).getDate() - 59)).getTime()
  const tomorrow = new Date(new Date(today).setDate(new Date(today).getDate() + 1)).getTime()
  const dangerStart = new Date(new Date(today).setDate(new Date(today).getDate() - 89)).getTime()
  const currentResults = args.results.filter((row) => row.tsStart >= currentStart && row.tsStart < tomorrow)
  const previousResults = args.results.filter((row) => row.tsStart >= previousStart && row.tsStart < currentStart)
  const currentResultsByDay = new Map<string, AnalyticsResultRow[]>()
  const currentResultsByProvider = new Map<string, AnalyticsResultRow[]>()
  for (const row of currentResults) {
    const day = localDay(row.tsStart)
    const dayRows = currentResultsByDay.get(day)
    if (dayRows) dayRows.push(row)
    else currentResultsByDay.set(day, [row])
    if (row.providerId) {
      const providerRows = currentResultsByProvider.get(row.providerId)
      if (providerRows) providerRows.push(row)
      else currentResultsByProvider.set(row.providerId, [row])
    }
  }

  const tokenDaily = Array.from({ length: 30 }, (_, i) => {
    const start = new Date(new Date(currentStart).setDate(new Date(currentStart).getDate() + i)).getTime()
    const rows = currentResultsByDay.get(localDay(start)) ?? []
    return {
      day: localDay(start),
      input: sumKnown(rows, 'inputTokens'),
      output: sumKnown(rows, 'outputTokens'),
      cacheRead: sumKnown(rows, 'cacheReadTokens'),
      cacheWrite: sumKnown(rows, 'cacheWriteTokens'),
      turns: rows.length,
      inputKnownTurns: rows.filter((row) => row.inputTokens != null).length,
      outputKnownTurns: rows.filter((row) => row.outputTokens != null).length,
      cacheReadKnownTurns: rows.filter((row) => row.cacheReadTokens != null).length,
      cacheWriteKnownTurns: rows.filter((row) => row.cacheWriteTokens != null).length
    }
  })
  const dangersByDay = new Map<string, { danger: number; warn: number }>()
  for (const row of args.dangers) {
    if (row.tsStart < dangerStart || row.tsStart >= tomorrow) continue
    const counts = dangersByDay.get(localDay(row.tsStart)) ?? { danger: 0, warn: 0 }
    if (row.level === 'danger') counts.danger++
    if (row.level === 'warn') counts.warn++
    dangersByDay.set(localDay(row.tsStart), counts)
  }
  const dangerDaily = Array.from({ length: 90 }, (_, i) => {
    const start = new Date(new Date(dangerStart).setDate(new Date(dangerStart).getDate() + i)).getTime()
    return { day: localDay(start), ...(dangersByDay.get(localDay(start)) ?? { danger: 0, warn: 0 }) }
  })

  const windowSummary = (results: AnalyticsResultRow[], from: number, to: number) => {
    const complete = results.filter((row) => row.inputTokens != null && row.outputTokens != null)
    const tokens = complete.length ? complete.reduce((sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0) : null
    return {
      tokens,
      tokenKnownTurns: complete.length,
      turns: results.length,
      toolCalls: args.tools.filter((row) => row.tsStart >= from && row.tsStart < to).length,
      danger: args.dangers.filter((row) => row.tsStart >= from && row.tsStart < to && row.level === 'danger').length
    }
  }
  const current = windowSummary(currentResults, currentStart, tomorrow)
  const previous = windowSummary(previousResults, previousStart, currentStart)

  const providerCoverage = PROVIDERS.map((providerId) => {
    const rows = currentResultsByProvider.get(providerId) ?? []
    return {
      providerId,
      turns: rows.length,
      inputKnownTurns: rows.filter((row) => row.inputTokens != null).length,
      outputKnownTurns: rows.filter((row) => row.outputTokens != null).length,
      cacheReadKnownTurns: rows.filter((row) => row.cacheReadTokens != null).length,
      cacheWriteKnownTurns: rows.filter((row) => row.cacheWriteTokens != null).length,
      dangerCoverage: providerDangerCoverage(providerId) ?? 'unsupported'
    }
  })
  const cacheReuse = PROVIDERS.map((providerId) => {
    const rows = currentResultsByProvider.get(providerId) ?? []
    const denominator: NonNullable<DbStats['cacheReuse']>[number]['denominator'] = providerId === 'claude' || providerId === 'antigravity'
      ? 'separate_input'
      : providerId === 'codex'
        ? 'input_includes_cache'
        : providerId === 'opencode'
          ? 'upstream_dependent'
          : 'unknown'
    const comparable = providerId === 'claude' || providerId === 'antigravity'
      ? rows.filter((row) => row.inputTokens != null && row.cacheReadTokens != null && row.cacheWriteTokens != null)
      : providerId === 'codex'
        ? rows.filter((row) => row.inputTokens != null && row.cacheReadTokens != null)
        : []
    const numerator = comparable.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0)
    const divisor = providerId === 'claude' || providerId === 'antigravity'
      ? comparable.reduce((sum, row) => sum + (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0), 0)
      : providerId === 'codex'
        ? comparable.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)
        : 0
    return {
      providerId,
      turns: rows.length,
      inputTokens: sumKnown(rows, 'inputTokens'),
      cacheReadTokens: sumKnown(rows, 'cacheReadTokens'),
      cacheWriteTokens: sumKnown(rows, 'cacheWriteTokens'),
      inputKnownTurns: rows.filter((row) => row.inputTokens != null).length,
      cacheReadKnownTurns: rows.filter((row) => row.cacheReadTokens != null).length,
      cacheWriteKnownTurns: rows.filter((row) => row.cacheWriteTokens != null).length,
      comparableTurns: comparable.length,
      reuseRate: divisor > 0 ? numerator / divisor : null,
      denominator
    }
  })

  const mcpGroups = new Map<string, AnalyticsMcpRow[]>()
  for (const row of args.mcp) {
    const rows = mcpGroups.get(row.server)
    if (rows) rows.push(row)
    else mcpGroups.set(row.server, [row])
  }
  const mcpLatency = [...mcpGroups.entries()].map(([server, rows]) => ({
    server,
    calls: rows.length,
    p50Ms: nearestRank(rows.map((row) => row.durationMs), 0.5),
    p95Ms: nearestRank(rows.map((row) => row.durationMs), 0.95),
    errors: rows.filter((row) => row.isError === 1).length
  })).sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server))

  return {
    tokenDaily,
    dangerDaily,
    comparison: {
      current,
      previous,
      change: {
        tokensPct: current.tokenKnownTurns === current.turns && previous.tokenKnownTurns === previous.turns
          ? percentChange(current.tokens, previous.tokens)
          : null,
        turnsPct: percentChange(current.turns, previous.turns),
        toolCallsPct: percentChange(current.toolCalls, previous.toolCalls),
        dangerPct: percentChange(current.danger, previous.danger)
      }
    },
    cacheReuse,
    mcpLatency,
    providerCoverage
  }
}
