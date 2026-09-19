import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { QoderCreditEvidence, UsageAnalytics } from '@shared/trace'
import { AnalyticsView } from './AnalyticsView'

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
  const row = { ...aggregate, qoderCredits }
  const data: UsageAnalytics = {
    status: 'ready', rangeDays: 7, fromDay: '2026-09-09', toDay: '2026-09-09', observedAt: 1,
    days: ['2026-09-09'], totals: { ...row, costUsd: 1.25, costKnownRows: 1, estimatedCostRows: 1 },
    byProvider: [{ ...row, provider: 'qoder', model: null }],
    byModel: [{ ...aggregate, provider: 'qoder', model: 'ultimate' }],
    byDay: [{ ...row, day: '2026-09-09' }],
    dailyByProvider: [{ ...aggregate, day: '2026-09-09', provider: 'qoder' }]
  }
  return renderToStaticMarkup(<AnalyticsView analytics={data} rangeDays={7} loading={false} error={null} onRangeChange={() => {}} onRefresh={() => {}} />)
}

describe('AnalyticsView Qoder Credits', () => {
  it('Qoder-only 分析在概览与明细统一显示 Credit，不回退成美元成本', () => {
    const html = render(12.5)
    expect(html).toContain('QODER CREDIT')
    expect(html).toContain('<strong>12.5 Credits</strong>')
    expect(html).not.toContain('<strong>$1.25</strong>')
    expect(html).toContain('独立计量')
    expect(html).toContain('Credits 已知下界')
    expect(html).toContain('2/3 轮已关联，4 个请求有计量，1 个请求缺失')
    expect(html).toContain('不计入美元总额、占比或成本趋势')
    expect(html).not.toContain('另计 Qoder')
    expect(html).toContain('该时间范围没有可绘制的成本数据')
    expect(html).not.toContain('usage-provider-track')
    expect(html).not.toContain('$12.50')
    const details = html.slice(html.indexOf('<section class="usage-breakdown">'))
    expect(details).toContain('<th>Credit</th>')
    expect(details).toContain('>12.5 Credits</td><td>—</td>')
    expect(details).not.toContain('ultimate')
  })

  it('distinguishes unknown, measured zero and tiny positive credits', () => {
    expect(render(null)).toContain('Credit 不可用')
    expect(render(null)).not.toContain('>0 Credits<')
    expect(render(undefined)).not.toContain('usage-provider-track is-unknown')
    expect(render(0)).toContain('>0 Credits</td>')
    expect(render(0)).toContain('Credits 已知下界')
    expect(render(0.0001)).toContain('&lt;0.01 Credits')
    expect(render(0.0001)).not.toContain('>0 Credits</td>')
  })
})
