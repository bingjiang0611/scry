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
  it('renders the approved hierarchy without explanatory rows, retaining evidence in value descriptions', () => {
    const html = render(12.5)
    expect(html).toContain('原始 Token 成本')
    expect(html).toContain('usage-composition-bar')
    expect(html.indexOf('usage-chart-card')).toBeLessThan(html.indexOf('usage-provider-panel'))
    expect(html).toContain('不代表实际账单')
    expect(html).toContain('部分覆盖只表示已知下界')
    expect(html).toContain('无记录日沿基线连接')
    expect(html).not.toContain('usage-footnote')
    expect(html).not.toContain('usage-provider-track')
    expect(html).not.toContain('<small title=')
    expect(html.match(/<dt>/g)).toHaveLength(5)
    expect(html.slice(html.indexOf('usage-metrics'), html.indexOf('usage-breakdown'))).not.toContain('<small>')
    const visibleText = html.replace(/<[^>]*>/g, '')
    expect(visibleText).not.toContain('Credits')
    expect(visibleText).not.toContain('已知下界')
    expect(visibleText).not.toContain('统计口径')
  })

  it.each(['cc-switch', 'constructor', '__proto__'])('renders custom provider %s without treating it as a built-in vendor', (provider) => {
    const data: UsageAnalytics = {
      status: 'ready', rangeDays: 7, fromDay: '2026-09-09', toDay: '2026-09-09', observedAt: 1,
      days: ['2026-09-09'], totals: aggregate,
      byProvider: [{ ...aggregate, costUsd: 1, costKnownRows: 1, provider, model: null }],
      byModel: [{ ...aggregate, provider, model: 'claude-opus-5' }],
      byDay: [{ ...aggregate, day: '2026-09-09' }], dailyByProvider: []
    }
    const html = renderToStaticMarkup(<AnalyticsView analytics={data} rangeDays={7} loading={false}
      error={null} onRangeChange={() => {}} onRefresh={() => {}} />)
    expect(html).toContain(`>${provider}</b>`)
    // Known custom providers remain visible; their unpriced model rows do not.
    expect(html).not.toContain('claude-opus-5')
  })

  it('shows Qoder USD equivalent in total, breakdown, share and chart while retaining partial Credits evidence', () => {
    const html = render(12.5)
    expect(html).toContain('原始 Token 成本')
    expect(html).toContain('class="usage-cost-fraction">13</span>')
    expect(html).toContain('12.5 Credits')
    expect(html).toContain('原生 Credits · 已知下界')
    expect(html).toContain('2/3 轮已关联，4 个请求有计量，1 个请求缺失')
    expect(html).toContain('1 Credit = $0.01')
    expect(html).toContain('不代表实际账单')
    expect(html).not.toContain('另计 Qoder')
    expect(html).not.toContain('该时间范围没有可绘制的成本数据')
    expect(html).toContain('usage-composition-bar')
    expect(html).toContain('usage-chart-point is-qoder')
    expect(html).not.toContain('$12.50')
    const details = html.slice(html.indexOf('<section class="usage-breakdown">'))
    expect(details).toContain('<th scope="col">成本（USD）</th>')
    expect(details).toContain('>$0.13</td><td>100.0%</td>')
    expect(details).not.toContain('ultimate')
  })

  it('hides unknown detail rows and never shows dash placeholders, while retaining known zero', () => {
    for (const credits of [null, undefined, 0]) {
      const html = render(credits)
      const details = html.slice(html.indexOf('<section class="usage-breakdown">'), html.indexOf('<footer'))
      expect(details).not.toContain('—')
      if (credits == null) expect(details).toContain('当前范围没有可展示的明细')
      else expect(details).toContain('>$0.00</td><td></td>')
    }
  })

  it('renders official estimates and hides unpriced/unattributed models without hiding their aggregate evidence', () => {
    const known = { ...aggregate, costUsd: 6.9, costKnownRows: 1, estimatedCostRows: 1, officialApiCostRows: 1 }
    const data: UsageAnalytics = {
      status: 'ready', rangeDays: 7, fromDay: '2026-09-09', toDay: '2026-09-09', observedAt: 1,
      days: ['2026-09-09'], totals: known,
      byProvider: [{ ...known, provider: 'anthropic', model: null }],
      byModel: [
        { ...known, provider: 'anthropic', model: 'claude-opus-5-5' },
        { ...aggregate, provider: 'anthropic', model: 'unpriced-model' },
        { ...known, provider: 'anthropic', model: null }
      ],
      byDay: [{ ...known, day: '2026-09-09' }], dailyByProvider: []
    }
    const html = renderToStaticMarkup(<AnalyticsView analytics={data} rangeDays={7} loading={false}
      error={null} onRangeChange={() => {}} onRefresh={() => {}} />)
    const details = html.slice(html.indexOf('<section class="usage-breakdown">'), html.indexOf('<footer'))
    expect(details).toContain('claude-opus-5-5')
    expect(details).toContain('>$6.90</td><td>100.0%</td>')
    expect(details).toContain('官方 API 标准价换算')
    expect(details).not.toContain('unpriced-model')
    expect(details).not.toContain('未归因')
    expect(details).not.toContain('—')
  })

  it('orders known costs, drops the entire unavailable provider row, and does not mutate analytics', () => {
    const known = (provider: string, costUsd: number | null) => ({ ...aggregate, provider, model: null, costUsd, costKnownRows: costUsd == null ? 0 : 1 })
    const data: UsageAnalytics = {
      status: 'ready', rangeDays: 7, fromDay: '2026-09-09', toDay: '2026-09-09', observedAt: 1,
      days: ['2026-09-09'], totals: { ...aggregate, costUsd: 12, costKnownRows: 2 },
      byProvider: [known('qoder', 0), known('unknown', null), known('cc-switch', 2), known('codex', 10)],
      byModel: [], byDay: [], dailyByProvider: []
    }
    const before = JSON.stringify(data)
    const html = renderToStaticMarkup(<AnalyticsView analytics={data} rangeDays={7} loading={false}
      error={null} onRangeChange={() => {}} onRefresh={() => {}} />)
    const providers = html.slice(html.indexOf('class="usage-provider-panel"'), html.indexOf('class="usage-tokens"'))
    expect(providers.match(/class="usage-provider-row"/g)).toHaveLength(3)
    expect(providers).not.toContain('unknown')
    expect(providers.indexOf('>Codex</b>')).toBeLessThan(providers.indexOf('>cc-switch</b>'))
    expect(providers.indexOf('>cc-switch</b>')).toBeLessThan(providers.indexOf('>Qoder</b>'))
    expect(providers).toContain('>$0.00</strong>')
    expect(providers).toContain('83.3%')
    expect(JSON.stringify(data)).toBe(before)
  })

  it('distinguishes unknown, measured zero and tiny positive credits', () => {
    expect(render(null)).toContain('Credit 不可用')
    expect(render(null)).not.toContain('>0 Credits<')
    expect(render(undefined)).not.toContain('class="usage-provider-row"')
    expect(render(null)).not.toContain('class="usage-provider-row"')
    expect(render(null)).toMatch(/<strong title="[^"]*">—<\/strong>/)
    expect(render(0)).toContain('>$0.00</td>')
    expect(render(0)).toContain('原生 Credits · 已知下界')
    expect(render(0)).toContain('class="usage-provider-row"')
    expect(render(0.0001)).toContain('&lt;0.01 Credits')
    expect(render(0.0001)).toContain('&lt;$0.01')
  })
})
