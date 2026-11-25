import { useState } from 'react'
import type { UsageAnalytics, UsageAnalyticsRangeDays } from '@shared/trace'
import type { UsageAgentId } from '@shared/usage-identity'
import { ANALYTICS_COPY as copy } from '../constants/analytics-copy'
import { LLM_PERFORMANCE_COPY as perfCopy } from '../constants/llm-performance-copy'
import { Tabs } from './primitives/Tabs'
import { Segmented } from './primitives/Segmented'
import { EmptyState } from './primitives/EmptyState'
import { DelayedSkeletonRows } from './primitives/Skeleton'
import { AnalyticsPerformanceTab } from './AnalyticsPerformanceTab'
import { AnalyticsCostTab } from './AnalyticsCostTab'
import {
  COST_RANGES, PERFORMANCE_RANGES, DEFAULT_PERFORMANCE_RANGE,
  agentOptions, costRangeFor, performanceRangeFor,
  type AgentFilter, type AnalyticsTab, type CostMetric, type PerformanceRange
} from './analytics-data'
import { PROVIDER_LABELS } from '@shared/provider'

const AGENTS: UsageAgentId[] = ['pi', 'claude', 'codex', 'qoder', 'opencode', 'antigravity']

export type AnalyticsViewProps = {
  analytics?: UsageAnalytics
  rangeDays: UsageAnalyticsRangeDays
  loading: boolean
  creditsPending?: boolean
  error?: string | null
  tab?: AnalyticsTab
  onTabChange?: (tab: AnalyticsTab) => void
  onRangeChange: (rangeDays: UsageAnalyticsRangeDays) => void
  onRefresh: () => void
}

/**
 * 「分析」把 LLM 性能与成本与用量合成一页：标签切换整页，Agent 与时间范围
 * 是共用的筛选；Agent 保留，时间范围只在另一页也有同一档时才沿用。
 */
export function AnalyticsView({ analytics, rangeDays, loading, creditsPending = false, error, tab: controlledTab, onTabChange, onRangeChange, onRefresh }: AnalyticsViewProps) {
  const [ownTab, setOwnTab] = useState<AnalyticsTab>('performance')
  const [hours, setHours] = useState<PerformanceRange>(DEFAULT_PERFORMANCE_RANGE)
  const [agent, setAgent] = useState<AgentFilter>('all')
  const [metric, setMetric] = useState<CostMetric>('cost')
  const tab = controlledTab ?? ownTab
  const setTab = (next: AnalyticsTab): void => {
    setOwnTab(next)
    onTabChange?.(next)
    if (next === 'cost') onRangeChange(costRangeFor(hours))
    else setHours(performanceRangeFor(rangeDays))
  }
  const options = agentOptions(analytics, AGENTS)
  const stale = analytics != null && analytics.rangeDays !== rangeDays
  const targetRange = tab === 'performance' ? perfCopy.ranges[hours] : copy.costRanges[rangeDays]
  return <main className="analytics-page" aria-busy={loading}>
    <div className="analytics-shell">
      <header className="analytics-header">
        <h1 className="analytics-title">{copy.title}</h1>
        <Tabs className="analytics-tabs" label={copy.tabsLabel} value={tab} onChange={setTab}
          items={[{ value: 'performance', label: copy.tabs.performance }, { value: 'cost', label: copy.tabs.cost }]} />
        <div className="analytics-filters">
          <label className="analytics-filter">
            <span>{copy.agentFilter}</span>
            <select value={agent} onChange={(event) => setAgent(event.target.value as AgentFilter)}>
              <option value="all">{copy.allAgents}</option>
              {options.map((option) => <option key={option} value={option}>{PROVIDER_LABELS[option]}</option>)}
            </select>
          </label>
          <Segmented className="analytics-range" label={copy.rangeLabel} value={tab === 'performance' ? hours : rangeDays}
            onChange={(next) => {
              if (tab === 'performance') setHours(next as PerformanceRange)
              else onRangeChange(next as UsageAnalyticsRangeDays)
            }}
            options={tab === 'performance'
              ? PERFORMANCE_RANGES.map((value) => ({ value, label: perfCopy.ranges[value] }))
              : COST_RANGES.map((value) => ({ value, label: copy.costRanges[value] }))} />
        </div>
      </header>

      {stale && <p className="analytics-note is-stale" role="status">{copy.staleRange(targetRange, analytics.fromDay, analytics.toDay)}</p>}
      {creditsPending && <p className="analytics-note">{copy.creditsPending}</p>}
      {error && <EmptyState size="card" className="analytics-alert" picture="alert" announcement="alert"
        title={analytics ? copy.refreshFailed : copy.readFailed} description={copy.readFailedDetail}
        actions={[{ label: copy.retry, icon: 'refresh', onClick: onRefresh }]} />}

      {loading && !analytics
        ? <div className="analytics-skeleton" aria-busy="true">
          <DelayedSkeletonRows loading rows={4} label={copy.loading} rowHeight={64} meta />
          <DelayedSkeletonRows loading rows={6} label={copy.loading} rowHeight={40} />
        </div>
        : tab === 'performance'
          ? <AnalyticsPerformanceTab analytics={analytics} hours={hours} agent={agent} onShowRange={(next) => setHours(next)} />
          : analytics && <AnalyticsCostTab analytics={analytics} metric={metric} onMetric={setMetric} agent={agent}
            onShowRange={(next) => onRangeChange(next)} />}
      {!loading && !analytics && !error && <EmptyState size="page" className="analytics-empty" picture="chart"
        title={copy.unavailable} description={copy.databaseUnavailable} />}
    </div>
  </main>
}
