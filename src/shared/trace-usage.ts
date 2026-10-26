import type { BillingProvider } from './billing.js'
import type { ProviderId } from './provider.js'

export type CostSource =
  | 'sdk_estimate'
  | 'gateway_reported'
  | 'provider_reported'
  | 'provider_bill'
  | 'official_telemetry'
  | 'analytics_report'
  | 'price_table'
  | 'user_override'
export type CostConfidence = 'exact' | 'provider_reported' | 'estimated' | 'inferred'
export type CostUnit = 'usd' | 'credits' | 'token' | 'custom'

// P0：result 的 per-model 用量明细（SDK result.modelUsage 展开，落 model_usage 子表）。
export interface ModelUsageRow {
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
  reasoningTokens?: number
  costUsd?: number
  costSource?: CostSource
  costConfidence?: CostConfidence
  costUnit?: CostUnit
  contextWindow?: number
  billingProvider?: BillingProvider
  upstreamProvider?: string
  accountLabel?: string
  usageSource?: string
}

// B2/P0/P2：sqlite 跨会话分析结果（从 spans/model_usage 聚合），跨 main/preload/renderer 共用。
export interface DbStats {
  status?: 'ready' | 'unavailable' | 'query_error'
  totals: { cost: number | null; tin: number | null; tout: number | null; turns: number; toolCalls?: number; dangerEvents?: number }
  topTools: { tool: string; n: number; mcp: number }[]
  byCwd: { cwd: string; cost: number | null; turns: number }[]
  byModel: { model: string; tin: number | null; tout: number | null; cost: number | null }[]
  // P2 Analytics：工具耗时（墙钟推算）+ 成功率。avgMs 来自 tool_use→tool_result 墙钟差，errors=失败次数。
  toolStats: { tool: string; n: number; avgMs: number; errors: number }[]
  // P3 跨会话危险审计趋势：哪些危险操作最频繁（从 spans.danger_* 聚合）。
  dangerTrend: { reason: string; level: string; n: number }[]
  // Analytics v7：字段可选以兼容 dev/HMR 中旧 preload；main 的当前实现始终返回完整形状。
  tokenDaily?: {
    day: string
    input: number | null
    output: number | null
    cacheRead: number | null
    cacheWrite: number | null
    turns: number
    inputKnownTurns: number
    outputKnownTurns: number
    cacheReadKnownTurns: number
    cacheWriteKnownTurns: number
  }[]
  dangerDaily?: { day: string; danger: number; warn: number }[]
  comparison?: {
    current: { tokens: number | null; tokenKnownTurns: number; turns: number; toolCalls: number; danger: number }
    previous: { tokens: number | null; tokenKnownTurns: number; turns: number; toolCalls: number; danger: number }
    change: { tokensPct: number | null; turnsPct: number | null; toolCallsPct: number | null; dangerPct: number | null }
  }
  cacheReuse?: {
    providerId: ProviderId
    turns: number
    inputTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    inputKnownTurns: number
    cacheReadKnownTurns: number
    cacheWriteKnownTurns: number
    comparableTurns: number
    reuseRate: number | null
    denominator: 'separate_input' | 'input_includes_cache' | 'upstream_dependent' | 'unknown'
  }[]
  mcpLatency?: { server: string; calls: number; p50Ms: number | null; p95Ms: number | null; errors: number }[]
  providerCoverage?: {
    providerId: ProviderId
    turns: number
    inputKnownTurns: number
    outputKnownTurns: number
    cacheReadKnownTurns: number
    cacheWriteKnownTurns: number
    dangerCoverage: 'classified' | 'unsupported'
  }[]
  interventions?: {
    requested: number
    total: number
    answered: number
    cancelled: number
    questions: number
    clarification: number
    permission: number
    waitMs: number
  }
}

export type UsageAnalyticsRangeDays = 7 | 30 | 90

export interface QoderCreditEvidence {
  credits: number | null
  knownRequests: number
  missingRequests: number
  matchedTurns: number
  totalTurns: number
  source: 'qoder_native_transcript' | 'qoder_recorded_usage' | 'pi_qoder_credit_observation' | 'qoder_mixed_usage'
  omissionReason?: string
  // Only matched main-transcript requests; never a complete account bill.
  completeness: 'partial'
}

export interface UsageAnalyticsAggregate {
  qoderCredits?: QoderCreditEvidence
  officialApiCostRows?: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  costUsd: number | null
  turns: number
  usageRows: number
  inputKnownRows: number
  outputKnownRows: number
  cacheReadKnownRows: number
  cacheWriteKnownRows: number
  reasoningKnownRows: number
  tokenKnownRows: number
  costKnownRows: number
  exactCostRows: number
  providerReportedCostRows: number
  estimatedCostRows: number
  inferredCostRows: number
}

export interface UsageAnalyticsDayRow extends UsageAnalyticsAggregate {
  day: string
}

export interface UsageAnalyticsDailyProviderRow extends UsageAnalyticsDayRow {
  provider: BillingProvider
}

export interface UsageAnalyticsBreakdownRow extends UsageAnalyticsAggregate {
  provider: BillingProvider
  model: string | null
}

export interface UsageAnalytics {
  status: 'ready' | 'unavailable' | 'query_error'
  rangeDays: UsageAnalyticsRangeDays
  fromDay: string
  toDay: string
  observedAt: number
  days: string[]
  totals: UsageAnalyticsAggregate
  byDay: UsageAnalyticsDayRow[]
  dailyByProvider: UsageAnalyticsDailyProviderRow[]
  byProvider: UsageAnalyticsBreakdownRow[]
  byModel: UsageAnalyticsBreakdownRow[]
}

export interface UsageStats {
  status: 'ready' | 'partial' | 'unavailable' | 'query_error'
  cost: number | null
  tin: number | null
  tout: number | null
  turns: number
  invalidLines: number
  sourceBytes?: number
  error?: string
}
