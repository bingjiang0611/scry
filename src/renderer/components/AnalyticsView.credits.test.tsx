import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { QoderCreditEvidence, UsageAnalytics } from '@shared/trace'
import { AnalyticsView } from './AnalyticsView'
import { QODER_USD_PER_CREDIT } from '@shared/qoder-pricing'

const evidence: QoderCreditEvidence = {
  credits: 12.5, knownRequests: 4, missingRequests: 1, matchedTurns: 2, totalTurns: 3,
  source: 'qoder_native_transcript', completeness: 'partial'
}
const aggregate = {
  inputTokens: 1000, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  costUsd: null, turns: 3, usageRows: 3, inputKnownRows: 3, outputKnownRows: 0, cacheReadKnownRows: 0,
  cacheWriteKnownRows: 0, reasoningKnownRows: 0, tokenKnownRows: 3, costKnownRows: 0,
  exactCostRows: 0, providerReportedCostRows: 0, estimatedCostRows: 0, inferredCostRows: 0
}
function render(credits: number | null | undefined) {
  const qoderCredits = credits === undefined ? undefined : { ...evidence, credits }
  const row = { ...aggregate, qoderCredits,
    costUsd: credits == null ? null : credits * QODER_USD_PER_CREDIT,
    costKnownRows: credits == null ? 0 : 1, estimatedCostRows: credits == null ? 0 : 1
  }
  const data: UsageAnalytics = {
    status: 'ready', rangeDays: 7, fromDay: '2026-09-09', toDay: '2026-09-09', observedAt: 1,
    days: ['2026-09-09'], totals: row,
    byProvider: [{ ...row, provider: 'qoder', model: null }],
    byModel: [{ ...aggregate, provider: 'qoder', model: 'ultimate' }],
    byDay: [{ ...row, day: '2026-09-09' }],
    dailyByProvider: [{ ...row, day: '2026-09-09', provider: 'qoder' }]
  }
  return renderToStaticMarkup(<AnalyticsView analytics={data} rangeDays={7} loading={false} error={null} onRangeChange={() => {}} onRefresh={() => {}} />)
}

describe('AnalyticsView Qoder Credits', () => {
  it.each(['cc-switch', 'constructor', '__proto__'])('renders custom provider %s without treating it as a built-in vendor', (provider) => {
    const data: UsageAnalytics = {
      status: 'ready', rangeDays: 7, fromDay: '2026-09-09', toDay: '2026-09-09', observedAt: 1,
      days: ['2026-09-09'], totals: aggregate,
      byProvider: [{ ...aggregate, provider, model: null }],
      byModel: [{ ...aggregate, provider, model: 'claude-opus-5' }],
      byDay: [{ ...aggregate, day: '2026-09-09' }], dailyByProvider: []
    }
    const html = renderToStaticMarkup(<AnalyticsView analytics={data} rangeDays={7} loading={false}
      error={null} onRangeChange={() => {}} onRefresh={() => {}} />)
    expect(html).toContain(`>${provider}</b>`)
    expect(html).toContain('claude-opus-5')
    expect(html).toContain('成本不可用')
  })

  it('shows Qoder USD equivalent in total, breakdown, share and chart while retaining partial Credits evidence', () => {
    const html = render(12.5)
    expect(html).toContain('RAW TOKEN COST')
    expect(html).toContain('<strong>$0.13</strong>')
    expect(html).toContain('Qoder 12.5 Credits')
    expect(html).toContain('Credits 已知下界')
    expect(html).toContain('2/3 轮已关联，4 个请求有计量，1 个请求缺失')
    expect(html).toContain('1 Credit = $0.01')
    expect(html).toContain('不代表实际账单')
    expect(html).not.toContain('另计 Qoder')
    expect(html).not.toContain('该时间范围没有可绘制的成本数据')
    expect(html).toContain('usage-provider-track')
    expect(html).toContain('usage-chart-point is-qoder')
    expect(html).not.toContain('$12.50')
    const details = html.slice(html.indexOf('<section class="usage-breakdown">'))
    expect(details).toContain('<th>成本（USD）</th>')
    expect(details).toContain('>$0.13</td><td>100.0%</td>')
    expect(details).not.toContain('ultimate')
  })

  it('distinguishes unknown, measured zero and tiny positive credits', () => {
    expect(render(null)).toContain('Credit 不可用')
    expect(render(null)).not.toContain('>0 Credits<')
    expect(render(undefined)).toContain('usage-provider-track is-unknown')
    expect(render(null)).toContain('<strong>—</strong>')
    expect(render(0)).toContain('>$0.00</td>')
    expect(render(0)).toContain('Credits 已知下界')
    expect(render(0.0001)).toContain('&lt;0.01 Credits')
    expect(render(0.0001)).toContain('&lt;$0.01')
  })
})
