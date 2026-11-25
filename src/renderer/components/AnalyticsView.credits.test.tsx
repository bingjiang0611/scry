import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnalyticsView } from './AnalyticsView'
import type { UsageAnalytics } from '@shared/trace'

const base = {
  inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  costUsd: null, turns: 1, usageRows: 1,
  inputKnownRows: 1, outputKnownRows: 1, cacheReadKnownRows: 0, cacheWriteKnownRows: 0, reasoningKnownRows: 0,
  tokenKnownRows: 1, costKnownRows: 0,
  exactCostRows: 0, providerReportedCostRows: 0, estimatedCostRows: 0, inferredCostRows: 0
}

function analytics(overrides: Partial<UsageAnalytics> = {}): UsageAnalytics {
  return {
    status: 'ready', rangeDays: 30, fromDay: '2026-09-09', toDay: '2026-09-09', observedAt: 1,
    days: ['2026-09-09'], totals: base,
    byDay: [{ day: '2026-09-09', ...base }],
    dailyByAgent: [{ day: '2026-09-09', agent: 'qoder', ...base }],
    dailyByProvider: [], byProvider: [],
    byAgent: [{ agent: 'qoder', ...base }],
    byModel: [{ agent: 'qoder', provider: 'qoder', gateway: undefined, model: 'model-q', ...base }],
    ...overrides
  }
}

const render = (data: UsageAnalytics, creditsPending = false): string => renderToStaticMarkup(
  <AnalyticsView analytics={data} rangeDays={30} loading={false} creditsPending={creditsPending}
    error={null} tab="cost" onRangeChange={() => {}} onRefresh={() => {}} />
)

describe('分析页的 Qoder Credits', () => {
  it('Credits 折算进成本，来源与覆盖写在提示里', () => {
    const credits = {
      credits: 2.5, knownRequests: 1, missingRequests: 0, matchedTurns: 1, totalTurns: 1,
      source: 'qoder_native_transcript' as const, completeness: 'partial' as const
    }
    const html = render(analytics({
      totals: { ...base, costUsd: 0.025, costKnownRows: 1, estimatedCostRows: 1, qoderCredits: credits },
      byAgent: [{ agent: 'qoder', ...base, costUsd: 0.025, costKnownRows: 1, estimatedCostRows: 1, qoderCredits: credits }],
      byModel: [{ agent: 'qoder', provider: 'qoder', gateway: undefined, model: 'model-q', ...base,
        costUsd: 0.025, costKnownRows: 1, estimatedCostRows: 1, qoderCredits: credits }]
    }))
    expect(html).toContain('$0.03')
    expect(html).toContain('2.5 Credits')
    expect(html).toContain('原生 Credits · 已知下界；1/1 轮已关联')
  })

  it('Credits 还没算完时只说正在计算，不写成不可用', () => {
    const html = render(analytics(), true)
    expect(html).toContain('正在计算 Credit')
    expect(html).not.toContain('—')
  })

  it('没有 Credit 证据时不显示 Credit 文案', () => {
    const html = render(analytics())
    expect(html).not.toContain('Credits')
  })

  it('没有轮次的模型不成行，未定价的成本格留空', () => {
    const html = render(analytics({
      byModel: [
        { agent: 'qoder', provider: 'qoder', gateway: undefined, model: 'model-q', ...base },
        { agent: 'qoder', provider: 'qoder', gateway: undefined, model: 'model-empty', ...base, turns: 0, inputTokens: null, outputTokens: null }
      ]
    }))
    expect(html).not.toContain('model-empty')
    expect(html).toContain('model-q')
    expect(html).toContain('查不到这个模型的价格')
    expect(html).not.toContain('$0.00')
  })
})
