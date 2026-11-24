// Usage Analytics 与 canonical billing 去重 SQL / 聚合纯函数。
import type { UsageAnalytics, UsageAnalyticsAggregate, UsageAnalyticsRangeDays } from '../shared/trace'
import type { BillingConfidence, BillingCostSource, BillingProvider } from '../shared/billing'
import { usageIdentity, type UsageAgentId } from '../shared/usage-identity'
import { estimatedCostFromPrice, priceForRow, type ModelPrice } from '../shared/model-price'
import { officialApiCost } from './official-api-cost'
import { localDay, startOfLocalDay } from './span-ledger-analytics'

export const canonicalCostWhere = (a = 'usage_ledger', peerScope?: string): string => {
  const scopedPeer = peerScope ? ` AND (${peerScope})` : ''
  return `(
  ${a}.cost IS NOT NULL AND (
    ${a}.cost_source='provider_bill'
    OR (${a}.cost_source IN ('gateway_reported','provider_reported') AND NOT EXISTS (
      SELECT 1 FROM usage_ledger b
      WHERE b.provider=${a}.provider AND b.cost_unit=${a}.cost_unit${scopedPeer}
        AND (b.account_label IS NULL OR ${a}.account_label IS NULL OR b.account_label=${a}.account_label)
        AND (b.bucket_start IS NULL OR ${a}.bucket_start IS NULL OR (
          b.bucket_start <= COALESCE(${a}.bucket_end, ${a}.bucket_start)
          AND ${a}.bucket_start <= COALESCE(b.bucket_end, b.bucket_start)
        ))
        AND b.cost_source='provider_bill' AND b.cost IS NOT NULL
    ))
    OR (${a}.cost_source IN ('sdk_estimate','price_table') AND NOT EXISTS (
      SELECT 1 FROM usage_ledger b
      WHERE b.provider=${a}.provider AND b.cost_unit=${a}.cost_unit${scopedPeer}
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
}

// 现有 rollup / preflight / showback 契约都是美元金额；Credits 只在带 costUnit 的对账中展示。
export const canonicalUsdCostWhere = (a = 'usage_ledger'): string =>
  `(${canonicalCostWhere(a)} AND ${a}.cost_unit='usd')`
const canonicalSessionUsdCostWhere = (a: string): string =>
  `(${a}.session_id IS NOT NULL AND ${canonicalCostWhere(a, 'b.session_id IS NOT NULL')} AND ${a}.cost_unit='usd')`

// 0 Token 的记录是空记录：它不该成行、不该计入轮次，也不该被价格表算成 $0.00。
export const USAGE_TOKENS_PRESENT_SQL = (a: string): string =>
  `(COALESCE(${a}.input_tokens,0)+COALESCE(${a}.output_tokens,0)+COALESCE(${a}.cache_read_tokens,0)+COALESCE(${a}.cache_write_tokens,0)+COALESCE(${a}.reasoning_tokens,0))>0`

export const USAGE_ANALYTICS_TOKENS_SQL = `SELECT
  bucket_start tsStart, provider, model,
  input_tokens inputTokens, output_tokens outputTokens,
  cache_read_tokens cacheReadTokens, cache_write_tokens cacheWriteTokens,
  reasoning_tokens reasoningTokens, run_id runId,
  json_extract(u.metadata_json,'$.runtimeProvider') runtimeProvider,
  json_extract(u.metadata_json,'$.upstreamProvider') upstreamProvider,
  (u.usage_kind='model' AND u.cost IS NULL AND u.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM usage_ledger b
    WHERE b.session_id=u.session_id AND b.run_id=u.run_id AND b.provider=u.provider
      AND b.cost IS NOT NULL AND b.cost_unit='usd'
      AND (b.model IS NULL OR b.model=u.model)
  )) officialCostEligible
  FROM usage_ledger u
  WHERE session_id IS NOT NULL AND bucket_start>=? AND bucket_start<?
    AND (u.usage_kind!='credits' OR NOT EXISTS (
      SELECT 1 FROM usage_ledger b WHERE b.session_id=u.session_id AND b.run_id=u.run_id
        AND b.provider=u.provider AND b.usage_kind!='credits'
    ))`
export const USAGE_ANALYTICS_COSTS_SQL = `SELECT
  u.bucket_start tsStart, u.provider, u.model,
  u.cost costUsd, u.cost_source costSource, u.confidence confidence,
  u.input_tokens inputTokens, u.output_tokens outputTokens, u.cache_read_tokens cacheReadTokens,
  u.cache_write_tokens cacheWriteTokens, u.reasoning_tokens reasoningTokens,
  json_extract(u.metadata_json,'$.runtimeProvider') runtimeProvider,
  json_extract(u.metadata_json,'$.upstreamProvider') upstreamProvider
  FROM usage_ledger u
  WHERE u.bucket_start>=? AND u.bucket_start<?
    AND ${canonicalSessionUsdCostWhere('u')}
    AND ${USAGE_TOKENS_PRESENT_SQL('u')}`

export interface UsageAnalyticsTokenRow {
  // Query proves no existing model/whole-turn USD cost would be double counted.
  officialCostEligible?: number
  tsStart: number
  provider: BillingProvider
  runtimeProvider?: string | null
  upstreamProvider?: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  runId: string | null
}

export interface UsageAnalyticsCostRow {
  tsStart: number
  provider: BillingProvider
  runtimeProvider?: string | null
  upstreamProvider?: string | null
  model: string | null
  costUsd: number
  costSource: BillingCostSource
  confidence: BillingConfidence
  officialApiEstimate?: boolean
  /** 来自 model_price_versions（Pi 模型目录）的单价，不是官方静态价表。 */
  catalogPriceId?: string
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
}

// 0 Token 的记录没有可展示的量；「没有上报」与「上报了 0」要分开处理。
type TokenCounters = Pick<UsageAnalyticsCostRow, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'>

const reportedTokens = (row: TokenCounters): number[] =>
  [row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.reasoningTokens]
    .filter((value): value is number => value != null)

// 明确报了全 0 的记录不成行；完全没报 Token 的保留为「量未知」，不能假装是 0。
const tokenRowHasUsage = (row: TokenCounters): boolean => {
  const tokens = reportedTokens(row)
  return tokens.length === 0 || tokens.some((value) => value > 0)
}

// 成本行可能来自账单导入，本来就没有 Token 字段；只有明确报 0 才丢弃。
const costRowHasUsage = tokenRowHasUsage

interface UsageAccumulator {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
  inputKnownRows: number
  outputKnownRows: number
  cacheReadKnownRows: number
  cacheWriteKnownRows: number
  reasoningKnownRows: number
  usageRows: number
  tokenKnownRows: number
  costKnownRows: number
  exactCostRows: number
  providerReportedCostRows: number
  estimatedCostRows: number
  inferredCostRows: number
  officialApiCostRows: number
  runs: Set<string>
}

const emptyUsageAccumulator = (): UsageAccumulator => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  inputKnownRows: 0,
  outputKnownRows: 0,
  cacheReadKnownRows: 0,
  cacheWriteKnownRows: 0,
  reasoningKnownRows: 0,
  usageRows: 0,
  tokenKnownRows: 0,
  costKnownRows: 0,
  exactCostRows: 0,
  providerReportedCostRows: 0,
  estimatedCostRows: 0,
  inferredCostRows: 0,
  officialApiCostRows: 0,
  runs: new Set<string>()
})

const addUsageTokenRow = (target: UsageAccumulator, row: UsageAnalyticsTokenRow): void => {
  target.usageRows++
  if (row.runId) target.runs.add(row.runId)
  if (row.inputTokens != null) {
    target.inputTokens += row.inputTokens
    target.inputKnownRows++
  }
  if (row.outputTokens != null) {
    target.outputTokens += row.outputTokens
    target.outputKnownRows++
  }
  if (row.cacheReadTokens != null) {
    target.cacheReadTokens += row.cacheReadTokens
    target.cacheReadKnownRows++
  }
  if (row.cacheWriteTokens != null) {
    target.cacheWriteTokens += row.cacheWriteTokens
    target.cacheWriteKnownRows++
  }
  if (row.reasoningTokens != null) {
    target.reasoningTokens += row.reasoningTokens
    target.reasoningKnownRows++
  }
  if (row.inputTokens != null || row.outputTokens != null) target.tokenKnownRows++
}

const addUsageCostRow = (target: UsageAccumulator, row: UsageAnalyticsCostRow): void => {
  target.costUsd += row.costUsd
  target.costKnownRows++
  if (row.officialApiEstimate) target.officialApiCostRows++
  if (row.confidence === 'exact') target.exactCostRows++
  else if (row.confidence === 'provider_reported') target.providerReportedCostRows++
  else if (row.confidence === 'estimated') target.estimatedCostRows++
  else target.inferredCostRows++
}

const usageAggregate = (value: UsageAccumulator): UsageAnalyticsAggregate => ({
  inputTokens: value.inputKnownRows > 0 ? value.inputTokens : null,
  outputTokens: value.outputKnownRows > 0 ? value.outputTokens : null,
  cacheReadTokens: value.cacheReadKnownRows > 0 ? value.cacheReadTokens : null,
  cacheWriteTokens: value.cacheWriteKnownRows > 0 ? value.cacheWriteTokens : null,
  reasoningTokens: value.reasoningKnownRows > 0 ? value.reasoningTokens : null,
  costUsd: value.costKnownRows > 0 ? value.costUsd : null,
  turns: value.runs.size,
  usageRows: value.usageRows,
  inputKnownRows: value.inputKnownRows,
  outputKnownRows: value.outputKnownRows,
  cacheReadKnownRows: value.cacheReadKnownRows,
  cacheWriteKnownRows: value.cacheWriteKnownRows,
  reasoningKnownRows: value.reasoningKnownRows,
  tokenKnownRows: value.tokenKnownRows,
  costKnownRows: value.costKnownRows,
  exactCostRows: value.exactCostRows,
  providerReportedCostRows: value.providerReportedCostRows,
  estimatedCostRows: value.estimatedCostRows,
  inferredCostRows: value.inferredCostRows,
  ...(value.officialApiCostRows > 0 ? { officialApiCostRows: value.officialApiCostRows } : {})
})

export function usageAnalyticsBounds(nowMs: number, rangeDays: UsageAnalyticsRangeDays): { from: number; to: number; days: string[] } {
  const today = startOfLocalDay(nowMs)
  const from = new Date(new Date(today).setDate(new Date(today).getDate() - rangeDays + 1)).getTime()
  const to = new Date(new Date(today).setDate(new Date(today).getDate() + 1)).getTime()
  const days = Array.from({ length: rangeDays }, (_, index) => {
    const value = new Date(new Date(from).setDate(new Date(from).getDate() + index)).getTime()
    return localDay(value)
  })
  return { from, to, days }
}

export function buildUsageAnalytics(args: {
  nowMs: number
  rangeDays: UsageAnalyticsRangeDays
  tokens: UsageAnalyticsTokenRow[]
  costs: UsageAnalyticsCostRow[]
  prices?: readonly ModelPrice[]
}): UsageAnalytics {
  const bounds = usageAnalyticsBounds(args.nowMs, args.rangeDays)
  const total = emptyUsageAccumulator()
  const providers = new Map<BillingProvider, UsageAccumulator>()
  const agents = new Map<UsageAgentId, UsageAccumulator>()
  const models = new Map<string, { provider: BillingProvider; agent: UsageAgentId; gateway?: string; model: string | null; value: UsageAccumulator }>()
  const days = new Map<string, UsageAccumulator>()
  const daily = new Map<string, { day: string; provider: BillingProvider; value: UsageAccumulator }>()
  const dailyAgent = new Map<string, { day: string; agent: UsageAgentId; value: UsageAccumulator }>()
  const targetFor = <K>(map: Map<K, UsageAccumulator>, key: K): UsageAccumulator => {
    const current = map.get(key)
    if (current) return current
    const created = emptyUsageAccumulator()
    map.set(key, created)
    return created
  }
  // 行按 Agent → 模型分组；网关只作副标题，不参与分组身份之外的判断。
  const modelTarget = (row: { provider: BillingProvider; runtimeProvider?: string | null; upstreamProvider?: string | null; model: string | null }): UsageAccumulator => {
    const normalizedModel = row.model?.trim() || null
    const identity = usageIdentity(row)
    const key = `${identity.agent}\0${identity.gateway ?? ''}\0${normalizedModel ?? ''}`
    const current = models.get(key)
    if (current) return current.value
    const value = emptyUsageAccumulator()
    models.set(key, { provider: row.provider, agent: identity.agent, ...(identity.gateway ? { gateway: identity.gateway } : {}), model: normalizedModel, value })
    return value
  }
  const agentTarget = (agent: UsageAgentId): UsageAccumulator => {
    const current = agents.get(agent)
    if (current) return current
    const value = emptyUsageAccumulator()
    agents.set(agent, value)
    return value
  }
  const dailyAgentTarget = (day: string, agent: UsageAgentId): UsageAccumulator => {
    const key = `${day}\0${agent}`
    const current = dailyAgent.get(key)
    if (current) return current.value
    const value = emptyUsageAccumulator()
    dailyAgent.set(key, { day, agent, value })
    return value
  }
  const dailyTarget = (day: string, provider: BillingProvider): UsageAccumulator => {
    const key = `${day}\0${provider}`
    const current = daily.get(key)
    if (current) return current.value
    const value = emptyUsageAccumulator()
    daily.set(key, { day, provider, value })
    return value
  }

  // 0 Token 的记录不成行，也不计入轮次：它没有可展示的量。
  const tokens = args.tokens.filter(tokenRowHasUsage)
  for (const row of tokens) {
    const day = localDay(row.tsStart)
    const identity = usageIdentity(row)
    addUsageTokenRow(total, row)
    addUsageTokenRow(targetFor(providers, row.provider), row)
    addUsageTokenRow(agentTarget(identity.agent), row)
    addUsageTokenRow(modelTarget(row), row)
    addUsageTokenRow(targetFor(days, day), row)
    addUsageTokenRow(dailyTarget(day, row.provider), row)
    addUsageTokenRow(dailyAgentTarget(day, identity.agent), row)
  }
  // Estimate at read time so existing history benefits without rewriting ledger evidence.
  const costs = args.costs.filter(costRowHasUsage)
  for (const row of tokens) {
    if (!row.officialCostEligible) continue
    const official = officialApiCost(row)
    if (official != null) {
      costs.push({ ...row, costUsd: official, costSource: 'price_table', confidence: 'estimated', officialApiEstimate: true })
      continue
    }
    // 官方静态价表没有这个模型时，查本地价格表（Pi 模型目录写进来的单价）。
    const price = priceForRow(row, args.prices)
    const costUsd = price ? estimatedCostFromPrice(row, price) : null
    if (price && costUsd != null) {
      costs.push({ ...row, costUsd, costSource: 'price_table', confidence: 'estimated', catalogPriceId: price.id })
    }
  }
  for (const row of costs) {
    const day = localDay(row.tsStart)
    const identity = usageIdentity(row)
    addUsageCostRow(total, row)
    addUsageCostRow(targetFor(providers, row.provider), row)
    addUsageCostRow(agentTarget(identity.agent), row)
    addUsageCostRow(modelTarget(row), row)
    addUsageCostRow(targetFor(days, day), row)
    addUsageCostRow(dailyTarget(day, row.provider), row)
    addUsageCostRow(dailyAgentTarget(day, identity.agent), row)
  }

  const rank = (value: UsageAccumulator): number => value.costUsd || value.inputTokens + value.outputTokens
  return {
    status: 'ready',
    rangeDays: args.rangeDays,
    fromDay: bounds.days[0],
    toDay: bounds.days.at(-1)!,
    observedAt: args.nowMs,
    days: bounds.days,
    totals: usageAggregate(total),
    byDay: bounds.days.map((day) => ({ day, ...usageAggregate(days.get(day) ?? emptyUsageAccumulator()) })),
    dailyByProvider: [...daily.values()]
      .sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider))
      .map((row) => ({ day: row.day, provider: row.provider, ...usageIdentity(row), ...usageAggregate(row.value) })),
    dailyByAgent: [...dailyAgent.values()]
      .sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent))
      .map((row) => ({ day: row.day, agent: row.agent, ...usageAggregate(row.value) })),
    byProvider: [...providers.entries()]
      .sort((a, b) => rank(b[1]) - rank(a[1]))
      .map(([provider, value]) => ({ provider, model: null, ...usageIdentity({ provider }), ...usageAggregate(value) })),
    byAgent: [...agents.entries()]
      .sort((a, b) => rank(b[1]) - rank(a[1]))
      .map(([agent, value]) => ({ agent, ...usageAggregate(value) })),
    byModel: [...models.values()]
      .sort((a, b) => rank(b.value) - rank(a.value))
      .map((row) => ({ provider: row.provider, agent: row.agent, ...(row.gateway ? { gateway: row.gateway } : {}), model: row.model, ...usageAggregate(row.value) }))
  }
}
