import { useMemo, useState } from 'react'
import type {
  UsageAnalytics,
  UsageAnalyticsAggregate,
  UsageAnalyticsBreakdownRow,
  UsageAnalyticsRangeDays
} from '@shared/trace'
import type { BillingProvider } from '@shared/billing'
import { Icon } from './primitives/Icon'

type ChartMetric = 'cost' | 'tokens'
type BreakdownMode = 'model' | 'day'
type ChartPoint = { x: number; y: number }
type ChartSample = { value: number | null; display: string; evidence: string }

const ranges: UsageAnalyticsRangeDays[] = [7, 30, 90]
const providerLabels: Record<BillingProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  local: 'Local'
}

function tokensOf(row: UsageAnalyticsAggregate): number | null {
  if (row.inputTokens == null && row.outputTokens == null) return null
  return (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
}

function formatTokens(value: number | null): string {
  if (value == null) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 10e9 ? 1 : 2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 10e6 ? 1 : 2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 10e3 ? 1 : 2)}K`
  return value.toLocaleString()
}

function formatCost(value: number | null): string {
  if (value == null) return '—'
  if (value > 0 && value < 0.01) return '<$0.01'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function formatChartCost(value: number | null): string {
  if (value == null) return '—'
  if (value > 0 && value < 0.01) {
    const decimals = Math.min(6, Math.max(3, -Math.floor(Math.log10(value)) + 1))
    return `$${value.toFixed(decimals)}`
  }
  return formatCost(value)
}

function formatDay(day: string): string {
  const value = new Date(`${day}T12:00:00`)
  if (Number.isNaN(value.getTime())) return day
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(value)
}

function providerLabel(provider: BillingProvider): string {
  return providerLabels[provider] ?? provider
}

function costEvidence(row: UsageAnalyticsAggregate): string {
  if (row.costKnownRows === 0) return '成本不可用'
  const qualities: string[] = []
  if (row.exactCostRows > 0) qualities.push('精确成本')
  if (row.providerReportedCostRows > 0) qualities.push('Provider 报告成本')
  if (row.estimatedCostRows > 0) qualities.push('估算成本')
  if (row.inferredCostRows > 0) qualities.push('推断成本')
  return qualities.length > 0 ? qualities.join(' + ') : '成本证据质量未知'
}

function costMarker(row: UsageAnalyticsAggregate): string {
  if (row.costKnownRows === 0) return ''
  return `${row.providerReportedCostRows > 0 ? 'P' : ''}${row.estimatedCostRows > 0 ? '≈' : ''}${row.inferredCostRows > 0 ? '†' : ''}`
}

function tokenComplete(row: UsageAnalyticsAggregate): boolean {
  return row.usageRows > 0 && row.inputKnownRows === row.usageRows && row.outputKnownRows === row.usageRows
}

function tokenEvidence(row: UsageAnalyticsAggregate): string {
  if (row.usageRows === 0) return '无用量明细'
  return `${tokenComplete(row) ? '完整' : '已知下界'} · ${row.tokenKnownRows}/${row.usageRows} 条明细有 Token`
}

function formatAggregateTokens(row: UsageAnalyticsAggregate): string {
  const value = tokensOf(row)
  if (value == null) return '—'
  return `${tokenComplete(row) ? '' : '≥'}${formatTokens(value)}`
}

function formatKnownTokens(value: number | null, knownRows: number, usageRows: number): string {
  if (value == null) return '—'
  return `${usageRows > 0 && knownRows < usageRows ? '≥' : ''}${formatTokens(value)}`
}

function metricValue(row: UsageAnalyticsAggregate, metric: ChartMetric): number | null {
  return metric === 'cost' ? row.costUsd : tokensOf(row)
}

function metricEvidence(row: UsageAnalyticsAggregate, metric: ChartMetric): string {
  return metric === 'cost' ? costEvidence(row) : tokenEvidence(row)
}

function metricMarker(row: UsageAnalyticsAggregate, metric: ChartMetric): string {
  if (metric === 'cost') return costMarker(row)
  return row.usageRows > 0 && !tokenComplete(row) ? '≥' : ''
}

function formatShare(value: number | null, total: number | null): string {
  if (value == null || total == null || total <= 0) return '—'
  return `${((value / total) * 100).toFixed(1)}%`
}

function isApproximateCost(row: UsageAnalyticsAggregate): boolean {
  return row.estimatedCostRows > 0 || row.inferredCostRows > 0
}

function niceChartMax(value: number): number {
  if (value <= 0) return 1
  const exponent = 10 ** Math.floor(Math.log10(value))
  const fraction = value / exponent
  const ceiling = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return ceiling * exponent
}

function smoothPath(points: ChartPoint[]): string {
  if (points.length === 0) return ''
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index]
    const middle = (previous.x + point.x) / 2
    return `${path} C ${middle},${previous.y} ${middle},${point.y} ${point.x},${point.y}`
  }, `M ${points[0].x},${points[0].y}`)
}

function ProviderMark({ provider }: { provider: BillingProvider }) {
  return (
    <span
      className={`usage-provider-mark is-${provider}`}
      role="img"
      aria-label={providerLabel(provider)}
      title={providerLabel(provider)}
    />
  )
}

function UsageChart({ analytics, metric }: { analytics: UsageAnalytics; metric: ChartMetric }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const chart = useMemo(() => {
    const width = 920
    const height = 294
    const inset = { top: 20, right: 4, bottom: 34, left: 82 }
    const plotWidth = width - inset.left - inset.right
    const plotHeight = height - inset.top - inset.bottom
    const x = (index: number): number => inset.left + (index / Math.max(1, analytics.days.length - 1)) * plotWidth
    const providers = analytics.byProvider.filter((row) => metricValue(row, metric) != null)
    const samples = providers.map((providerRow) => {
      const rows = new Map(
        analytics.dailyByProvider
          .filter((row) => row.provider === providerRow.provider)
          .map((row) => [row.day, row] as const)
      )
      return {
        provider: providerRow.provider,
        samples: analytics.days.map((day): ChartSample => {
          const row = rows.get(day)
          if (!row) {
            return { value: null, display: '—', evidence: '当日无记录' }
          }
          return {
            value: metricValue(row, metric),
            display: metric === 'cost' ? formatChartCost(row.costUsd) : formatAggregateTokens(row),
            evidence: metric === 'cost' ? costEvidence(row) : tokenEvidence(row)
          }
        })
      }
    })
    const values = samples.flatMap((series) => series.samples.map((sample) => sample.value)).filter((value): value is number => value != null)
    const max = niceChartMax(Math.max(0, ...values))
    const baseline = inset.top + plotHeight
    const y = (value: number): number => inset.top + plotHeight - (value / max) * plotHeight
    const series = samples.map(({ provider, samples: providerSamples }) => {
      const segments: ChartPoint[][] = []
      let current: ChartPoint[] = []
      const flush = (): void => {
        if (current.length > 0) segments.push(current)
        current = []
      }
      providerSamples.forEach((sample, index) => {
        if (sample.value == null) {
          flush()
          return
        }
        current.push({ x: x(index), y: y(sample.value) })
      })
      flush()
      return { provider, samples: providerSamples, segments }
    })
    return { width, height, inset, plotWidth, plotHeight, baseline, max, x, series }
  }, [analytics, metric])

  if (chart.series.length === 0) {
    return <div className="usage-empty">该时间范围没有可绘制的{metric === 'cost' ? '成本' : ' Token'}数据。</div>
  }

  const hoveredDay = hoverIndex == null ? null : analytics.days[hoverIndex]
  const hoveredX = hoverIndex == null ? 0 : chart.x(hoverIndex)

  return (
    <div className="usage-chart-scroller">
      <div className="usage-chart-wrap">
        <p className="usage-visually-hidden" id="usage-chart-instructions">聚焦图表后，可使用左右方向键逐日查看证据。</p>
        <svg
          className="usage-chart"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label={`每日${metric === 'cost' ? '成本' : ' Token'}趋势`}
          aria-describedby="usage-chart-instructions"
          tabIndex={0}
          onFocus={() => setHoverIndex(analytics.days.length - 1)}
          onBlur={() => setHoverIndex(null)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            if (event.key === 'Home') setHoverIndex(0)
            else if (event.key === 'End') setHoverIndex(analytics.days.length - 1)
            else {
              const current = hoverIndex ?? analytics.days.length - 1
              const offset = event.key === 'ArrowLeft' ? -1 : 1
              setHoverIndex(Math.max(0, Math.min(analytics.days.length - 1, current + offset)))
            }
          }}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            const chartX = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * chart.width
            const ratio = (chartX - chart.inset.left) / Math.max(1, chart.plotWidth)
            const index = Math.round(Math.max(0, Math.min(1, ratio)) * Math.max(0, analytics.days.length - 1))
            setHoverIndex(index)
          }}
          onPointerLeave={() => setHoverIndex(null)}
        >
          {[0, 0.5, 1].map((ratio) => {
            const y = chart.inset.top + chart.plotHeight * ratio
            return <line className="usage-grid-line" key={ratio} x1={chart.inset.left} x2={chart.width - chart.inset.right} y1={y} y2={y} />
          })}
          {chart.series.flatMap((series) => series.segments.map((points, index) => {
            if (points.length === 1) {
              return <circle key={`${series.provider}:point:${index}`} className={`usage-chart-point is-${series.provider}`} cx={points[0].x} cy={points[0].y} r="2.5" />
            }
            const line = smoothPath(points)
            const area = `${line} L ${points.at(-1)!.x},${chart.baseline} L ${points[0].x},${chart.baseline} Z`
            return (
              <g key={`${series.provider}:segment:${index}`}>
                <path className={`usage-chart-area is-${series.provider}`} d={area} />
                <path className={`usage-chart-line is-${series.provider}`} d={line} />
              </g>
            )
          }))}
          {hoverIndex != null && (
            <g className="usage-chart-hover" aria-hidden="true">
              <line x1={hoveredX} x2={hoveredX} y1={chart.inset.top} y2={chart.baseline} />
              {chart.series.map((series) => {
                const value = series.samples[hoverIndex].value
                if (value == null) return null
                const y = chart.inset.top + chart.plotHeight - (value / chart.max) * chart.plotHeight
                return <circle key={series.provider} className={`is-${series.provider}`} cx={hoveredX} cy={y} r="4" />
              })}
            </g>
          )}
        </svg>
        <div className="usage-y-axis" aria-hidden="true">
          <span>{metric === 'cost' ? formatChartCost(chart.max) : formatTokens(chart.max)}</span>
          <span>{metric === 'cost' ? formatChartCost(chart.max / 2) : formatTokens(chart.max / 2)}</span>
          <span>0</span>
        </div>
        <div className="usage-x-axis" aria-hidden="true">
          <span>{formatDay(analytics.days[0])}</span>
          <span>{formatDay(analytics.days[Math.floor(analytics.days.length / 2)])}</span>
          <span>{formatDay(analytics.days.at(-1)!)}</span>
        </div>
        {hoverIndex != null && hoveredDay && (
          <div
            className={`usage-chart-tooltip ${hoverIndex > analytics.days.length * 0.68 ? 'is-flipped' : ''}`}
            role="status"
            aria-live="polite"
            style={{ left: `${(hoveredX / chart.width) * 100}%` }}
          >
            <b>{formatDay(hoveredDay)}</b>
            {chart.series.map((series) => {
              const sample = series.samples[hoverIndex]
              return (
                <span key={series.provider}>
                  <ProviderMark provider={series.provider} />
                  <em>{providerLabel(series.provider)}</em>
                  <strong>{sample.display}</strong>
                  <small>{sample.evidence}</small>
                </span>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export interface AnalyticsViewProps {
  analytics: UsageAnalytics | null
  rangeDays: UsageAnalyticsRangeDays
  loading: boolean
  error: string | null
  onRangeChange: (rangeDays: UsageAnalyticsRangeDays) => void
  onRefresh: () => void
  onBack?: () => void
}

export function AnalyticsView({ analytics, rangeDays, loading, error, onRangeChange, onRefresh, onBack }: AnalyticsViewProps) {
  const [chartMetric, setChartMetric] = useState<ChartMetric>('cost')
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>('model')

  if (!analytics && loading) {
    return <main className="usage-page"><div className="usage-state">正在读取本机用量账本…</div></main>
  }
  if (!analytics || analytics.status !== 'ready') {
    return (
      <main className="usage-page">
        <div className="usage-state is-error">
          <Icon name="alert" />
          <div><b>用量分析暂不可用</b><span>{error ?? 'SQLite 尚未初始化，Scry 其他功能不受影响。'}</span></div>
          <button type="button" onClick={onRefresh}>重试</button>
        </div>
      </main>
    )
  }

  const totals = analytics.totals
  const totalTokens = tokensOf(totals)
  const providers = analytics.byProvider.filter((row) => row.usageRows > 0 || row.costKnownRows > 0)
  const providerScale = Math.max(0, ...providers.map((row) => row.costUsd ?? 0))
  const chartProviders = providers.filter((row) => metricValue(row, chartMetric) != null)
  const rows = breakdownMode === 'model' ? analytics.byModel : [...analytics.byDay].reverse()
  const activeDays = analytics.byDay.filter((row) => row.usageRows > 0 || row.costKnownRows > 0).length
  const totalCostMarker = costMarker(totals)

  return (
    <main className="usage-page">
      <div className="usage-shell">
        <header className="usage-header">
          <div className="usage-title-group">
            {onBack && (
              <button className="usage-back" type="button" onClick={onBack} aria-label="返回对话" title="返回对话">
                <Icon name="chevronRight" />
              </button>
            )}
            <div>
              <h1>用量</h1>
              <p title={`${analytics.fromDay} 至 ${analytics.toDay}`}>{formatDay(analytics.fromDay)} – {formatDay(analytics.toDay)}</p>
            </div>
          </div>
          <div className="usage-actions">
            <div className="usage-segmented" role="group" aria-label="分析时间范围">
              {ranges.map((days) => (
                <button type="button" key={days} className={rangeDays === days ? 'active' : ''} aria-pressed={rangeDays === days} onClick={() => onRangeChange(days)}>{days} 天</button>
              ))}
            </div>
            <button className={`usage-refresh ${loading ? 'is-loading' : ''}`} type="button" onClick={onRefresh} disabled={loading} aria-label="刷新分析数据" title="刷新分析数据">
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        {error && <div className="usage-inline-error" role="status">{error}</div>}

        <section className="usage-overview" aria-label="用量概览">
          <article className="usage-cost-card">
            <span className="usage-eyebrow">RAW TOKEN COST</span>
            <strong>
              {formatCost(totals.costUsd)}
              {totalCostMarker && <sup title={costEvidence(totals)}>{totalCostMarker}</sup>}
            </strong>
            <small>{costEvidence(totals)} · {totals.turns.toLocaleString()} 轮</small>
            <div className="usage-provider-list">
              {providers.length === 0 ? <div className="usage-empty-row">当前范围没有用量记录</div> : providers.map((row) => (
                <div className="usage-provider-row" key={row.provider}>
                  <div className="usage-provider-main">
                    <ProviderMark provider={row.provider} />
                    <b>{providerLabel(row.provider)}</b>
                    <span>
                      {formatCost(row.costUsd)}
                      {costMarker(row) && <sup className="usage-cost-marker" title={costEvidence(row)}>{costMarker(row)}</sup>}
                    </span>
                  </div>
                  <span className={`usage-provider-track ${row.costUsd == null ? 'is-unknown' : ''}`}>
                    <i className={`is-${row.provider}`} style={{ width: `${row.costUsd == null || row.costUsd === 0 || providerScale === 0 ? 0 : (row.costUsd / providerScale) * 100}%` }} />
                  </span>
                  <small>
                    <span>{formatShare(row.costUsd, totals.costUsd)} 成本 · {formatAggregateTokens(row)} Token</span>
                    <em>{costEvidence(row)}</em>
                  </small>
                </div>
              ))}
            </div>
          </article>

          <article className="usage-chart-card">
            <div className="usage-section-head usage-chart-head">
              <h2>每日{chartMetric === 'cost' ? '成本' : ' Token'}</h2>
              <div className="usage-chart-controls">
                <div className="usage-segmented is-compact" role="group" aria-label="趋势指标">
                  <button type="button" className={chartMetric === 'cost' ? 'active' : ''} aria-pressed={chartMetric === 'cost'} onClick={() => setChartMetric('cost')}>成本</button>
                  <button type="button" className={chartMetric === 'tokens' ? 'active' : ''} aria-pressed={chartMetric === 'tokens'} onClick={() => setChartMetric('tokens')}>TOKEN</button>
                </div>
                <div className="usage-legend" aria-label="Provider 图例">
                  {chartProviders.map((row) => (
                    <span key={row.provider} title={metricEvidence(row, chartMetric)}>
                      <ProviderMark provider={row.provider} />
                      {providerLabel(row.provider)}
                      {metricMarker(row, chartMetric) && <em className="usage-evidence-marker">{metricMarker(row, chartMetric)}</em>}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <UsageChart analytics={analytics} metric={chartMetric} />
          </article>
        </section>

        <section className="usage-metrics" aria-label="用量摘要">
          <div><span>已处理 Token</span><b>{formatAggregateTokens(totals)}</b><small>{tokenComplete(totals) && activeDays > 0 && totalTokens != null ? `${formatTokens(totalTokens / activeDays)} / 活跃日` : tokenEvidence(totals)}</small></div>
          <div><span>缓存输入</span><b>{formatKnownTokens(totals.cacheReadTokens, totals.cacheReadKnownRows, totals.usageRows)}</b><small>{totals.cacheReadKnownRows}/{totals.usageRows} 条明细已上报</small></div>
          <div><span>已观测输入</span><b>{formatKnownTokens(totals.inputTokens, totals.inputKnownRows, totals.usageRows)}</b><small>{totals.inputKnownRows}/{totals.usageRows} 条明细已上报</small></div>
          <div><span>输出</span><b>{formatKnownTokens(totals.outputTokens, totals.outputKnownRows, totals.usageRows)}</b><small>{totals.outputKnownRows}/{totals.usageRows} 条 · 推理 {formatKnownTokens(totals.reasoningTokens, totals.reasoningKnownRows, totals.usageRows)}</small></div>
          <div><span>缓存写入</span><b>{formatKnownTokens(totals.cacheWriteTokens, totals.cacheWriteKnownRows, totals.usageRows)}</b><small>{totals.cacheWriteKnownRows}/{totals.usageRows} 条明细已上报</small></div>
        </section>

        <section className="usage-breakdown">
          <div className="usage-section-head">
            <h2>明细</h2>
            <div className="usage-segmented is-compact" role="group" aria-label="明细维度">
              <button type="button" className={breakdownMode === 'model' ? 'active' : ''} aria-pressed={breakdownMode === 'model'} onClick={() => setBreakdownMode('model')}>模型</button>
              <button type="button" className={breakdownMode === 'day' ? 'active' : ''} aria-pressed={breakdownMode === 'day'} onClick={() => setBreakdownMode('day')}>日期</button>
            </div>
          </div>
          <div className="usage-table-wrap">
            <table>
              <thead><tr><th>{breakdownMode === 'model' ? '模型' : '日期'}</th><th>成本</th><th>占比</th><th>Token</th></tr></thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={4}>当前范围没有可展示的明细</td></tr>
                ) : rows.map((row) => {
                  const modelRow = row as UsageAnalyticsBreakdownRow
                  const key = breakdownMode === 'model' ? `${modelRow.provider}:${modelRow.model ?? ''}` : (row as typeof analytics.byDay[number]).day
                  const label = breakdownMode === 'model' ? modelRow.model ?? '未归因' : (row as typeof analytics.byDay[number]).day
                  return (
                    <tr key={key}>
                      <th scope="row">
                        <span className="usage-model-cell">
                          {breakdownMode === 'model' ? <ProviderMark provider={modelRow.provider} /> : <Icon name="clock" />}
                          <b title={label}>{label}</b>
                        </span>
                      </th>
                      <td title={costEvidence(row)} className={isApproximateCost(row) ? 'is-approximate' : undefined}>
                        {formatCost(row.costUsd)}
                        {costMarker(row) && <sup className="usage-cost-marker">{costMarker(row)}</sup>}
                      </td>
                      <td>{formatShare(row.costUsd, totals.costUsd)}</td>
                      <td title={tokenEvidence(row)}>{formatAggregateTokens(row)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="usage-footnote">
          成本仅汇总 canonical USD 记录；P = Provider 报告，≈ = 估算，† = 推断。Token 的 ≥ 表示已知下界；缺失字段不按 0 处理。
        </footer>
      </div>
    </main>
  )
}
