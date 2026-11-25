import { describe, expect, it } from 'vitest'
import type { QoderCreditScope } from './qoder-credits'
import { withQoderCredits } from './qoder-credits'
import { buildUsageAnalytics } from './span-ledger'

// Q12：本例验证没有账本记录、但有可折算为美元的 Qoder Credits 的日期也会补点。
const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const today = new Date(2026, 8, 9, 12).getTime()
const twoDaysAgo = new Date(2026, 8, 7, 12).getTime()
const scope = (tsStart: number, runId: string): QoderCreditScope => ({ sessionId, cwd: '/repo', runId, tsStart })
const creditRow = (tsStart: number, runId: string, credits: number) => ({
  ...scope(tsStart, runId),
  evidence: {
    credits, knownRequests: 1, missingRequests: 0, matchedTurns: 1, totalTurns: 1,
    source: 'qoder_native_transcript' as const, completeness: 'partial' as const
  }
})

describe('Qoder Credits 的每日补齐', () => {
  it('只有 Credits 没有账本记录的日子也补一个点', () => {
    const analytics = buildUsageAnalytics({
      nowMs: today, rangeDays: 7,
      tokens: [{
        tsStart: today, provider: 'qoder', model: 'model-a', inputTokens: 100, outputTokens: 20,
        cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, runId: 'run-today'
      }],
      costs: []
    })
    const enriched = withQoderCredits(analytics, [creditRow(today, 'run-today', 1), creditRow(twoDaysAgo, 'run-old', 2.5)])
    const daily = enriched.dailyByProvider.filter((row) => row.provider === 'qoder')
    expect(daily.map((row) => row.day)).toEqual(['2026-09-07', '2026-09-09'])
    expect(daily[0]).toMatchObject({ costUsd: 0.025, estimatedCostRows: 1, qoderCredits: { credits: 2.5 } })
    expect(daily[1]).toMatchObject({ costUsd: 0.01, turns: 1 })
    expect(enriched.dailyByProvider.filter((row) => row.provider === 'qoder')).toHaveLength(2)
    expect(enriched.dailyByAgent.find((row) => row.agent === 'qoder' && row.day === '2026-09-07')).toMatchObject({ costUsd: 0.025 })
  })

  it('按 Agent 的行也带上 Credit 折算的金额', () => {
    const analytics = buildUsageAnalytics({
      nowMs: today, rangeDays: 7,
      tokens: [{
        tsStart: today, provider: 'qoder', model: 'model-a', inputTokens: 100, outputTokens: 20,
        cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, runId: 'run-today'
      }],
      costs: []
    })
    const enriched = withQoderCredits(analytics, [creditRow(today, 'run-today', 2.5)])
    expect(enriched.byAgent.find((row) => row.agent === 'qoder')).toMatchObject({ costUsd: 0.025, costKnownRows: 1 })
    expect(enriched.byModel.find((row) => row.agent === 'qoder')).toMatchObject({ costUsd: 0.025 })
  })
})
