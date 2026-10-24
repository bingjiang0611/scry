import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelComparison } from './LlmPerformanceCharts'
import { compareModels } from './llm-performance-data'

const sample = (ts: number, value: number, model = 'model', provisional = false) => ({ ts, value, model, provisional })
const render = (groups: ReturnType<typeof compareModels>) => renderToStaticMarkup(
  <ModelComparison groups={groups} selected="model" colorOf={() => '#599bff'} onSelect={() => {}} />
)

describe('performance comparison rendering', () => {
  it('shows both real medians in four columns and keeps provisional counts explicit', () => {
    const html = render(compareModels([sample(1, 20), sample(2, 30, 'model', true)], [sample(1, 3), sample(2, 4)]))
    expect(html).toContain('中位速度<small>token/s</small>')
    expect(html).toContain('首 token 中位数<small>秒</small>')
    expect(html).toContain('aria-label="中位速度">25.0</span>')
    expect(html).toContain('aria-label="首 token 中位数">3.5</span>')
    expect(html).toContain('1 + 1* 轮')
    expect(html).toContain('aria-pressed="true"')
    expect(html.match(/class="llm-perf-median"/g)).toHaveLength(2)
    expect(html).not.toContain('class="llm-perf-middle"')
    expect(html).toContain('aria-label="速度实测值：20.0、30.0 token/s"')
  })

  it('renders absent speed honestly while retaining the first-token-only model', () => {
    const html = render(compareModels([], [sample(1, 1.7)]))
    expect(html).toContain('首 token 1 轮')
    expect(html).toContain('aria-label="中位速度">—</span>')
    expect(html).toContain('aria-label="首 token 中位数">1.7</span>')
    expect(html).not.toContain('<svg')
  })

  it('renders measured extent and IQR only with enough evidence, escaping model labels', () => {
    const html = render(compareModels([sample(1, 10, '<img>'), sample(2, 20, '<img>'), sample(3, 1000, '<img>')], []))
    expect(html).toContain('&lt;img&gt;')
    expect(html).toContain('class="llm-perf-extent"')
    expect(html).toContain('最小 10.0，P25 15.0，中位数 20.0，P75 510.0，最大 1000.0 token/s')
    expect(html).toContain('class="llm-perf-middle"')
    expect(html.match(/class="llm-perf-median"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="首 token 中位数">—</span>')
    expect(html).not.toContain('llm-perf-line')
  })
})
