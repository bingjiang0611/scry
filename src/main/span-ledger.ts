// P0 账本核心（纯逻辑，无 electron/Database 依赖，便于单测 + headless 集成验证）。
// db.ts 只负责 electron 路径 + 预编译语句执行；本文件负责 TraceEvent→行映射，并转出 schema 与查询子模块。
import type { TraceEvent } from '../shared/trace'
import { providerUsageResultEvents } from '../shared/result-timing'
import { logicalCallEventsForTurn } from '../shared/logical-calls'

export {
  BILLING_AUDIT_LOG_COLS,
  BILLING_RETENTION_POLICY_COLS,
  CHARGEBACK_ENTRY_COLS,
  CONTRACT_PRICE_COLS,
  DDL_V1,
  DDL_V2,
  DDL_V3,
  DDL_V4,
  DDL_V5,
  DDL_V6,
  DDL_V7,
  DDL_V8,
  DDL_V9,
  DDL_V10,
  DDL_V11,
  DDL_V12,
  DDL_V13,
  DDL_V14,
  DDL_V15,
  DELETE_MODEL_USAGE_FOR_SPAN_SQL,
  FILE_OP_COLS,
  GATEWAY_POLICY_COLS,
  HUMAN_INTERVENTION_COLS,
  MODEL_PRICE_VERSION_COLS,
  MODEL_USAGE_COLS,
  PROVIDER_RAW_USAGE_COLS,
  SPAN_COLS,
  sqlInsert,
  TEAM_LABEL_COLS,
  UPSERT_SESSION_REF_SQL,
  USAGE_LEDGER_COLS
} from './span-ledger-schema'
export {
  ANALYTICS_DANGER_SQL,
  ANALYTICS_MCP_SQL,
  ANALYTICS_RESULTS_SQL,
  ANALYTICS_TOOLS_SQL,
  buildAnalyticsStats,
  BY_CWD_SQL,
  BY_MODEL_SQL,
  DANGER_TREND_SQL,
  INTERVENTION_STATS_SQL,
  nearestRank,
  TOOL_STATS_SQL,
  TOP_TOOLS_SQL,
  TOTALS_SQL,
  type AnalyticsDangerRow,
  type AnalyticsMcpRow,
  type AnalyticsResultRow,
  type AnalyticsToolRow
} from './span-ledger-analytics'
export {
  buildUsageAnalytics,
  canonicalCostWhere,
  canonicalUsdCostWhere,
  USAGE_ANALYTICS_COSTS_SQL,
  USAGE_ANALYTICS_TOKENS_SQL,
  usageAnalyticsBounds,
  type UsageAnalyticsCostRow,
  type UsageAnalyticsTokenRow
} from './span-ledger-usage'

const PREVIEW_MAX = 2000
const preview = (s: string | null | undefined): string | null => {
  if (s == null) return null
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) : s
}
const tsMs = (iso: string, fallback: number): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? fallback : t
}

export interface LedgerRows {
  spans: unknown[][]
  modelUsage: unknown[][]
  fileOps: unknown[][]
  interventions: unknown[][]
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
  const rows: LedgerRows = { spans: [], modelUsage: [], fileOps: [], interventions: [] }
  const logicalItems = logicalCallEventsForTurn(items)
  const results = new Map<string, TraceEvent>()
  for (const e of logicalItems) if (e.stage === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e)

  for (const e of logicalItems) {
    if (e.intervention) {
      const intervention = e.intervention
      rows.interventions.push([
        e.id,
        sessionId ?? null,
        e.runId,
        e.providerId ?? intervention.request.providerId ?? null,
        e.agentId ?? intervention.request.agentId ?? null,
        intervention.request.questionId,
        intervention.kind,
        intervention.source,
        intervention.resolution,
        intervention.request.questions.length,
        JSON.stringify(intervention.request) ?? '{}',
        JSON.stringify(intervention.response) ?? '{}',
        tsMs(intervention.openedAt, nowMs),
        tsMs(intervention.closedAt, nowMs),
        intervention.durationMs
      ])
    }
    if (e.kind === 'harness' && e.stage === 'context_compaction') {
      const tStart = tsMs(e.ts, nowMs)
      rows.spans.push([
        e.id, sessionId ?? null, e.runId, null, null, null, null, e.agentId ?? null,
        tStart, tStart, e.durationMs ?? null, null,
        'harness', 'context_compaction', e.compaction?.trigger ?? null, null, null, 0,
        preview(e.compaction ? JSON.stringify(e.compaction) : null), null,
        null, null, null, null, null, null, cwd ?? null,
        null, null
      ])
      continue
    }
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
  for (const result of providerUsageResultEvents(items)) {
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
    const contextModel = result.contextModel ?? (result.modelUsage?.length === 1 ? result.modelUsage[0].model : undefined)
    for (const mu of result.modelUsage ?? []) {
      const ownsContext = result.contextTokens != null && contextModel === mu.model &&
        (!result.contextProvider || mu.upstreamProvider === result.contextProvider)
      rows.modelUsage.push([
        result.id, mu.model, mu.upstreamProvider ?? '', mu.inputTokens ?? null, mu.outputTokens ?? null,
        mu.cacheReadTokens ?? null, mu.cacheCreationTokens ?? null, mu.costUsd ?? null, mu.contextWindow ?? null,
        ownsContext ? result.contextTokens : null,
        ownsContext ? contextModel : null,
        ownsContext ? result.contextProvider ?? mu.upstreamProvider ?? null : null,
        ownsContext ? result.contextUsageSource ?? null : null,
        ownsContext ? result.contextUsageQuality ?? null : null
      ])
    }
  }
  return rows
}
