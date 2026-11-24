import { useMemo, useState } from 'react'
import { LLM_METRICS, llmComparisonRounds, type LlmMetric } from '@shared/llm-performance'
import { ANALYTICS_COPY as copy } from '../constants/analytics-copy'
import { LLM_PERFORMANCE_COPY as perfCopy } from '../constants/llm-performance-copy'
import { useLlmPerformanceData } from '../hooks/useLlmPerformanceData'
import { compareModels, metricDistribution, type RangeHours } from './llm-performance-data'
import { PerfTable, RoundScatter } from './analytics-perf-charts'
import { gatewayLookup, type AgentFilter } from './analytics-data'
import { EmptyState } from './primitives/EmptyState'
import { Segmented } from './primitives/Segmented'
import { DelayedSkeletonRows } from './primitives/Skeleton'
import { PROVIDER_LABELS } from '@shared/provider'
import type { UsageAnalytics } from '@shared/trace'

const PALETTE = 7
const formatMedian = (value: number): string => value.toFixed(1)

export function AnalyticsPerformanceTab({ analytics, hours, agent, onShowRange }: {
  analytics?: UsageAnalytics
  hours: RangeHours
  agent: AgentFilter
  onShowRange: (hours: RangeHours) => void
}) {
  const [metric, setMetric] = useState<LlmMetric>('speed')
  const [selected, setSelected] = useState<string | null>(null)
  const data = useLlmPerformanceData(true)
  const to = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
  const from = to - hours * 3_600_000
  const rounds = useMemo(() => llmComparisonRounds(data.history?.rows ?? [], data.summary?.sessions), [data.history, data.summary])
  const scoped = useMemo(() => rounds.filter((round) =>
    round.ts >= from && round.ts <= to && (agent === 'all' || round.providerId === agent)), [rounds, from, to, agent])
  const groups = useMemo(() => compareModels(scoped), [scoped])
  const colorOf = useMemo(() => {
    const keys = groups.map((group) => group.key)
    return (key: string): string => `var(--analytics-series-${keys.indexOf(key) % PALETTE})`
  }, [groups])
  const gatewayOf = useMemo(() => gatewayLookup(analytics), [analytics])
  const shown = groups.filter((group) => group.completed + group.running > 0)
  const current = shown.find((group) => group.key === selected) ?? shown[0]
  const activeMetric = current && !current.samples[metric].length
    ? LLM_METRICS.find((item) => current.samples[item].length) ?? metric : metric
  const tiles = LLM_METRICS.map((item) => ({ metric: item, stats: metricDistribution(scoped.flatMap((round) => round.metrics[item] == null ? [] : [{ ts: round.ts, value: round.metrics[item]! }])) }))
  const turns = shown.reduce((total, group) => total + group.completed + group.running, 0)
  const loading = !data.history && !data.historyError && !shown.length
  const empty = !loading && !shown.length

  return <>
    <div className="analytics-tiles">
      {tiles.map(({ metric: item, stats }, index) => (
        <div key={item} className={`analytics-tile${index === 0 ? ' is-hero' : ''}`}>
          <span className="analytics-tile-label">{perfCopy.tiles[item]}</span>
          <span className="analytics-tile-value">{stats ? `${formatMedian(stats.median)} ${perfCopy.metrics[item].unit}` : ''}</span>
          <span className="analytics-tile-sub">{perfCopy.tileSub.median}</span>
        </div>
      ))}
      <div className="analytics-tile">
        <span className="analytics-tile-label">{perfCopy.tiles.turns}</span>
        <span className="analytics-tile-value">{turns || ''}</span>
        <span className="analytics-tile-sub">{perfCopy.tileSub.range}</span>
      </div>
    </div>

    {data.summaryError && <EmptyState size="card" className="analytics-alert" picture="alert" announcement="alert"
      title={data.summary ? perfCopy.previousSummary : perfCopy.summaryError}
      actions={[{ label: perfCopy.readAgain, icon: 'refresh', busy: data.summaryRetrying, onClick: data.retrySummary }]} />}
    {data.historyError && <EmptyState size="card" className="analytics-alert" picture="alert" announcement="alert"
      title={data.history ? perfCopy.previousHistory : perfCopy.historyError}
      actions={[{ label: perfCopy.readAgain, icon: 'refresh', busy: data.historyRetrying, onClick: data.retryHistory }]} />}

    <section className="analytics-card" aria-labelledby="analytics-comparison">
      <div className="analytics-card-head">
        <h2 id="analytics-comparison">{perfCopy.comparison}</h2>
        <span className="analytics-card-note">{perfCopy.comparisonNote}</span>
      </div>
      {loading && <div className="analytics-loading" aria-busy="true"><DelayedSkeletonRows loading rows={4} meta rowHeight={52} label={perfCopy.reading} /></div>}
      {!loading && empty && <EmptyState size="card" className="analytics-empty" picture="chart"
        title={rounds.length ? copy.emptyRangeTitle : perfCopy.empty}
        actions={hours === 168 ? undefined : [{ label: copy.emptyAction, intent: 'quiet', onClick: () => onShowRange(168) }]} />}
      {!loading && !empty && <>
        {!data.history && <p className="analytics-note">{perfCopy.summaryOnly}</p>}
        <PerfTable groups={shown} selected={current?.key ?? ''} colorOf={colorOf} gatewayOf={gatewayOf} onSelect={setSelected} />
      </>}
    </section>

    {current && <section className="analytics-card" aria-labelledby="analytics-trend">
      <div className="analytics-card-head">
        <i aria-hidden="true" className="analytics-dot" style={{ background: colorOf(current.key) }} />
        <h2 id="analytics-trend">{current.model ?? ''}<span className="analytics-card-note">
          {agentLabelOf(current.providerId)}{gatewayOf(current.providerId, current.model) ? ` · ${gatewayOf(current.providerId, current.model)}` : ''}
        </span></h2>
        <span className="analytics-card-note">{perfCopy.turnNote(current.samples[activeMetric].length)}</span>
        <Segmented className="analytics-metric" label={perfCopy.metricLabel} value={activeMetric}
          onChange={(next) => { setSelected(current.key); setMetric(next) }}
          options={LLM_METRICS.map((item) => ({ value: item, label: perfCopy.metrics[item].label }))} />
      </div>
      {current.samples[activeMetric].length
        ? <RoundScatter key={`${current.key}:${activeMetric}:${hours}`} samples={current.samples[activeMetric]}
          model={current.model ?? ''} metric={activeMetric} from={from} to={to} hours={hours} color={colorOf(current.key)} />
        : <EmptyState size="card" className="analytics-empty" picture="chart" announcement="polite"
          title={perfCopy.selectedEmpty(current.model ?? '', perfCopy.metrics[activeMetric].label)} />}
    </section>}

    <details className="analytics-basis">
      <summary>{perfCopy.basisTitle}</summary>
      <p>{perfCopy.basis}</p>
    </details>
  </>
}

function agentLabelOf(providerId?: string): string {
  return providerId ? PROVIDER_LABELS[providerId as keyof typeof PROVIDER_LABELS] ?? providerId : ''
}
