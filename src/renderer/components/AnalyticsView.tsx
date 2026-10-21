import { useMemo, useState } from 'react'
import type {
  UsageAnalytics,
  UsageAnalyticsAggregate,
  UsageAnalyticsBreakdownRow,
  UsageAnalyticsRangeDays
} from '@shared/trace'
import type { BillingProvider } from '@shared/billing'
import type { ProviderId } from '@shared/provider'
import { QODER_PRICING_URL, QODER_USD_BASIS } from '@shared/qoder-pricing'
import { Icon } from './primitives/Icon'
import { ProviderGlyph } from './ProviderGlyph'
import { ANALYTICS_COPY as copy } from '../constants/copy'

type ChartMetric = 'cost' | 'tokens'
type BreakdownMode = 'model' | 'day'
type ChartPoint = { x: number; y: number }
type ChartSample = { value: number | null; display: string; evidence: string }

const ranges: UsageAnalyticsRangeDays[] = [7, 30, 90]
const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
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
  return usdFormatter.format(value)
}

function creditEvidence(row: UsageAnalyticsAggregate): string {
  const evidence = row.qoderCredits
  if (!evidence) return ''
  const source = evidence.source === 'qoder_recorded_usage' ? '已记录 Credits'
    : evidence.source === 'pi_qoder_credit_observation' ? 'Pi 请求计量 Credits'
      : evidence.source === 'qoder_mixed_usage' ? '多来源 Credits' : '原生 Credits'
  return `${copy.creditAmount(evidence.credits)}；${source} · 已知下界；${evidence.matchedTurns}/${evidence.totalTurns} 轮已关联，${evidence.knownRequests} 个请求有计量，${evidence.missingRequests} 个请求缺失；按 Scry 轮次日期归集，仅主会话请求，不含未关联或子代理用量；${evidence.omissionReason ? `${evidence.omissionReason}；` : ''}${QODER_USD_BASIS}（${QODER_PRICING_URL}）`
}

function displayCostEvidence(row: UsageAnalyticsAggregate, provider?: BillingProvider): string {
  const cost = costEvidence(row)
  if (provider === 'qoder') return `${cost}；${creditEvidence(row) || 'Credit 不可用；无法换算美元'}`
  return provider == null && row.qoderCredits ? `${cost}；${creditEvidence(row)}` : cost
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
  return Object.hasOwn(providerLabels, provider) ? providerLabels[provider] : provider
}

function costEvidence(row: UsageAnalyticsAggregate): string {
  if (row.costKnownRows === 0) return '成本不可用'
  const qualities: string[] = []
  if (row.exactCostRows > 0) qualities.push('精确成本')
  if (row.providerReportedCostRows > 0) qualities.push('Provider 报告成本')
  if (row.estimatedCostRows > 0) qualities.push('估算成本')
  if (row.officialApiCostRows) qualities.push('官方 API 标准价换算 · 已知 Token 下界，缓存写入按 5 分钟；非实际账单')
  if (row.inferredCostRows > 0) qualities.push('推断成本')
  return qualities.length > 0 ? qualities.join(' + ') : '成本证据质量未知'
}

function tokenComplete(row: UsageAnalyticsAggregate): boolean {
  return row.usageRows > 0 && row.inputKnownRows === row.usageRows && row.outputKnownRows === row.usageRows
}

function tokenEvidence(row: UsageAnalyticsAggregate): string {
  if (row.usageRows === 0) return '无用量明细'
  return `${tokenComplete(row) ? '完整' : '已知下界'} · ${row.tokenKnownRows}/${row.usageRows} 条明细有 Token`
}

function formatAggregateTokens(row: UsageAnalyticsAggregate): string {
  return formatTokens(tokensOf(row))
}

function formatKnownTokens(value: number | null): string {
  return formatTokens(value)
}

function metricValue(row: UsageAnalyticsAggregate, metric: ChartMetric): number | null {
  return metric === 'cost' ? row.costUsd : tokensOf(row)
}

function metricEvidence(row: UsageAnalyticsAggregate, metric: ChartMetric): string {
  return metric === 'cost' ? costEvidence(row) : tokenEvidence(row)
}

function formatShare(value: number | null, total: number | null): string {
  if (value == null || total == null || total <= 0) return '—'
  return `${((value / total) * 100).toFixed(1)}%`
}

