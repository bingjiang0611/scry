import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LlmComparisonRound } from '@shared/llm-performance'
import { ModelComparison } from './LlmPerformanceCharts'
import { compareModels } from './llm-performance-data'

const render = (...rounds: LlmComparisonRound[]) => {
  const groups = compareModels(rounds)
  return renderToStaticMarkup(<ModelComparison groups={groups} selected={groups[0].key} colorOf={() => '#599bff'} onSelect={() => {}} />)
}

const round = (ts: number, metrics: LlmComparisonRound['metrics'], partial: Partial<LlmComparisonRound> = {}): LlmComparisonRound => ({
  ts, metrics, providerId: 'pi', model: 'model', state: 'completed', ...partial
})

describe('performance comparison rendering', () => {
  it('shows both real medians and keeps coverage and provisional counts distinct', () => {
    const html = render(round(1, { speed: 20, firstToken: 3 }), round(2, { speed: 30, firstToken: 4 }, { state: 'running' }))
    expect(html).toContain('<span>TPS 中位数</span>')
    expect(html).toContain('<span>TTFT 中位数</span>')
    expect(html).toContain('<span>首段回复等待中位数</span>')
    expect(html).toContain('aria-label="TPS 中位数（2 轮实测）：25.0">25.0</span>')
    expect(html).toContain('aria-label="TTFT 中位数（2 轮实测）：3.5">3.5</span>')
    expect(html).toContain('1 轮 · 1 暂计')
    expect(html).toContain('aria-pressed="true"')
    expect(html.match(/class="llm-perf-median"/g)).toHaveLength(2)
    expect(html).not.toContain('class="llm-perf-middle"')
    expect(html).toContain('aria-label="TPS 实测值：20.0、30.0 token/s"')
  })

  it('retains Antigravity and an unmeasured Agent without drawing fabricated values', () => {
    const html = render(round(1, { firstOutput: 14 }, { providerId: 'antigravity' }), round(2, {}, { providerId: 'opencode' }))
    expect(html).toContain('Antigravity')
    expect(html).toContain('OpenCode')
    expect(html).toContain('aria-label="TPS 中位数（0 轮实测）：—">—</span>')
    expect(html).toContain('aria-label="TTFT 中位数（0 轮实测）：—">—</span>')
    expect(html).toContain('aria-label="首段回复等待中位数（1 轮实测）：14.0">14.0</span>')
    expect(html).not.toContain('<svg')
  })

  it('renders measured extent and IQR only with enough evidence, escaping model labels', () => {
    const html = render(...[10, 20, 1000].map((speed, ts) => round(ts, { speed }, { model: '<img>' })))
    expect(html).toContain('&lt;img&gt;')
    expect(html).toContain('class="llm-perf-extent"')
    expect(html).toContain('最小 10.0，P25 15.0，中位数 20.0，P75 510.0，最大 1000.0 token/s')
    expect(html).toContain('class="llm-perf-middle"')
    expect(html.match(/class="llm-perf-median"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="TTFT 中位数（0 轮实测）：—">—</span>')
    expect(html).not.toContain('llm-perf-line')
  })
})
