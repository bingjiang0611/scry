import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, AnalyticsView } = shared

describe('AnalyticsView 渲染：T3 风格用量分析', () => {
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
    byDay: [
      { day: '2026-08-05', ...aggregate },
      { day: '2026-09-03', ...aggregate }
    ],
    dailyByProvider: [
      { day: '2026-08-05', provider: 'anthropic' as const, ...aggregate },
      { day: '2026-09-03', provider: 'anthropic' as const, ...aggregate },
      { day: '2026-08-05', provider: 'codex' as const, ...aggregate },
      { day: '2026-09-03', provider: 'codex' as const, ...aggregate }
    ],
    byProvider: [
      { provider: 'anthropic' as const, model: null, ...aggregate },
      { provider: 'codex' as const, model: null, ...aggregate }
    ],
    byModel: [
      { provider: 'anthropic' as const, model: 'claude-sonnet', ...aggregate },
      { provider: 'codex' as const, model: 'gpt-5', ...aggregate }
    ]
  }
  const html = renderToStaticMarkup(
    <AnalyticsView
      analytics={analytics}
      rangeDays={30}
      loading={false}
      error={null}
      onRangeChange={() => {}}
      onRefresh={() => {}}
      onBack={() => {}}
    />
  )

  it('展示时间范围、返回、刷新、Raw Cost 和面积趋势', () => {
    expect(html).toContain('<h1>用量</h1>')
    expect(html).toContain('2026-08-05 至 2026-09-03')
    expect(html).toContain('aria-label="分析时间范围"')
    expect(html).toContain('aria-label="返回对话"')
    expect(html).toContain('aria-label="刷新分析数据"')
    expect(html).toContain('原始 Token 成本')
    expect(html).toContain('$1.25')
    expect(html).toContain('每日成本趋势')
    expect(html).toContain('usage-chart-area')
    expect(html).toContain('usage-chart-line')
    expect(html).toContain('Anthropic')
    expect(html).toContain('Codex')
  })

  it('展示真实摘要与紧凑模型明细，不展示旧四章节和诊断', () => {
    expect(html).toContain('已处理 Token')
    expect(html).toContain('缓存输入')
    expect(html).toContain('已观测输入')
    expect(html).toContain('缓存写入')
    expect(html).toContain('推理 50')
    expect(html).toContain('claude-sonnet')
    expect(html).toContain('gpt-5')
    expect(html).not.toContain('<th>Provider</th>')
    expect(html).not.toContain('风险与盲区')
    expect(html).not.toContain('诊断')
  })

  it('Qoder 的模式名和未归因项在模型明细中合并为一个 Qoder 行', () => {
    // 合并只针对可展示的已知成本；未知成本不显示的合同由 Credits 用例覆盖。
    const qoderAggregate = {
      ...aggregate,
      costUsd: 1.25,
      costKnownRows: 2,
      exactCostRows: 0,
      providerReportedCostRows: 2,
      estimatedCostRows: 0,
      inferredCostRows: 0
    }
    const groupedHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          byProvider: [...analytics.byProvider, { provider: 'qoder', model: null, ...qoderAggregate }],
          byModel: [
            ...analytics.byModel,
            { provider: 'qoder', model: 'ultimate', ...qoderAggregate },
            { provider: 'qoder', model: 'efficient', ...qoderAggregate },
            { provider: 'qoder', model: null, ...qoderAggregate },
            { provider: 'qoder', model: 'lite', ...qoderAggregate }
          ]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )
    const breakdownHtml = groupedHtml.slice(groupedHtml.indexOf('<section class="usage-breakdown">'))

    expect(breakdownHtml).toContain('<b title="Qoder">Qoder</b>')
    expect(breakdownHtml.match(/provider-glyph usage-provider-mark is-qoder/g)).toHaveLength(1)
    expect(breakdownHtml).not.toContain('title="ultimate"')
    expect(breakdownHtml).not.toContain('title="efficient"')
    expect(breakdownHtml).not.toContain('title="lite"')
    expect(breakdownHtml).not.toContain('title="未归因"')
  })

  it('成本来源使用文案标注，不在数字上追加证据符号', () => {
    expect(html).toContain('Provider 报告成本 + 估算成本')
    expect(html).not.toContain('>P≈</sup>')
    expect(html).toContain('title="Provider 报告成本 + 估算成本；2 轮；不代表实际账单')
    expect(html).toContain('aria-describedby="usage-chart-instructions"')
  })

  it('精确成本与 Provider 报告成本保持不同证据文案', () => {
    const exactHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: { ...aggregate, exactCostRows: 2, providerReportedCostRows: 0, estimatedCostRows: 0 },
          byProvider: [{ provider: 'anthropic', model: null, ...aggregate, exactCostRows: 2, providerReportedCostRows: 0, estimatedCostRows: 0 }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )
    const providerReportedHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: { ...aggregate, exactCostRows: 0, providerReportedCostRows: 2, estimatedCostRows: 0 },
          byProvider: [{ provider: 'codex', model: null, ...aggregate, exactCostRows: 0, providerReportedCostRows: 2, estimatedCostRows: 0 }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(exactHtml).toContain('aria-description="精确成本；2 轮；')
    expect(providerReportedHtml).toContain('aria-description="Provider 报告成本；2 轮；')
    expect(providerReportedHtml).not.toContain('>P</sup>')
  })

  it('混合成本来源不被优先级分支吞掉', () => {
    const mixed = {
      ...aggregate,
      costKnownRows: 4,
      exactCostRows: 1,
      providerReportedCostRows: 1,
      estimatedCostRows: 1,
      inferredCostRows: 1
    }
    const mixedHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{ ...analytics, totals: mixed, byProvider: [{ provider: 'codex', model: null, ...mixed }] }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(mixedHtml).toContain('精确成本 + Provider 报告成本 + 估算成本 + 推断成本')
    expect(mixedHtml).not.toContain('>P≈†</sup>')
  })

  it('部分 Token 在摘要、Provider 数值提示和明细中保留已知下界证据', () => {
    const partial = {
      ...aggregate,
      outputTokens: null,
      outputKnownRows: 0
    }
    const partialHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: partial,
          byProvider: [{ provider: 'anthropic', model: null, ...partial }],
          byModel: [{ provider: 'anthropic', model: 'claude-sonnet', ...partial }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(partialHtml).toContain('<dd>1.00K</dd>')
    expect(partialHtml).not.toContain('≥1.00K')
    expect(partialHtml).toContain('已知下界 · 2/2 条明细有 Token')
    const providers = partialHtml.slice(partialHtml.indexOf('class="usage-provider-panel"'), partialHtml.indexOf('class="usage-tokens"'))
    expect(providers).toContain('1.00K Token；已知下界 · 2/2 条明细有 Token')
    expect(partialHtml).toContain('class="is-lower-bound"')
    expect(partialHtml).not.toContain('/ 活跃日')
  })

  it('稀疏缺失日和显式未知日沿基线连续连接，但保留无记录语义', () => {
    const unavailableCost = {
      ...aggregate,
      costUsd: null,
      costKnownRows: 0,
      exactCostRows: 0,
      providerReportedCostRows: 0,
      estimatedCostRows: 0,
      inferredCostRows: 0
    }
    const gapHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          days: ['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
          dailyByProvider: [
            { day: '2026-08-05', provider: 'codex', ...aggregate },
            { day: '2026-08-07', provider: 'codex', ...unavailableCost },
            { day: '2026-08-08', provider: 'codex', ...aggregate }
          ],
          byProvider: [{ provider: 'codex', model: null, ...aggregate }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(gapHtml).toContain('data-missing-days="2"')
    expect(gapHtml).toContain('usage-chart-line')
    expect(gapHtml).toContain('usage-chart-area')
    expect(gapHtml).toContain('无记录日沿基线连接以保持走势连续，但不代表实际值为零')
  })

  it('未知成本不画成零值趋势，小额非零成本不显示成 $0.00 且单一来源占满构成条', () => {
    const unknownAggregate = {
      ...aggregate,
      costUsd: null,
      costKnownRows: 0,
      providerReportedCostRows: 0,
      estimatedCostRows: 0
    }
    const unknownHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: unknownAggregate,
          byDay: analytics.byDay.map((row) => ({ ...row, ...unknownAggregate })),
          dailyByProvider: analytics.dailyByProvider.map((row) => ({ ...row, ...unknownAggregate })),
          byProvider: analytics.byProvider.map((row) => ({ ...row, ...unknownAggregate })),
          byModel: analytics.byModel.map((row) => ({ ...row, ...unknownAggregate }))
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )
    const small = { ...aggregate, costUsd: 0.001 }
    const smallCostHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: small,
          dailyByProvider: analytics.dailyByProvider.map((row) => ({ ...row, ...small })),
          byProvider: [{ provider: 'codex', model: null, ...small }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(unknownHtml).toContain('该时间范围没有可绘制的成本数据')
    expect(unknownHtml).not.toContain('usage-chart-area')
    expect(unknownHtml).not.toContain('usage-chart-line')
    expect(smallCostHtml).toContain('&lt;$0.01')
    expect(smallCostHtml).toContain('$0.0010')
    expect(smallCostHtml).toContain('style="flex-basis:100%"')
    expect(unknownHtml).not.toContain('class="usage-provider-row"')
  })
})