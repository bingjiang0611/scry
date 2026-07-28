// P0 账本核心（纯逻辑，无 electron/Database 依赖，便于单测 + headless 集成验证）。
// db.ts 只负责 electron 路径 + 预编译语句执行；本文件负责 schema、TraceEvent→行映射、查询 SQL。
import { type DbStats, type TraceEvent, maskSecrets } from '../shared/trace'
import type { ProviderId } from '../shared/provider'

// v1（旧）：保留建表兼容旧库，P0 起不再写/读。
export const DDL_V1 = [
  `CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, cwd TEXT, preview TEXT, created_ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, session_id TEXT, cwd TEXT, user_text TEXT, cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER, duration_ms INTEGER, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER, run_id TEXT, tool TEXT, kind TEXT, is_mcp INTEGER, mcp_server TEXT, file_op TEXT, file_path TEXT, ts INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool)`,
  `CREATE INDEX IF NOT EXISTS idx_turns_cwd ON turns(cwd)`
]

// v2（P0）：projects/spans/model_usage/file_ops。idx_spans_tool 不建（RFC §6 N1）。
export const DDL_V2 = [
  `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, cwd TEXT UNIQUE NOT NULL, name TEXT, last_seen_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS spans (
     id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, message_id TEXT,
     tool_use_id TEXT, parent_tool_use_id TEXT, graph_parent_id TEXT, agent_id TEXT,
     ts_start INTEGER, ts_end INTEGER, duration_ms INTEGER, duration_api_ms INTEGER,
     kind TEXT, stage TEXT, name TEXT, tool TEXT, mcp_server TEXT, is_error INTEGER,
     input_preview TEXT, output_preview TEXT,
     cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER,
     cache_read_tokens INTEGER, cache_creation_tokens INTEGER, model TEXT, cwd TEXT)`,
  `CREATE TABLE IF NOT EXISTS model_usage (span_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cost_usd REAL, context_window INTEGER, PRIMARY KEY(span_id, model))`,
  `CREATE TABLE IF NOT EXISTS file_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, span_id TEXT, session_id TEXT, op TEXT, path TEXT, source TEXT, confidence TEXT, lines_added INTEGER, lines_deleted INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_spans_session_time ON spans(session_id, ts_start)`,
  `CREATE INDEX IF NOT EXISTS idx_spans_kind ON spans(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_file_ops_path ON file_ops(path)`,
  // 旧 sessions 行不回链 project（ALTER 只能给 NULL）；project 关联从 v2 新会话起算（RFC §6）。
  `ALTER TABLE sessions ADD COLUMN project_id INTEGER`
]

// v3（P3 审计）：spans 加危险标记列。只用 ALTER（不动 DDL_V2 的 CREATE，避免 fresh 装 v2 建好后
// v3 ALTER 报 duplicate column）。fresh：v2 建 spans(无danger)→v3 ALTER 加；老 v2 库：v3 ALTER 加。
export const DDL_V3 = [
  `ALTER TABLE spans ADD COLUMN danger_level TEXT`,
  `ALTER TABLE spans ADD COLUMN danger_reason TEXT`
]