function isApproximateCost(row: UsageAnalyticsAggregate): boolean {
  return row.estimatedCostRows > 0 || row.inferredCostRows > 0
}

function modelBreakdownRows(analytics: UsageAnalytics): UsageAnalyticsBreakdownRow[] {
  const rows = analytics.byModel.filter((row) => row.provider !== 'qoder' && row.model && row.costUsd != null)
  const qoder = analytics.byProvider.find((row) => row.provider === 'qoder')
  if (qoder?.costUsd != null) rows.push(qoder)
  return rows.sort((a, b) => {
    const rank = (row: UsageAnalyticsAggregate): number => row.costUsd || tokensOf(row) || 0
    return rank(b) - rank(a)
  })
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

const billingProviderGlyph: Partial<Record<BillingProvider, ProviderId>> = {
  anthropic: 'claude',
  'claude-code': 'claude',
  openai: 'codex',
  codex: 'codex',
  qoder: 'qoder',
  opencode: 'opencode'
}

function ProviderMark({ provider }: { provider: BillingProvider }) {
  const glyph = Object.hasOwn(billingProviderGlyph, provider) ? billingProviderGlyph[provider] : undefined
  if (glyph) {
    return (
      <ProviderGlyph
        provider={glyph}
        label={providerLabel(provider)}
        className={`usage-provider-mark is-${provider}`}
      />
    )
  }
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
            return { value: null, display: '—', evidence: copy.noDailyRecord }
          }
          return {
            value: metricValue(row, metric),
            display: metric === 'cost' ? formatChartCost(row.costUsd) : formatAggregateTokens(row),
            evidence: metric === 'cost' ? displayCostEvidence(row, providerRow.provider) : tokenEvidence(row)
          }
        })
      }
    })
    const values = samples.flatMap((series) => series.samples.map((sample) => sample.value)).filter((value): value is number => value != null)
    const max = niceChartMax(Math.max(0, ...values))
    const baseline = inset.top + plotHeight
    const y = (value: number): number => inset.top + plotHeight - (value / max) * plotHeight
    const series = samples.map(({ provider, samples: providerSamples }) => {
      const points = providerSamples.map((sample, index) => ({
        x: x(index),
        y: y(sample.value ?? 0)
      }))
      return {
        provider,
        samples: providerSamples,
        segments: points.length > 0 ? [points] : [],
        missingDays: providerSamples.filter((sample) => sample.value == null).length
      }
    })
    return { width, height, inset, plotWidth, plotHeight, baseline, max, x, series }
  }, [analytics, metric])

  if (chart.series.length === 0) {
    return <div className="usage-empty">{metric === 'cost' ? copy.noCostChart : copy.noTokenChart}</div>
  }

  const hoveredDay = hoverIndex == null ? null : analytics.days[hoverIndex]
  const hoveredX = hoverIndex == null ? 0 : chart.x(hoverIndex)

  return (
    <div className="usage-chart-scroller">
      <div className="usage-chart-wrap">
        <p className="usage-visually-hidden" id="usage-chart-instructions">{copy.chartInstructions}</p>
        <svg
          className="usage-chart"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={metric === 'cost' ? copy.costTrend : copy.tokenTrend}
          aria-describedby="usage-chart-instructions"
          tabIndex={0}
          onFocus={() => setHoverIndex((current) => current ?? analytics.days.length - 1)}
          onBlur={() => setHoverIndex(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setHoverIndex(null)
              return
            }
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
              <g key={`${series.provider}:segment:${index}`} data-missing-days={series.missingDays}>
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
            className="usage-chart-tooltip"
            role="status"
            aria-live="polite"
            style={{ left: `clamp(8px, calc(${(hoveredX / chart.width) * 100}% + 12px), max(8px, calc(100% - 312px)))` }}
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
    return <main className="usage-page"><div className="usage-state">{copy.loading}</div></main>
  }
  if (!analytics || analytics.status !== 'ready') {
    return (
      <main className="usage-page">
        <div className="usage-state is-error">
          <Icon name="alert" />
          <div><b>{copy.unavailable}</b><span>{error ?? copy.databaseUnavailable}</span></div>
          <button type="button" onClick={onRefresh}>{copy.retry}</button>
        </div>
      </main>
    )
  }

  const totals = analytics.totals
  const providers = analytics.byProvider.filter((row) => row.usageRows > 0 || row.costKnownRows > 0 || row.qoderCredits)
  const costProviders = providers.filter((row) => row.costUsd != null).sort((a, b) => b.costUsd! - a.costUsd!)
  const qoderOnly = providers.length > 0 && providers.every((row) => row.provider === 'qoder')
  const chartProviders = providers.filter((row) => metricValue(row, chartMetric) != null)
  const rows = breakdownMode === 'model' ? modelBreakdownRows(analytics) : analytics.byDay.filter((row) => row.costUsd != null).reverse()
  const totalEvidence = copy.totalEvidence(displayCostEvidence(totals), totals.turns)
  const metrics = [
    { label: copy.processedTokens, value: formatAggregateTokens(totals), evidence: tokenEvidence(totals) },
    { label: copy.cacheRead, value: formatKnownTokens(totals.cacheReadTokens), evidence: copy.tokenCoverage(totals.cacheReadKnownRows, totals.usageRows) },
    { label: copy.input, value: formatKnownTokens(totals.inputTokens), evidence: copy.tokenCoverage(totals.inputKnownRows, totals.usageRows) },
    { label: copy.output, value: formatKnownTokens(totals.outputTokens), evidence: copy.outputEvidence(totals.outputKnownRows, totals.usageRows, formatKnownTokens(totals.reasoningTokens)) },
    { label: copy.cacheWrite, value: formatKnownTokens(totals.cacheWriteTokens), evidence: copy.tokenCoverage(totals.cacheWriteKnownRows, totals.usageRows) }
  ]

  return (
    <main className="usage-page">
      <div className="usage-shell">
        <header className="usage-header">
          <div className="usage-title-group">
            {onBack && (
              <button className="usage-back" type="button" onClick={onBack} aria-label={copy.back} title={copy.back}>
                <Icon name="chevronRight" />
              </button>
            )}
            <div>
              <h1>{copy.title}</h1>
              <p title={copy.period(analytics.fromDay, analytics.toDay)}>{copy.periodDisplay(formatDay(analytics.fromDay), formatDay(analytics.toDay))}</p>
            </div>
          </div>
          <div className="usage-actions">
            <div className="usage-segmented" role="group" aria-label={copy.rangeLabel}>
              {ranges.map((days) => (
                <button type="button" key={days} className={rangeDays === days ? 'active' : ''} aria-pressed={rangeDays === days} onClick={() => onRangeChange(days)}>{copy.range(days)}</button>
              ))}
            </div>
            <button className={`usage-refresh ${loading ? 'is-loading' : ''}`} type="button" onClick={onRefresh} disabled={loading} aria-label={copy.refresh} title={copy.refresh}>
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        {error && <div className="usage-inline-error" role="status">{error}</div>}

        <section className="usage-overview" aria-label={copy.overview}>
          <article className="usage-cost-card" aria-label={copy.totalLabel} aria-description={totalEvidence}>
            <h2 className="usage-eyebrow">{copy.totalLabel}</h2>
            <strong title={totalEvidence}>
              {totals.costUsd == null || (totals.costUsd > 0 && totals.costUsd < 0.01)
                ? formatCost(totals.costUsd)
                : usdFormatter.formatToParts(totals.costUsd).map((part, index) => (
                  <span className={`usage-cost-${part.type}`} key={index}>{part.value}</span>
                ))}
            </strong>
          </article>
          <article className="usage-composition" aria-label={copy.composition}>
            <h2>{copy.composition}</h2>
            <div className="usage-composition-bar" role="img" aria-label={copy.compositionChart}>
              {costProviders.map((row) => (
                <span key={row.provider} className={`is-${row.provider}`} title={providerLabel(row.provider)}
                  style={{ flexBasis: `${totals.costUsd != null && totals.costUsd > 0 ? row.costUsd! / totals.costUsd * 100 : 0}%` }} />
              ))}
            </div>
            <div className="usage-composition-key">
              {costProviders.map((row) => (
                <div key={row.provider}>
                  <span><ProviderMark provider={row.provider} />{providerLabel(row.provider)}</span>
                  <strong>{formatShare(row.costUsd, totals.costUsd)}</strong>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="usage-analysis">
          <article className="usage-chart-card">
            <div className="usage-section-head usage-chart-head">
              <h2>{chartMetric === 'cost' ? copy.dailyCost : copy.dailyTokens}</h2>
              <div className="usage-segmented is-compact" role="group" aria-label={copy.metric}>
                <button type="button" className={chartMetric === 'cost' ? 'active' : ''} aria-pressed={chartMetric === 'cost'} onClick={() => setChartMetric('cost')}>{copy.cost}</button>
                <button type="button" className={chartMetric === 'tokens' ? 'active' : ''} aria-pressed={chartMetric === 'tokens'} onClick={() => setChartMetric('tokens')}>{copy.tokenToggle}</button>
              </div>
            </div>
            <div className="usage-legend" aria-label={copy.legend}>
              {chartProviders.map((row) => (
                <span key={row.provider} title={metricEvidence(row, chartMetric)}>
                  <ProviderMark provider={row.provider} />{providerLabel(row.provider)}
                </span>
              ))}
            </div>
            <UsageChart key={`${chartMetric}:${analytics.fromDay}:${analytics.toDay}`} analytics={analytics} metric={chartMetric} />
          </article>
          <article className="usage-provider-panel" aria-label={copy.byProvider}>
            <div className="usage-section-head"><h2>{copy.byProvider}</h2></div>
            <div className="usage-provider-list">
              {costProviders.length === 0 ? <div className="usage-empty-row">{copy.noCost}</div> : costProviders.map((row) => (
                <div className="usage-provider-row" key={row.provider}>
                  <div className="usage-provider-main">
                    <ProviderMark provider={row.provider} />
                    <b>{providerLabel(row.provider)}</b>
                    <span className="usage-provider-share">{formatShare(row.costUsd, totals.costUsd)}</span>
                    <strong title={copy.providerEvidence(displayCostEvidence(row, row.provider), formatAggregateTokens(row), tokenEvidence(row))}>{formatCost(row.costUsd)}</strong>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="usage-tokens" aria-label={copy.tokens}>
          <h2>{copy.tokens}</h2>
          <dl className="usage-metrics">
            {metrics.map((metric) => (
              <div key={metric.label} title={metric.evidence}>
                <dt>{metric.label}</dt><dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="usage-breakdown">
          <div className="usage-section-head">
            <h2>{copy.details}</h2>
            <div className="usage-segmented is-compact" role="group" aria-label={copy.detailDimension}>
              <button type="button" className={breakdownMode === 'model' ? 'active' : ''} aria-pressed={breakdownMode === 'model'} onClick={() => setBreakdownMode('model')}>{copy.model}</button>
              <button type="button" className={breakdownMode === 'day' ? 'active' : ''} aria-pressed={breakdownMode === 'day'} onClick={() => setBreakdownMode('day')}>{copy.day}</button>
            </div>
          </div>
          <div className="usage-table-wrap">
            <table>
              <colgroup><col className="usage-model-column" /><col className="usage-cost-column" /><col /><col /></colgroup>
              <thead><tr><th scope="col">{breakdownMode === 'model' ? copy.model : copy.day}</th><th scope="col">{copy.costUsd}</th><th scope="col">{copy.share}</th><th scope="col">{copy.token}</th></tr></thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={4}>{copy.noDetails}</td></tr>
                ) : rows.map((row) => {
                  const modelRow = row as UsageAnalyticsBreakdownRow
                  const key = breakdownMode === 'model' ? `${modelRow.provider}:${modelRow.model ?? ''}` : (row as typeof analytics.byDay[number]).day
                  const label = breakdownMode === 'model'
                    ? modelRow.provider === 'qoder' ? providerLabel('qoder') : modelRow.model ?? copy.unattributed
                    : (row as typeof analytics.byDay[number]).day
                  const rowProvider = breakdownMode === 'model' ? modelRow.provider : qoderOnly ? 'qoder' : undefined
                  return (
                    <tr key={key}>
                      <th scope="row">
                        <span className="usage-model-cell">
                          {breakdownMode === 'model' ? <ProviderMark provider={modelRow.provider} /> : <Icon name="clock" />}
                          <b title={label}>{label}</b>
                        </span>
                      </th>
                      <td title={displayCostEvidence(row, rowProvider)} className={isApproximateCost(row) ? 'is-approximate' : undefined}>{formatCost(row.costUsd)}</td>
                      <td>{totals.costUsd != null && totals.costUsd > 0 ? formatShare(row.costUsd, totals.costUsd) : null}</td>
                      <td title={tokenEvidence(row)} className={!tokenComplete(row) && row.usageRows > 0 ? 'is-lower-bound' : undefined}>{tokensOf(row) != null ? formatAggregateTokens(row) : null}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </main>
  )
}
