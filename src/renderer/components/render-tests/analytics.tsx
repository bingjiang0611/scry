import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, AnalyticsView } = shared

describe('AnalyticsView 渲染：成本与用量', () => {
  const aggregate = {
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 100, reasoningTokens: 50,
    costUsd: 1.25, turns: 2, usageRows: 2,
    inputKnownRows: 2, outputKnownRows: 2, cacheReadKnownRows: 2, cacheWriteKnownRows: 2, reasoningKnownRows: 2,
    tokenKnownRows: 2, costKnownRows: 2,
    exactCostRows: 0, providerReportedCostRows: 1, estimatedCostRows: 1, inferredCostRows: 0
  }
  const analytics = {
    status: 'ready' as const,
    rangeDays: 30 as const,
    fromDay: '2026-08-05',
    toDay: '2026-09-03',
    observedAt: 1,
    days: ['2026-08-05', '2026-09-03'],
    totals: aggregate,
    byDay: [{ day: '2026-08-05', ...aggregate }, { day: '2026-09-03', ...aggregate }],
    dailyByAgent: [
      { day: '2026-08-05', agent: 'pi' as const, ...aggregate },
      { day: '2026-09-03', agent: 'pi' as const, ...aggregate }
    ],
    dailyByProvider: [],
    byAgent: [{ agent: 'pi' as const, ...aggregate }],
    byProvider: [],
    byModel: [
      { provider: 'codex' as const, agent: 'pi' as const, gateway: 'openai-codex', model: 'model-a', ...aggregate },
      { provider: 'anthropic' as const, agent: 'claude' as const, gateway: undefined, model: 'model-b', ...aggregate }
    ]
  }
  const render = (overrides: Record<string, unknown> = {}, view: unknown = analytics) => renderToStaticMarkup(
    <AnalyticsView analytics={view as typeof analytics | undefined} rangeDays={(overrides.rangeDays as 30) ?? 30} loading={false}
      error={null} tab="cost" onRangeChange={() => {}} onRefresh={() => {}} />
  )

  it('展示标题、两个标签、共用的 Agent 与时间范围筛选', () => {
    const html = render()
    expect(html).toContain('<h1 class="analytics-title">分析</h1>')
    expect(html).toContain('role="tablist" aria-label="分析视图"')
    expect(html).toContain('>LLM 性能</button>')
    expect(html).toContain('<button type="button" role="tab" aria-selected="true" tabindex="0">成本与用量</button>')
    expect(html).toContain('<label class="analytics-filter"><span>Agent</span><select>')
    expect(html).toContain('aria-label="时间范围"')
    expect(html).toContain('aria-label="度量"')
    // 成本页的刻度从 24 小时开始，没有 1 小时的档。
    expect(html).toContain('>24 小时</button>')
    expect(html).toContain('>90 天</button>')
  })

  it('按 Agent → 模型分行，网关只作副标题', () => {
    const html = render()
    // 表格行同时带入场动画类，断言只看行类型本身。
    expect(html).toMatch(/class="analytics-row is-agent /)
    expect(html).toMatch(/class="analytics-row is-model /)
    expect(html).toContain('Pi')
    expect(html).toContain('model-a')
    expect(html).toContain('openai-codex')
    expect(html).not.toContain('cc-switch')
    expect(html).not.toContain('unknown')
  })

  it('汇总卡按 2:1:1:1 排，成本最大，并说明金额口径', () => {
    const html = render()
    expect(html).toContain('金额按 API 价格折算。')
    expect((html.match(/<div class="analytics-tile(?: is-hero)?"/g) ?? []).length).toBe(4)
    expect(html).toContain('analytics-tile is-hero')
    expect(html).toContain('$1.25')
    expect(html).toContain('$0.63')
    expect(html).toContain('输入 1.00K · 输出 200')
  })

  it('没有数据的格子留空，不写「—」也不显示「所选：」', () => {
    const html = render()
    expect(html).not.toContain('—')
    expect(html).not.toContain('所选：')
  })

  it('每日曲线补齐没有活动的日子并画 0', () => {
    const html = render()
    // 8-05 和 9-03 之间有 29 个空白日，全部补 0，曲线连成一段。
    expect(html).toContain('class="analytics-line"')
    expect(html).toContain('class="analytics-area"')
    expect(html).toContain('USD')
  })

  it('整页没有数据时给出图标、一句话和「看 7 天」', () => {
    const empty = { ...analytics, totals: { ...aggregate, turns: 0, costUsd: null, inputTokens: null, outputTokens: null },
      byAgent: [], byModel: [], dailyByAgent: [] }
    const html = render({}, empty)
    expect(html).toContain('这段时间没有在 Scry 里运行')
    expect(html).toContain('看 7 天')
  })

  it('切换范围时旧数据仍标注属于哪个范围', () => {
    const html = render({ rangeDays: 90 })
    expect(html).toContain('正在读取90 天')
    expect(html).toContain('2026-08-05')
  })

  it('成本证据写在数值的提示里，不追加符号', () => {
    const html = render()
    expect(html).toContain('Provider 报告成本 + 估算成本')
    expect(html).toContain('title="Token 完整"')
  })
})