// v4（Billing Guardian P1）：多来源 raw usage + normalized ledger。只新增表，不改写旧 spans/model_usage。
export const DDL_V4 = [
  `CREATE TABLE IF NOT EXISTS provider_accounts (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL,
     auth_mode TEXT NOT NULL, key_ref TEXT, created_ts INTEGER, updated_ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS provider_raw_usage (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, source TEXT NOT NULL, source_kind TEXT NOT NULL,
     account_label TEXT, fetched_at INTEGER NOT NULL, starting_at TEXT, ending_at TEXT,
     bucket_start INTEGER, bucket_end INTEGER, provider_request_id TEXT,
     trace_id TEXT, otel_span_id TEXT, parent_span_id TEXT, otel_signal TEXT, event_name TEXT,
     resource_attributes_json TEXT, span_attributes_json TEXT, payload_json TEXT NOT NULL, storage_mode TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage_ledger (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, source TEXT NOT NULL, source_kind TEXT NOT NULL,
     session_id TEXT, run_id TEXT, span_id TEXT, project_key TEXT, account_label TEXT,
     bucket_start INTEGER, bucket_end INTEGER, model TEXT, usage_kind TEXT NOT NULL,
     input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
     reasoning_tokens INTEGER, tool_tokens INTEGER, request_count INTEGER,
     cost REAL, currency TEXT, cost_unit TEXT NOT NULL,
     cost_source TEXT NOT NULL, confidence TEXT NOT NULL, attribution_method TEXT NOT NULL,
     raw_usage_id TEXT, metadata_json TEXT, price_version_id TEXT, created_ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS model_price_versions (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, currency TEXT NOT NULL,
     input_per_million REAL, output_per_million REAL, cache_read_per_million REAL, cache_write_per_million REAL,
     reasoning_per_million REAL, effective_from INTEGER NOT NULL, effective_to INTEGER,
     source TEXT NOT NULL, metadata_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS budgets (
     id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_key TEXT NOT NULL, mode TEXT NOT NULL,
     limit_value REAL NOT NULL, currency TEXT NOT NULL, window TEXT NOT NULL, created_ts INTEGER, updated_ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS budget_events (
     id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, threshold REAL NOT NULL, current_value REAL NOT NULL,
     window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, source_span_id TEXT, decision TEXT, created_ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_provider_raw_usage_provider_time ON provider_raw_usage(provider, bucket_start)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ledger_provider_time ON usage_ledger(provider, bucket_start)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ledger_session ON usage_ledger(session_id, run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ledger_cost_source ON usage_ledger(cost_source, confidence)`,
  `CREATE INDEX IF NOT EXISTS idx_budget_events_budget ON budget_events(budget_id, window_start, threshold)`
]

// v5（Billing Guardian P2-P4）：历史分析/团队治理/企业审计的本地摘要表。
export const DDL_V5 = [
  `CREATE TABLE IF NOT EXISTS team_labels (
     id TEXT PRIMARY KEY, project_key TEXT NOT NULL, team TEXT NOT NULL, owner TEXT NOT NULL,
     workflow TEXT NOT NULL, source TEXT NOT NULL, created_ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gateway_policies (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL,
     budget_usd REAL, rpm INTEGER, tpm INTEGER, config_json TEXT NOT NULL, keys_hosted INTEGER NOT NULL,
     imported_ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS billing_audit_log (
     id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
     metadata_json TEXT NOT NULL, created_ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS billing_retention_policies (
     id TEXT PRIMARY KEY, raw_payload_mode TEXT NOT NULL, retention_days INTEGER NOT NULL,
     redaction_mode TEXT NOT NULL, export_mode TEXT NOT NULL, updated_ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS contract_prices (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, currency TEXT NOT NULL,
     input_per_million REAL, output_per_million REAL, cache_read_per_million REAL,
     cache_write_per_million REAL, effective_from INTEGER NOT NULL, source TEXT NOT NULL,
     metadata_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chargeback_entries (
     id TEXT PRIMARY KEY, team TEXT NOT NULL, project_key TEXT NOT NULL, owner TEXT NOT NULL,
     workflow TEXT NOT NULL, cost REAL NOT NULL, currency TEXT NOT NULL, source TEXT NOT NULL,
     confidence TEXT NOT NULL, created_ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_team_labels_project ON team_labels(project_key)`,
  `CREATE INDEX IF NOT EXISTS idx_chargeback_team ON chargeback_entries(team, project_key)`
]

// v6（Provider identity）：新事实表只保存 Scry 内部 session id；外部 Provider session id 单独映射。
// 旧 sessions 表保留只读，不再承担多 Provider 唯一性。
export const DDL_V6 = [
  `CREATE TABLE IF NOT EXISTS session_refs (
     scry_session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, runtime_provider TEXT NOT NULL,
     cwd TEXT NOT NULL, external_session_id TEXT NOT NULL, preview TEXT, created_ts INTEGER NOT NULL,
     updated_ts INTEGER NOT NULL, UNIQUE(provider_id, cwd, external_session_id))`,
  `CREATE INDEX IF NOT EXISTS idx_session_refs_provider_cwd ON session_refs(provider_id, cwd, updated_ts)`
]

