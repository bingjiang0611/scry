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

describe('Codex 定价（Q6）', () => {
  it('按同一模型的目录单价给没有金额的轮次补上估算成本', () => {
    const analytics = buildUsageAnalytics({
      nowMs: now,
      rangeDays: 7,
      tokens: [
        row({
          tsStart: at(0), provider: 'codex', runtimeProvider: 'codex_cli', upstreamProvider: 'openai',
          model: 'model-x', inputTokens: 1_000_000, outputTokens: 100_000, runId: 'run-codex', officialCostEligible: 1
        })
      ],
      costs: [],
      prices: [{ id: 'catalog:model-x', provider: 'openai-codex', model: 'model-x', currency: 'USD',
        inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.4, cacheWritePerMillion: 5,
        effectiveFrom: 0, source: 'pi_model_catalog' }]
    })

    expect(analytics.totals).toMatchObject({ costKnownRows: 1, estimatedCostRows: 1 })
    expect(analytics.totals.costUsd).toBeCloseTo(1_000_000 * 4 / 1_000_000 + 100_000 * 20 / 1_000_000, 6)
    // 有金额的轮次不再重复叠加目录价。
    const twice = buildUsageAnalytics({
      nowMs: now, rangeDays: 7,
      tokens: [row({ tsStart: at(0), provider: 'codex', runtimeProvider: 'codex_cli', model: 'model-x', inputTokens: 1_000_000, outputTokens: 0, runId: 'run-1' })],
      costs: [{ tsStart: at(0), provider: 'codex', model: 'model-x', costUsd: 9, costSource: 'provider_reported', confidence: 'provider_reported' }],
      prices: [{ id: 'p', provider: 'openai-codex', model: 'model-x', currency: 'USD', inputPerMillion: 4, outputPerMillion: 20, effectiveFrom: 0 }]
    })
    expect(twice.totals.costUsd).toBe(9)
  })

  it('查不到价格的轮次成本留空，不参与占比', () => {
    const analytics = buildUsageAnalytics({
      nowMs: now, rangeDays: 7,
      tokens: [row({ tsStart: at(0), provider: 'codex', runtimeProvider: 'codex_cli', model: 'model-y', inputTokens: 10, outputTokens: 1, runId: 'run-1', officialCostEligible: 1 })],
      costs: []
    })
    expect(analytics.totals.costUsd).toBeNull()
    expect(analytics.byModel[0].costUsd).toBeNull()
  })
})

describe('Token 缓存口径（Q5）', () => {
  it('Codex 的输入把缓存减掉，Pi 与 Claude 的输入本来就不含缓存', () => {
    const analytics = buildUsageAnalytics({
      nowMs: now,
      rangeDays: 7,
      tokens: [
        // Codex app-server：输入 1000 里含 800 缓存。
        row({ tsStart: at(0), provider: 'codex', runtimeProvider: 'codex_cli', model: 'model-x', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, runId: 'run-1' }),
        // Pi 走 openai-codex：输入与缓存分开报，不减。
        row({ tsStart: at(0), provider: 'codex', runtimeProvider: 'pi_rpc', upstreamProvider: 'openai-codex', model: 'model-x', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, runId: 'run-2' })
      ],
      costs: []
    })

    const codex = analytics.byModel.find((entry) => entry.agent === 'codex')
    const pi = analytics.byModel.find((entry) => entry.agent === 'pi')
    expect(codex).toMatchObject({ inputTokens: 200, cacheReadTokens: 800 })
    expect(pi).toMatchObject({ inputTokens: 1000, cacheReadTokens: 800 })
    expect(analytics.totals.inputTokens).toBe(1200)
  })
})
