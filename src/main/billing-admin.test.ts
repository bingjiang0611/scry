import { describe, expect, it } from 'vitest'
import { adminKeyStatus, fetchAnthropicAdminUsageAndCosts, fetchOpenAiAdminUsageAndCosts, fetchQoderUsageAndCosts } from './billing-admin'
import { USAGE_LEDGER_COLS } from './span-ledger'

const asLedger = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(USAGE_LEDGER_COLS.map((c, i) => [c, row[i]]))

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

describe('Billing Guardian P1 Admin connector', () => {
  it('只报告 key 是否存在，不泄露 key 值', () => {
    expect(adminKeyStatus({ ANTHROPIC_ADMIN_API_KEY: 'sk-ant-secret', OPENAI_ADMIN_API_KEY: '' })).toEqual({
      anthropic: true,
      openai: false,
      qoder: false
    })
  })

  it('OpenAI Admin usage/costs 支持 pagination 并导入两类 ledger 行', async () => {
    const urls: string[] = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      urls.push(input)
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' })
      const url = new URL(input)
      if (url.pathname.endsWith('/usage/completions') && !url.searchParams.get('page')) {
        return jsonResponse({
          data: [{ start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-02T00:00:00Z', model: 'gpt-5', input_tokens: 10, output_tokens: 5 }],
          has_more: true,
          next_page: 'p2'
        })
      }
      if (url.pathname.endsWith('/usage/completions')) {
        return jsonResponse({
          data: [{ start_time: '2026-07-02T00:00:00Z', end_time: '2026-07-03T00:00:00Z', model: 'gpt-5', input_tokens: 11, output_tokens: 6 }],
          has_more: false
        })
      }
      return jsonResponse({
        data: [{ start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-02T00:00:00Z', amount: { value: 0.03, currency: 'usd' } }],
        has_more: false
      })
    }
    const result = await fetchOpenAiAdminUsageAndCosts({
      apiKey: 'test-key',
      startTime: 1782864000,
      endTime: 1783036800,
      fetchImpl,
      nowMs: 1783000000000
    })
    expect(urls).toHaveLength(3)
    expect(urls.some((u) => u.includes('page=p2'))).toBe(true)
    expect(result.rawPayloadCount).toBe(3)
    expect(result.rows.providerRawUsage).toHaveLength(3)
    expect(result.rows.usageLedger.map(asLedger).map((r) => r.cost_source)).toEqual([
      'official_telemetry',
      'official_telemetry',
      'provider_bill'
    ])
  })

  it('OpenAI Admin HTTP error 保留状态码但不包含密钥', async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ error: { message: 'denied' } }, 403)
    await expect(
      fetchOpenAiAdminUsageAndCosts({ apiKey: 'test-key', startTime: 1, fetchImpl, nowMs: 1 })
    ).rejects.toThrow('HTTP 403')
    await expect(
      fetchOpenAiAdminUsageAndCosts({ apiKey: 'test-key', startTime: 1, fetchImpl, nowMs: 1 })
    ).rejects.not.toThrow('test-key')
  })

  it('Anthropic Admin 使用官方组织 usage/cost endpoint 和 anthropic-version header', async () => {
    const urls: string[] = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      urls.push(input)
      expect(init?.headers).toMatchObject({ 'x-api-key': 'ant-admin', 'anthropic-version': '2023-06-01' })
      return jsonResponse({
        data: [
          {
            starting_at: '2026-07-01T00:00:00Z',
            ending_at: '2026-07-02T00:00:00Z',
            results: [{ uncached_input_tokens: 10, output_tokens: 2, requests: 1, cost_usd: 0.02 }]
          }
        ],
        has_more: false
      })
    }
    const result = await fetchAnthropicAdminUsageAndCosts({
      apiKey: 'ant-admin',
      startingAt: '2026-07-01T00:00:00Z',
      endingAt: '2026-07-02T00:00:00Z',
      fetchImpl,
      nowMs: 1783000000000
    })
    expect(urls[0]).toContain('/v1/organizations/usage_report/messages')
    expect(urls[1]).toContain('/v1/organizations/cost_report')
    expect(result.rows.providerRawUsage).toHaveLength(2)
    expect(result.rows.usageLedger.map(asLedger).map((r) => r.cost_source)).toEqual([
      'official_telemetry',
      'provider_bill'
    ])
  })

  it('Qoder Teams usage 只导入 Credits 账单且支持 member cursor', async () => {
    const urls: string[] = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      urls.push(input)
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer qoder-admin' })
      const cursor = new URL(input).searchParams.get('nextCredits')
      return jsonResponse(cursor
        ? { usages: [{ timestamp: 2, userId: 'u1', source: 'CLI', operation: 'Agent', modelTier: 'Ultimate', credits: 0.2, cost: 0.2 }] }
        : { usages: [{ timestamp: 1, userId: 'u1', source: 'CLI', operation: 'Agent', modelTier: 'Ultimate', credits: 0.1, cost: 0.1 }], nextCredits: 'p2' })
    }

    const result = await fetchQoderUsageAndCosts({
      apiKey: 'qoder-admin', organizationId: 'org-1', memberId: 'member-1', fetchImpl, nowMs: 3
    })

    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/organizations/org-1/members/member-1/usage-events')
    expect(result.rows.usageLedger.map(asLedger)).toEqual([
      expect.objectContaining({ provider: 'qoder', cost: 0.1, cost_unit: 'credits', cost_source: 'provider_bill', attribution_method: 'unattributed' }),
      expect.objectContaining({ provider: 'qoder', cost: 0.2, cost_unit: 'credits', cost_source: 'provider_bill', attribution_method: 'unattributed' })
    ])
  })
})