// v7（Analytics）：最近 30/60/90 天窗口查询只增加索引，不回填或重写历史事实。
export const DDL_V7 = [
  `CREATE INDEX IF NOT EXISTS idx_spans_time ON spans(ts_start)`,
  `CREATE INDEX IF NOT EXISTS idx_spans_mcp_time_duration ON spans(mcp_server, ts_start, duration_ms)`
]

export const SPAN_COLS = [
  'id', 'session_id', 'run_id', 'message_id', 'tool_use_id', 'parent_tool_use_id', 'graph_parent_id', 'agent_id',
  'ts_start', 'ts_end', 'duration_ms', 'duration_api_ms', 'kind', 'stage', 'name', 'tool', 'mcp_server', 'is_error',
  'input_preview', 'output_preview', 'cost_usd', 'tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_creation_tokens', 'model', 'cwd',
  'danger_level', 'danger_reason'
] as const
export const MODEL_USAGE_COLS = [
  'span_id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'context_window'
] as const
export const FILE_OP_COLS = ['span_id', 'session_id', 'op', 'path', 'source', 'confidence', 'lines_added', 'lines_deleted'] as const
export const PROVIDER_RAW_USAGE_COLS = [
  'id', 'provider', 'source', 'source_kind', 'account_label', 'fetched_at', 'starting_at', 'ending_at',
  'bucket_start', 'bucket_end', 'provider_request_id', 'trace_id', 'otel_span_id', 'parent_span_id', 'otel_signal',
  'event_name', 'resource_attributes_json', 'span_attributes_json', 'payload_json', 'storage_mode'
] as const
export const USAGE_LEDGER_COLS = [
  'id', 'provider', 'source', 'source_kind', 'session_id', 'run_id', 'span_id', 'project_key', 'account_label',
  'bucket_start', 'bucket_end', 'model', 'usage_kind', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'reasoning_tokens', 'tool_tokens', 'request_count', 'cost', 'currency', 'cost_unit',
  'cost_source', 'confidence', 'attribution_method', 'raw_usage_id', 'metadata_json', 'price_version_id', 'created_ts'
] as const
export const MODEL_PRICE_VERSION_COLS = [
  'id', 'provider', 'model', 'currency', 'input_per_million', 'output_per_million', 'cache_read_per_million',
  'cache_write_per_million', 'reasoning_per_million', 'effective_from', 'effective_to', 'source', 'metadata_json'
] as const
export const TEAM_LABEL_COLS = ['id', 'project_key', 'team', 'owner', 'workflow', 'source', 'created_ts'] as const
export const GATEWAY_POLICY_COLS = [
  'id', 'provider', 'label', 'source', 'budget_usd', 'rpm', 'tpm', 'config_json', 'keys_hosted', 'imported_ts'
] as const
export const BILLING_AUDIT_LOG_COLS = ['id', 'actor', 'action', 'target', 'metadata_json', 'created_ts'] as const
export const BILLING_RETENTION_POLICY_COLS = [
  'id', 'raw_payload_mode', 'retention_days', 'redaction_mode', 'export_mode', 'updated_ts'
] as const
export const CONTRACT_PRICE_COLS = [
  'id', 'provider', 'model', 'currency', 'input_per_million', 'output_per_million', 'cache_read_per_million',
  'cache_write_per_million', 'effective_from', 'source', 'metadata_json'
] as const
export const CHARGEBACK_ENTRY_COLS = [
  'id', 'team', 'project_key', 'owner', 'workflow', 'cost', 'currency', 'source', 'confidence', 'created_ts'
] as const

