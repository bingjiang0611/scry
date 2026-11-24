import { useMemo, useState } from 'react'
import type { UsageAnalytics } from '@shared/trace'
import { ANALYTICS_COPY as copy } from '../constants/analytics-copy'
import { Segmented } from './primitives/Segmented'
import { EmptyState } from './primitives/EmptyState'
import {
  formatChartCost, formatCost, formatCount, formatDay, formatShare, formatTokens,
  displayCostEvidence, isApproximateCost, niceChartMax, smoothPath, tokenEvidence, type ChartPoint
} from './analytics-format'
import { agentTable, averageCost, chartMax, dailySeries, totalTokens, type AgentFilter, type CostMetric } from './analytics-data'
import { PROVIDER_LABELS } from '@shared/provider'

const seriesColor = (index: number): string => `var(--analytics-series-${index % 7})`
const agentName = (agent: string): string => PROVIDER_LABELS[agent as keyof typeof PROVIDER_LABELS] ?? agent

/** 每日曲线：按日期补齐所有日子，没有活动的日子画 0，未知值断开。 */
function DailyChart({ analytics, metric, agent }: { analytics: UsageAnalytics; metric: CostMetric; agent: AgentFilter }) {
  const [active, setActive] = useState<number | null>(null)
  const series = useMemo(() => dailySeries(analytics, metric, agent), [analytics, metric, agent])
  const max = niceChartMax(chartMax(series))
  const days = analytics.days
  const W = 920, H = 220, L = 56, R = 12, T = 12, B = 28
  const plotWidth = W - L - R
  const x = (index: number): number => L + (days.length === 1 ? plotWidth / 2 : (index / (days.length - 1)) * plotWidth)
  const y = (value: number): number => H - B - (value / max) * (H - T - B)
  const format = (value: number | null): string => metric === 'cost' ? formatChartCost(value) : formatTokens(value)
  const total = series.map((item) => item.values.reduce<number>((sum, value) => sum + (value ?? 0), 0))
  const filled = total.indexOf(Math.max(...total))
  const paths = series.map((item, index) => {
    const runs: ChartPoint[][] = []
    let run: ChartPoint[] = []
    for (const [dayIndex, value] of item.values.entries()) {
      if (value == null) { if (run.length) runs.push(run); run = []; continue }
      run.push({ x: x(dayIndex), y: y(value) })
    }
    if (run.length) runs.push(run)
    return { agent: item.agent, index, runs, color: seriesColor(index) }
  })
  const readOut = active == null ? '' : `${formatDay(days[active])}：${series.map((item) => {
    const value = item.values[active]
    return `${agentName(item.agent)} ${value == null ? '无价格' : format(value) || '0'}`
  }).join('，')}`
  return <>
    <div className="analytics-legend" aria-label={copy.legendLabel}>
      {series.map((item, index) => <span key={item.agent} className="analytics-legend-item">
        <i aria-hidden="true" style={{ background: seriesColor(index) }} />{agentName(item.agent)}
      </span>)}
    </div>
    <div className="analytics-chart">
      {series.length > 0 && <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={copy.dailyTitle(metric)} tabIndex={0}
        aria-describedby="analytics-chart-readout" onFocus={() => setActive(0)} onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') { setActive(null); return }
          setActive((index) => event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1
            : Math.max(0, Math.min(days.length - 1, (index ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1))))
        }}>
        <text className="analytics-axis-unit" x={0} y={10}>{metric === 'cost' ? 'USD' : 'Token'}</text>
        <g className="analytics-axis">
          {[0, max / 2, max].map((value) => <g key={value}>
            <line x1={L} x2={W - R} y1={y(value)} y2={y(value)} />
            <text x={L - 8} y={y(value) + 4} textAnchor="end">{metric === 'cost' ? formatChartCost(value) : formatTokens(value)}</text>
          </g>)}
          {[0, 1, 2, 3, 4].map((index) => {
            const dayIndex = Math.round((days.length - 1) * index / 4)
            return <text key={index} x={x(dayIndex)} y={H - 4}
              textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}>{formatDay(days[dayIndex])}</text>
          })}
        </g>
        {paths.map((path) => <g key={path.agent} style={{ color: path.color }}>
          {path.index === filled && path.runs.map((run, index) => run.length > 1 &&
            <path key={index} className="analytics-area" d={`${smoothPath(run)} L ${run.at(-1)!.x},${y(0)} L ${run[0].x},${y(0)} Z`} />)}
          {path.runs.map((run, index) => <path key={index} className="analytics-line" d={run.length === 1
            ? `M ${run[0].x - 2},${run[0].y} h 4` : smoothPath(run)} />)}
        </g>)}
        {active != null && <line className="analytics-cursor" x1={x(active)} x2={x(active)} y1={T} y2={H - B} />}
      </svg>}
      {active != null && <p id="analytics-chart-readout" className="analytics-readout" role="status">{readOut}</p>}
    </div>
  </>
}

