import type { UsageAnalytics, UsageAnalyticsAggregate, UsageAnalyticsRangeDays } from '@shared/trace'
import type { UsageAgentId } from '@shared/usage-identity'
import { tokensOf } from './analytics-format'

export type AnalyticsTab = 'performance' | 'cost'
export type CostMetric = 'cost' | 'tokens'
export type AgentFilter = UsageAgentId | 'all'
export type PerformanceRange = 1 | 24 | 168 | 720

export const PERFORMANCE_RANGES: readonly PerformanceRange[] = [1, 24, 168, 720]
export const COST_RANGES: readonly UsageAnalyticsRangeDays[] = [1, 7, 30, 90]
export const DEFAULT_PERFORMANCE_RANGE: PerformanceRange = 24
export const DEFAULT_COST_RANGE: UsageAnalyticsRangeDays = 30

/** 两个标签的时间范围各有自己的刻度；只有含义相同的范围才在两页之间保留。 */
export function costRangeFor(hours: PerformanceRange): UsageAnalyticsRangeDays {
  if (hours === 24) return 1
  if (hours === 168) return 7
  if (hours === 720) return 30
  return DEFAULT_COST_RANGE
}
export function performanceRangeFor(days: UsageAnalyticsRangeDays): PerformanceRange {
  if (days === 1) return 24
  if (days === 7) return 168
  if (days === 30) return 720
  return DEFAULT_PERFORMANCE_RANGE
}

const costOf = (row: UsageAnalyticsAggregate): number | null => row.costUsd
const pricedOf = (row: UsageAnalyticsAggregate): number => row.costKnownRows

export type AgentTableRow = {
  kind: 'agent' | 'model'
  key: string
  agent: UsageAgentId
  name: string
  gateway?: string
  turns: number
  tokens: number | null
  costUsd: number | null
  pricedTurns: number
  share: number | null
  evidence: UsageAnalyticsAggregate
}

/**
 * 按 Agent 分组的表：Agent 一行，下面缩进列出它的模型；网关只作为模型的副标题，
 * 不当成分组。没有轮次的组合不成行（Q7/Q13）。
 */
export function agentTable(analytics: UsageAnalytics, filter: AgentFilter = 'all'): AgentTableRow[] {
  const keep = (agent: UsageAgentId): boolean => filter === 'all' || filter === agent
  const totalCost = analytics.totals.costUsd
  const models = new Map<string, AgentTableRow[]>()
  for (const row of analytics.byModel) {
    const agent = row.agent
    if (!agent || !keep(agent) || row.turns === 0) continue
    const entry: AgentTableRow = {
      kind: 'model', key: `model:${agent}:${row.model ?? ''}:${row.gateway ?? ''}`, agent,
      name: row.model ?? '', gateway: row.gateway, turns: row.turns,
      tokens: tokensOf(row), costUsd: costOf(row), pricedTurns: pricedOf(row),
      share: row.costUsd == null || totalCost == null || totalCost <= 0 ? null : row.costUsd / totalCost,
      evidence: row
    }
    if (!entry.name) continue
    const list = models.get(agent) ?? []
    list.push(entry)
    models.set(agent, list)
  }
  const rows: AgentTableRow[] = []
  const agents = [...analytics.byAgent].filter((row) => keep(row.agent) && row.turns > 0)
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.turns - a.turns)
  for (const agent of agents) {
    rows.push({
      kind: 'agent', key: `agent:${agent.agent}`, agent: agent.agent, name: agent.agent,
      turns: agent.turns, tokens: tokensOf(agent), costUsd: agent.costUsd, pricedTurns: pricedOf(agent),
      share: agent.costUsd == null || totalCost == null || totalCost <= 0 ? null : agent.costUsd / totalCost,
      evidence: agent
    })
    const children = models.get(agent.agent) ?? []
    rows.push(...children.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || (b.tokens ?? 0) - (a.tokens ?? 0)))
  }
  return rows
}

export type DailySeries = { agent: UsageAgentId; values: (number | null)[] }

/**
 * 每日曲线：按日期补齐所有日子。没有活动的日子画 0；有记录但该指标未知的
 * 日子留空（未知不是 0），由图表断开。
 */
export function dailySeries(analytics: UsageAnalytics, metric: CostMetric, filter: AgentFilter = 'all'): DailySeries[] {
  const agents = [...new Set(analytics.dailyByAgent.map((row) => row.agent))].filter((agent) => filter === 'all' || filter === agent)
  return agents.map((agent) => {
    const byDay = new Map(analytics.dailyByAgent.filter((row) => row.agent === agent).map((row) => [row.day, row]))
    return {
      agent,
      values: analytics.days.map((day) => {
        const row = byDay.get(day)
        if (!row) return 0
        return metric === 'cost' ? row.costUsd : tokensOf(row)
      })
    }
  }).filter((series) => series.values.some((value) => value != null && value > 0))
}

export function chartMax(series: readonly DailySeries[]): number {
  const values = series.flatMap((item) => item.values).filter((value): value is number => value != null)
  return Math.max(0, ...values)
}

export function totalTokens(analytics: UsageAnalytics): number | null {
  return tokensOf(analytics.totals)
}

/** 平均每轮 = 总额 ÷ 已定价的轮次；没有已定价轮次时不显示。 */
export function averageCost(analytics: UsageAnalytics): number | null {
  const cost = analytics.totals.costUsd
  const priced = analytics.totals.costKnownRows
  if (cost == null || priced === 0) return null
  return cost / priced
}

/** 模型的网关副标题来自用量记录；性能样本只按 Agent 与模型对齐。 */
export function gatewayLookup(analytics: UsageAnalytics | undefined): (agent?: string, model?: string) => string | undefined {
  const table = new Map<string, string>()
  for (const row of analytics?.byModel ?? []) {
    if (!row.agent || !row.model || !row.gateway) continue
    const key = `${row.agent}\u0000${row.model}`
    if (!table.has(key)) table.set(key, row.gateway)
  }
  return (agent, model) => (agent && model ? table.get(`${agent}\u0000${model}`) : undefined)
}

/** 筛选下拉只列出受支持且用量账本中有轮次的 Agent。 */
export function agentOptions(analytics: UsageAnalytics | undefined, agents: readonly UsageAgentId[]): UsageAgentId[] {
  const observed = new Set<UsageAgentId>(analytics?.byAgent.filter((row) => row.turns > 0).map((row) => row.agent) ?? [])
  return agents.filter((agent) => observed.has(agent))
}