export const sqlInsert = (table: string, cols: readonly string[]): string =>
  `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`

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

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'qoder', 'opencode']
const localDay = (ms: number): string => {
  const date = new Date(ms)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
const startOfLocalDay = (ms: number): number => {
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

  const tokenDaily = Array.from({ length: 30 }, (_, i) => {
    const start = new Date(new Date(currentStart).setDate(new Date(currentStart).getDate() + i)).getTime()
    const end = new Date(new Date(start).setDate(new Date(start).getDate() + 1)).getTime()
    const rows = currentResults.filter((row) => row.tsStart >= start && row.tsStart < end)
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
  const dangerDaily = Array.from({ length: 90 }, (_, i) => {
    const start = new Date(new Date(dangerStart).setDate(new Date(dangerStart).getDate() + i)).getTime()
    const end = new Date(new Date(start).setDate(new Date(start).getDate() + 1)).getTime()
    const rows = args.dangers.filter((row) => row.tsStart >= start && row.tsStart < end)
    return { day: localDay(start), danger: rows.filter((row) => row.level === 'danger').length, warn: rows.filter((row) => row.level === 'warn').length }
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
    const rows = currentResults.filter((row) => row.providerId === providerId)
    return {
      providerId,
      turns: rows.length,
      inputKnownTurns: rows.filter((row) => row.inputTokens != null).length,
      outputKnownTurns: rows.filter((row) => row.outputTokens != null).length,
      cacheReadKnownTurns: rows.filter((row) => row.cacheReadTokens != null).length,
      cacheWriteKnownTurns: rows.filter((row) => row.cacheWriteTokens != null).length,
      dangerCoverage: (providerId === 'claude' || providerId === 'qoder' ? 'classified' : 'unsupported') as 'classified' | 'unsupported'
    }
  })
  const cacheReuse = PROVIDERS.map((providerId) => {
    const rows = currentResults.filter((row) => row.providerId === providerId)
    const denominator: NonNullable<DbStats['cacheReuse']>[number]['denominator'] = providerId === 'claude'
      ? 'separate_input'
      : providerId === 'codex'
        ? 'input_includes_cache'
        : providerId === 'opencode'
          ? 'upstream_dependent'
          : 'unknown'
    const comparable = providerId === 'claude'
      ? rows.filter((row) => row.inputTokens != null && row.cacheReadTokens != null && row.cacheWriteTokens != null)
      : providerId === 'codex'
        ? rows.filter((row) => row.inputTokens != null && row.cacheReadTokens != null)
        : []
    const numerator = comparable.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0)
    const divisor = providerId === 'claude'
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
  for (const row of args.mcp) mcpGroups.set(row.server, [...(mcpGroups.get(row.server) ?? []), row])
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

export const canonicalCostWhere = (a = 'usage_ledger'): string => `(
  ${a}.cost IS NOT NULL AND (
    ${a}.cost_source='provider_bill'
    OR (${a}.cost_source IN ('gateway_reported','provider_reported') AND NOT EXISTS (
      SELECT 1 FROM usage_ledger b
      WHERE b.provider=${a}.provider AND b.cost_unit=${a}.cost_unit
        AND (b.account_label IS NULL OR ${a}.account_label IS NULL OR b.account_label=${a}.account_label)
        AND (b.bucket_start IS NULL OR ${a}.bucket_start IS NULL OR (
          b.bucket_start <= COALESCE(${a}.bucket_end, ${a}.bucket_start)
          AND ${a}.bucket_start <= COALESCE(b.bucket_end, b.bucket_start)
        ))
        AND b.cost_source='provider_bill' AND b.cost IS NOT NULL
    ))
    OR (${a}.cost_source IN ('sdk_estimate','price_table') AND NOT EXISTS (
      SELECT 1 FROM usage_ledger b
      WHERE b.provider=${a}.provider AND b.cost_unit=${a}.cost_unit
        AND (b.account_label IS NULL OR ${a}.account_label IS NULL OR b.account_label=${a}.account_label)
        AND (b.bucket_start IS NULL OR ${a}.bucket_start IS NULL OR (
          b.bucket_start <= COALESCE(${a}.bucket_end, ${a}.bucket_start)
          AND ${a}.bucket_start <= COALESCE(b.bucket_end, b.bucket_start)
        ))
        AND b.cost_source IN ('provider_bill','gateway_reported','provider_reported')
        AND b.cost IS NOT NULL
    ))
  )
)`

// 现有 rollup / preflight / showback 契约都是美元金额；Credits 只在带 costUnit 的对账中展示。
export const canonicalUsdCostWhere = (a = 'usage_ledger'): string =>
  `(${canonicalCostWhere(a)} AND ${a}.cost_unit='usd')`

const PREVIEW_MAX = 2000
const preview = (s: string | null | undefined): string | null => {
  if (s == null) return null
  return maskSecrets(s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) : s) ?? null
}
const tsMs = (iso: string, fallback: number): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? fallback : t
}

export interface LedgerRows {
  spans: unknown[][]
  modelUsage: unknown[][]
  fileOps: unknown[][]
}

// TraceEvent[] → 待插入的行（纯函数）。tool_result 按 tool_use_id 合并进 tool_use span（不插新行）；
// result span 持 cost/token + cache 4 类 + duration_api_ms，modelUsage 展开；input/output preview 落库前 mask。
export function spanRowsFromItems(args: {
  runId: string
  sessionId?: string
  cwd?: string
  items: TraceEvent[]
  nowMs: number
}): LedgerRows {
  const { items, sessionId, cwd, nowMs } = args
  const rows: LedgerRows = { spans: [], modelUsage: [], fileOps: [] }
  const results = new Map<string, TraceEvent>()
  for (const e of items) if (e.stage === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e)

  for (const e of items) {
    if (e.stage === 'tool_result' || e.stage === 'text_delta') continue // 不落 span
    if (e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent') {
      const r = e.toolUseId ? results.get(e.toolUseId) : undefined
      const tStart = tsMs(e.ts, nowMs)
      const tEnd = r ? tsMs(r.ts, tStart) : null
      rows.spans.push([
        e.id, sessionId ?? null, e.runId, e.messageId ?? null,
        e.toolUseId ?? null, e.parentToolUseId ?? null, null /* graph_parent_id：P1 */, e.agentId ?? null,
        tStart, tEnd, tEnd != null ? tEnd - tStart : null /* 墙钟推算 */, null,
        e.kind, e.stage, e.name ?? null, e.tool ?? null, e.mcpServer ?? null, (r?.isError ?? e.isError) ? 1 : 0,
        preview(e.input != null ? JSON.stringify(e.input) : null), preview(r?.text ?? null),
        null, null, null, null, null, null, cwd ?? null,
        e.danger?.level ?? null, e.danger?.reason ?? null
      ])
      if (e.fileOp && e.filePath) {
        rows.fileOps.push([e.id, sessionId ?? null, e.fileOp, e.filePath, 'tool-input', 'exact', null, null])
      }
    }
  }
  const result = items.find((e) => e.kind === 'harness' && e.stage === 'result')
  if (result) {
    const tStart = tsMs(result.ts, nowMs)
    rows.spans.push([
      result.id, sessionId ?? null, result.runId, null, null, null, null, null,
      tStart, tStart, result.durationMs ?? null, result.durationApiMs ?? null,
      'harness', 'result', null, null, null, result.isError ? 1 : 0, null, null,
      result.costUsd ?? null, result.tokensIn ?? null, result.tokensOut ?? null,
      result.cacheReadTokens ?? null, result.cacheCreationTokens ?? null,
      result.modelUsage?.[0]?.model ?? null, cwd ?? null,
      null, null
    ])
    for (const mu of result.modelUsage ?? []) {
      rows.modelUsage.push([
        result.id, mu.model, mu.inputTokens ?? null, mu.outputTokens ?? null,
        mu.cacheReadTokens ?? null, mu.cacheCreationTokens ?? null, mu.costUsd ?? null, mu.contextWindow ?? null
      ])
    }
  }
  return rows
}
