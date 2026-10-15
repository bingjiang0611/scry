import { describe, expect, it } from 'vitest'
import { officialApiCost } from './official-api-cost'
import { buildUsageAnalytics, type UsageAnalyticsTokenRow } from './span-ledger'

const row: UsageAnalyticsTokenRow = {
  tsStart: new Date(2026, 9, 15, 12).getTime(), provider: 'cc-switch', model: 'claude-opus-5-5',
  inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000,
  cacheWriteTokens: 100_000, reasoningTokens: 50_000, runId: 'run', officialCostEligible: 1
}

describe('official API standard-price equivalent', () => {
  it.each([
    ['claude-opus-5-5', 6.9], ['claude-opus-5', 9.125], ['claude-opus-4-8', 9.125]
  ])('prices %s with disjoint cache counters, without counting reasoning twice', (model, expected) => {
    expect(officialApiCost({ ...row, model })).toBeCloseTo(expected)
  })

  it('does not guess unknown models, missing input/output, or Qoder credit costs', () => {
    for (const patch of [{ model: 'claude-opus-unknown' }, { model: 'constructor' }, { model: null },
      { inputTokens: null }, { outputTokens: null }, { provider: 'qoder' }]) {
      expect(officialApiCost({ ...row, ...patch })).toBeNull()
    }
    expect(officialApiCost({ ...row, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0)
    expect(officialApiCost({ ...row, cacheReadTokens: null, cacheWriteTokens: null })).toBe(6)
  })

  it('projects estimates consistently without changing source tokens or inventing unknown costs', () => {
    const unknown = { ...row, model: 'unknown' }
    const analytics = buildUsageAnalytics({ nowMs: row.tsStart, rangeDays: 7, tokens: [row, unknown], costs: [] })
    for (const aggregate of [analytics.totals, analytics.byProvider[0], analytics.byDay.at(-1), analytics.dailyByProvider[0], analytics.byModel.find((entry) => entry.model === row.model)]) {
      expect(aggregate).toMatchObject({ costUsd: 6.9, estimatedCostRows: 1, officialApiCostRows: 1 })
    }
    expect(analytics.byModel.find((entry) => entry.model === 'unknown')?.costUsd).toBeNull()
    expect(row).not.toHaveProperty('costUsd')
  })

  it('only estimates rows the ledger query identifies as missing cost', () => {
    const analytics = buildUsageAnalytics({ nowMs: row.tsStart, rangeDays: 7,
      tokens: [{ ...row, officialCostEligible: 0 }],
      costs: [{ tsStart: row.tsStart, provider: row.provider, model: row.model, costUsd: 2, costSource: 'provider_reported', confidence: 'provider_reported' }] })
    expect(analytics.totals).toMatchObject({ costUsd: 2, estimatedCostRows: 0, providerReportedCostRows: 1 })
  })
})
