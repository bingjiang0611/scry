import { describe, expect, it } from 'vitest'
import type { QoderCreditScope } from './qoder-credits'
import { withQoderCredits } from './qoder-credits'
import { buildUsageAnalytics } from './span-ledger'

// Q12：Qoder 的 Credits 按日期补齐——没有账本记录但有 Credits 的日子也要有点。
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
    // 补齐的当天只多一行；没有 Credits 的日子仍然没有点。
    expect(enriched.dailyByProvider.filter((row) => row.provider === 'qoder')).toHaveLength(2)
    expect(enriched.dailyByAgent.find((row) => row.agent === 'qoder' && row.day === '2026-09-07')).toMatchObject({ costUsd: 0.025 })
  })
})
