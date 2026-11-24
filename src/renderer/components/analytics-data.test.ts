import { describe, expect, it } from 'vitest'
import type { UsageAnalytics } from '@shared/trace'
import { agentTable, averageCost, costRangeFor, dailySeries, gatewayLookup, performanceRangeFor } from './analytics-data'

const base = {
  inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  costUsd: null, turns: 1, usageRows: 1,
  inputKnownRows: 1, outputKnownRows: 1, cacheReadKnownRows: 0, cacheWriteKnownRows: 0, reasoningKnownRows: 0,
  tokenKnownRows: 1, costKnownRows: 0,
  exactCostRows: 0, providerReportedCostRows: 0, estimatedCostRows: 0, inferredCostRows: 0
}

const analytics = (overrides: Partial<UsageAnalytics> = {}): UsageAnalytics => ({
  status: 'ready', rangeDays: 7, fromDay: '2026-09-07', toDay: '2026-09-09', observedAt: 1,
  days: ['2026-09-07', '2026-09-08', '2026-09-09'],
  totals: base, byDay: [], dailyByProvider: [], byProvider: [], dailyByAgent: [], byAgent: [], byModel: [],
  ...overrides
})

describe('分析页的数据整形', () => {
  it('按 Agent → 模型排序，网关只作副标题，没有轮次的行不出现', () => {
    const rows = agentTable(analytics({
      byAgent: [{ agent: 'pi', ...base, turns: 3 },
        { agent: 'claude', ...base, turns: 2, costUsd: 2, costKnownRows: 2 }],
      byModel: [
        { agent: 'pi', provider: 'codex', gateway: 'openai-codex', model: 'model-a', ...base, turns: 3 },
        { agent: 'claude', provider: 'anthropic', gateway: undefined, model: 'model-b', ...base, turns: 2, costUsd: 2, costKnownRows: 2 },
        { agent: 'pi', provider: 'codex', gateway: 'openai-codex', model: 'model-empty', ...base, turns: 0 }
      ]
    }))
    expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual(['agent:claude', 'model:model-b', 'agent:pi', 'model:model-a'])
    expect(rows[1].gateway).toBeUndefined()
    expect(rows[3].gateway).toBe('openai-codex')
  })

  it('按 Agent 筛选只留下这个 Agent 的行', () => {
    const rows = agentTable(analytics({
      byAgent: [{ agent: 'pi', ...base, turns: 3 }, { agent: 'claude', ...base, turns: 2 }],
      byModel: [
        { agent: 'pi', provider: 'codex', gateway: undefined, model: 'model-a', ...base, turns: 3 },
        { agent: 'claude', provider: 'anthropic', gateway: undefined, model: 'model-b', ...base, turns: 2 }
      ]
    }), 'claude')
    expect(rows.map((row) => row.name)).toEqual(['claude', 'model-b'])
  })

  it('每日曲线补齐没有活动的日子画 0，未知价格留空', () => {
    const series = dailySeries(analytics({
      dailyByAgent: [
        { day: '2026-09-07', agent: 'pi', ...base, costUsd: 1, costKnownRows: 1 },
        { day: '2026-09-09', agent: 'pi', ...base, costUsd: null }
      ]
    }), 'cost')
    expect(series).toHaveLength(1)
    expect(series[0].values).toEqual([1, 0, null])
  })

  it('平均每轮用已定价的轮次做分母', () => {
    expect(averageCost(analytics({ totals: { ...base, costUsd: 3, costKnownRows: 2 } }))).toBe(1.5)
    expect(averageCost(analytics({ totals: { ...base, costUsd: 3, costKnownRows: 0 } }))).toBeNull()
  })

  it('两页的时间范围只在含义相同时沿用，否则用那一页的默认值', () => {
    expect(costRangeFor(24)).toBe(1)
    expect(costRangeFor(168)).toBe(7)
    expect(costRangeFor(720)).toBe(30)
    expect(costRangeFor(1)).toBe(30)
    expect(performanceRangeFor(1)).toBe(24)
    expect(performanceRangeFor(7)).toBe(168)
    expect(performanceRangeFor(30)).toBe(720)
    expect(performanceRangeFor(90)).toBe(24)
  })

  it('网关来自用量记录的 Agent + 模型，找不到就留空', () => {
    const lookup = gatewayLookup(analytics({
      byModel: [{ agent: 'pi', provider: 'codex', gateway: 'openai-codex', model: 'model-a', ...base, turns: 1 }]
    }))
    expect(lookup('pi', 'model-a')).toBe('openai-codex')
    expect(lookup('pi', 'model-b')).toBeUndefined()
    expect(lookup(undefined, 'model-a')).toBeUndefined()
  })
})
