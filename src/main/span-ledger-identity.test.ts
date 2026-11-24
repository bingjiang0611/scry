import { describe, expect, it } from 'vitest'
import { buildUsageAnalytics } from './span-ledger'

// Q1、Q2、Q3、Q4：分组身份是 Agent → 模型，网关只作副标题；0 Token 的记录不成行。
const now = new Date(2026, 8, 3, 12).getTime()
const at = (daysAgo: number): number => new Date(2026, 8, 3 - daysAgo, 10).getTime()
type TokenRow = Parameters<typeof buildUsageAnalytics>[0]['tokens'][number]
const row = (p: Partial<TokenRow> & { tsStart: number }): TokenRow => ({
  provider: 'unknown', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null,
  cacheWriteTokens: null, reasoningTokens: null, runId: null, ...p
})

describe('Usage Analytics 身份与空记录', () => {
  it('按 Agent 分组：网关名只作网关，Claude 不叫 Anthropic', () => {
    const analytics = buildUsageAnalytics({
      nowMs: now,
      rangeDays: 7,
      tokens: [
        row({ tsStart: at(0), provider: 'codex', runtimeProvider: 'pi_rpc', upstreamProvider: 'openai-codex', model: 'model-a', inputTokens: 10, outputTokens: 5, runId: 'run-1' }),
        row({ tsStart: at(0), provider: 'cc-switch', runtimeProvider: 'pi_rpc', upstreamProvider: 'cc-switch', model: 'model-b', inputTokens: 10, outputTokens: 5, runId: 'run-2' }),
        row({ tsStart: at(1), provider: 'anthropic', runtimeProvider: 'claude_sdk', upstreamProvider: 'anthropic', model: 'model-c', inputTokens: 10, outputTokens: 5, runId: 'run-3' })
      ],
      costs: []
    })

    expect(analytics.byAgent.map((entry) => entry.agent)).toEqual(['pi', 'claude'])
    expect(analytics.byModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'pi', gateway: 'openai-codex', model: 'model-a' }),
      expect.objectContaining({ agent: 'pi', gateway: 'cc-switch', model: 'model-b' }),
      expect.objectContaining({ agent: 'claude', model: 'model-c' })
    ]))
    expect(analytics.byModel.find((entry) => entry.model === 'model-c')?.gateway).toBeUndefined()
    expect(analytics.dailyByAgent).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: '2026-09-03', agent: 'pi', turns: 2 }),
      expect.objectContaining({ day: '2026-09-02', agent: 'claude', turns: 1 })
    ]))
  })

  it('明确 0 Token 的记录不计入任何统计', () => {
    const analytics = buildUsageAnalytics({
      nowMs: now,
      rangeDays: 7,
      tokens: [
        row({ tsStart: at(0), provider: 'anthropic', runtimeProvider: 'claude_sdk', model: 'model-empty', inputTokens: 0, outputTokens: 0, runId: 'run-empty' }),
        row({ tsStart: at(0), provider: 'anthropic', runtimeProvider: 'claude_sdk', model: 'model-empty', inputTokens: null, outputTokens: null, runId: 'run-null' })
      ],
      costs: [
        { tsStart: at(0), provider: 'anthropic', model: 'model-empty', costUsd: 0, costSource: 'price_table', confidence: 'estimated', inputTokens: 0, outputTokens: 0 }
      ]
    })

    // 明确报 0 的轮次不成行、不算成本；完全没报 Token 的那行仍是「量未知」。
    expect(analytics.totals).toMatchObject({ turns: 1, usageRows: 1, costKnownRows: 0, costUsd: null, inputKnownRows: 0 })
    expect(analytics.byModel).toEqual([expect.objectContaining({ model: 'model-empty', usageRows: 1, costUsd: null, turns: 1 })])
    expect(analytics.byProvider).toHaveLength(1)
    expect(analytics.byDay.every((entry) => entry.costUsd === null)).toBe(true)
    expect(analytics.byDay.find((entry) => entry.day === '2026-09-03')?.turns).toBe(1)
  })

  it('没有活动的日子仍在每日行里，按本地日期排列', () => {
    const analytics = buildUsageAnalytics({
      nowMs: now,
      rangeDays: 7,
      tokens: [row({ tsStart: at(0), provider: 'codex', runtimeProvider: 'codex_cli', model: 'model-a', inputTokens: 10, outputTokens: 5, runId: 'run-1' })],
      costs: []
    })
    expect(analytics.byDay.map((entry) => entry.day)).toEqual([
      '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'
    ])
    expect(analytics.byDay.filter((entry) => entry.turns === 0)).toHaveLength(6)
  })
})