export function AnalyticsCostTab({ analytics, metric, onMetric, agent, onShowRange }: {
  analytics: UsageAnalytics
  metric: CostMetric
  onMetric: (metric: CostMetric) => void
  agent: AgentFilter
  onShowRange: (days: UsageAnalytics['rangeDays']) => void
}) {
  const rows = agentTable(analytics, agent)
  const hasChart = dailySeries(analytics, metric, agent).length > 0
  const tokens = totalTokens(analytics)
  const agents = new Set(rows.filter((row) => row.kind === 'agent').map((row) => row.agent)).size
  const input = analytics.totals.inputTokens
  const output = analytics.totals.outputTokens
  if (!rows.length) {
    return <EmptyState size="page" className="analytics-empty" picture="chart" title={copy.emptyTitle}
      actions={analytics.rangeDays === 7 ? undefined : [{ label: copy.emptyAction, intent: 'quiet', onClick: () => onShowRange(7) }]} />
  }
  return <>
    <p className="analytics-note is-basis">{copy.costBasis}</p>
    <div className="analytics-tiles">
      <div className="analytics-tile is-hero">
        <span className="analytics-tile-label">{copy.costTiles.cost}</span>
        <span className="analytics-tile-value">{formatCost(analytics.totals.costUsd)}</span>
        <span className="analytics-tile-sub">{copy.costTileSub.cost}</span>
      </div>
      <div className="analytics-tile">
        <span className="analytics-tile-label">{copy.costTiles.average}</span>
        <span className="analytics-tile-value">{formatCost(averageCost(analytics))}</span>
        <span className="analytics-tile-sub">{copy.costTileSub.average}</span>
      </div>
      <div className="analytics-tile">
        <span className="analytics-tile-label">{copy.costTiles.tokens}</span>
        <span className="analytics-tile-value">{formatTokens(tokens)}</span>
        <span className="analytics-tile-sub">输入 {formatTokens(input) || '0'} · 输出 {formatTokens(output) || '0'}</span>
      </div>
      <div className="analytics-tile">
        <span className="analytics-tile-label">{copy.costTiles.turns}</span>
        <span className="analytics-tile-value">{formatCount(analytics.totals.turns)}</span>
        <span className="analytics-tile-sub">{copy.costTileSub.turns(agents)}</span>
      </div>
    </div>

    {hasChart && <section className="analytics-card" aria-labelledby="analytics-daily">
      <div className="analytics-card-head">
        <h2 id="analytics-daily">{copy.dailyTitle(metric)}</h2>
        <Segmented className="analytics-metric" label={copy.metricLabel} value={metric} onChange={onMetric}
          options={[{ value: 'cost', label: copy.metric.cost }, { value: 'tokens', label: copy.metric.tokens }]} />
      </div>
      <DailyChart analytics={analytics} metric={metric} agent={agent} />
    </section>}

    <section className="analytics-card" aria-labelledby="analytics-agents">
      <div className="analytics-card-head"><h2 id="analytics-agents">{copy.agentTable}</h2></div>
      <div className="analytics-table-scroll">
        <table className="analytics-table is-agents">
          <thead>
            <tr>
              <th scope="col">{copy.columns.identity}</th>
              <th scope="col" className="is-num">{copy.columns.turns}</th>
              <th scope="col" className="is-num">{copy.columns.tokens}</th>
              <th scope="col" className="is-num">{copy.columns.cost}</th>
              <th scope="col" className="is-num">{copy.columns.share}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => <tr key={row.key} className={`analytics-row is-${row.kind}`}>
              <th scope="row">
                <span className="analytics-identity">
                  {row.kind === 'agent' && <i aria-hidden="true" className="analytics-dot" style={{ background: seriesColor(rows.filter((item) => item.kind === 'agent').findIndex((item) => item.agent === row.agent)) }} />}
                  <span className="analytics-name">{row.kind === 'agent' ? agentName(row.name) : row.name}</span>
                  {row.gateway && <span className="analytics-sub">{row.gateway}</span>}
                </span>
              </th>
              <td className="is-num">{formatCount(row.turns)}</td>
              <td className="is-num" title={tokenEvidence(row.evidence)}>{formatTokens(row.tokens)}</td>
              <td className="is-num is-strong" title={displayCostEvidence(row.evidence)}
                data-approximate={isApproximateCost(row.evidence) ? 'true' : undefined}>
                {formatCost(row.costUsd)}
                {row.costUsd == null && row.tokens != null && <span className="analytics-sub">
                  {row.kind === 'model' ? copy.unpriced : copy.priceBasis.unpriced}
                </span>}
              </td>
              <td className="is-num">{formatShare(row.share, 1)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
  </>
}
