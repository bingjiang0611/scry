import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { LlmMetric, LlmPerformanceHistory, LlmPerformanceSummary } from '@shared/llm-performance'
import { LLM_METRICS, llmComparisonRounds } from '@shared/llm-performance'
import { PROVIDER_LABELS } from '@shared/provider'
import { ModalFrame, requestModalClose } from './Modals'
import { DelayedSkeletonRows } from './primitives/Skeleton'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY } from '../constants/copy'
import { LLM_PERFORMANCE_COPY as copy } from '../constants/llm-performance-copy'
import { MetricChart, MetricHelp, ModelComparison } from './LlmPerformanceCharts'
import { compareModels, llmComparisonKey, type RangeHours } from './llm-performance-data'
import { EmptyState } from './primitives/EmptyState'
import './llm-performance.css'

const RANGES: RangeHours[] = [1, 24, 168]
const PALETTE = 7

export function LlmPerformancePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId()
  const [summary, setSummary] = useState<LlmPerformanceSummary | null>(null)
  const [summaryError, setSummaryError] = useState(false)
  const [history, setHistory] = useState<LlmPerformanceHistory | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [summaryRetrying, setSummaryRetrying] = useState(false)
  const [historyRetrying, setHistoryRetrying] = useState(false)
  const retrySummary = useRef<(() => void) | null>(null)
  const retryHistory = useRef<(() => void) | null>(null)
  const [hours, setHours] = useState<RangeHours>(24)
  const [metric, setMetric] = useState<LlmMetric>('speed')
  const [selected, setSelected] = useState<string | null>(null)
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => {
    const changed = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  useEffect(() => {
    if (!open || !visible) return
    let current = true
    let timer: number | undefined
    let historyRequest = 0
    let summaryPending = false
    const loadSummary = async (): Promise<void> => {
      if (summaryPending) return
      window.clearTimeout(timer)
      summaryPending = true
      try {
        const next = await window.scry.llmPerformanceSummary()
        if (current) { setSummary(next); setSummaryError(false) }
      } catch (error) {
        if (current) {
          if (!summaryFailed) console.error('[scry] performance summary read failed', error)
          summaryFailed = true
          setSummaryError(true)
        }
      } finally {
        summaryPending = false
        if (current) {
          setSummaryRetrying(false)
          timer = window.setTimeout(() => { void loadSummary() }, 1000)
        }
      }
    }
    let summaryFailed = false
    const loadHistory = async (): Promise<void> => {
      const request = ++historyRequest
      try {
        const next = await window.scry.llmPerformanceHistory()
        if (current && request === historyRequest) { setHistory(next); setHistoryError(false) }
      } catch (error) {
        if (current && request === historyRequest) {
          console.error('[scry] performance history read failed', error)
          setHistoryError(true)
        }
      } finally {
        if (current && request === historyRequest) setHistoryRetrying(false)
      }
    }
    retrySummary.current = () => { setSummaryRetrying(true); void loadSummary() }
    retryHistory.current = () => { setHistoryRetrying(true); void loadHistory() }
    void loadSummary()
    void loadHistory()
    const unsubscribe = window.scry.onDataUpdated?.(() => { void loadHistory() })
    return () => {
      current = false; window.clearTimeout(timer); unsubscribe?.()
      retrySummary.current = null; retryHistory.current = null
    }
  }, [open, visible])

  const rounds = useMemo(() => llmComparisonRounds(history?.rows ?? [], summary?.sessions), [history, summary])
  const colorOf = useMemo(() => {
    const keys = new Set(rounds.map(round => llmComparisonKey(round.providerId, round.model)))
    const colors = new Map([...keys].map((key, index) => [key, index % PALETTE]))
    return (key: string): string => `var(--llm-model-${colors.get(key) ?? 0})`
  }, [rounds])
  const to = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
  const from = to - hours * 3_600_000
  const groups = useMemo(() => compareModels(rounds.filter(round => round.ts >= from && round.ts <= to)), [rounds, from, to])
  const current = groups.find(group => group.key === selected) ??
    groups.reduce<(typeof groups)[number] | undefined>((best, group) =>
      !best || group.samples[metric].length > best.samples[metric].length ? group : best, undefined)
  const currentModel = current?.model ?? copy.unknownModel
  const activeMetric = current && !selected && !current.samples[metric].length
    ? LLM_METRICS.find(item => current.samples[item].length) ?? metric : metric
  const currentSamples = current?.samples[activeMetric] ?? []
  const selectGroup = (key: string): void => {
    setSelected(key)
    const group = groups.find(candidate => candidate.key === key)
    if (group) setMetric(group.samples[activeMetric].length ? activeMetric
      : LLM_METRICS.find(item => group.samples[item].length) ?? activeMetric)
  }
  const oldestKept = history?.truncated && history.rows.length ? Date.parse(history.rows.at(-1)!.ts) : undefined
  if (!open) return null
  return (
    <ModalFrame labelledBy={titleId} className="llm-perf-modal" onClose={onClose}>
      <header className="llm-perf-head">
        <h2 id={titleId}>{copy.title}</h2>
        <div className="llm-perf-range" role="group" aria-label={copy.rangeLabel}>
          {RANGES.map(range => <button key={range} type="button" aria-pressed={hours === range} onClick={() => setHours(range)}>{copy.ranges[range]}</button>)}
        </div>
        <ModalCloseButton onClick={() => requestModalClose()} aria-label={MODAL_COPY.closeLlmPerformance} />
      </header>
      <div className="llm-perf-body">
        {summaryError && <EmptyState size="card" className="llm-perf-alert" picture="alert" announcement="alert"
          title={summary ? copy.previousSummary : copy.summaryError}
          actions={[{ label: copy.readAgain, icon: 'refresh', busy: summaryRetrying, onClick: () => retrySummary.current?.() }]} />}
        <section className="llm-perf-comparison" aria-labelledby={`${titleId}-comparison`}>
          <div className="llm-perf-section-head">
            <h3 id={`${titleId}-comparison`}>{copy.comparison}</h3>
          </div>
          {historyError && <EmptyState size="card" className="llm-perf-alert" picture="alert" announcement="alert"
            title={history ? copy.previousHistory : copy.historyError}
            actions={[{ label: copy.readAgain, icon: 'refresh', busy: historyRetrying, onClick: () => retryHistory.current?.() }]} />}
          {!history && !historyError && !current && <div className="llm-perf-loading" aria-busy="true"><DelayedSkeletonRows loading rows={4} meta rowHeight={48} label={copy.reading} /></div>}
          {current ? <>
            {!history && <p className="llm-perf-truncated">{copy.summaryOnly}</p>}
            <ModelComparison groups={groups} selected={current.key} colorOf={colorOf} onSelect={selectGroup} />
            <p className="llm-perf-truncated">{copy.metricUnavailable}</p>
          </> : history && !historyError && !summaryError && <EmptyState size="card" className="llm-perf-empty"
            picture={rounds.length ? undefined : 'chart'} announcement={rounds.length ? 'polite' : undefined}
            title={rounds.length ? copy.emptyRange : copy.empty} />}
          {oldestKept != null && oldestKept > from && <p className="llm-perf-truncated">{copy.truncated(history!.rows.length)}</p>}
        </section>
        {current && <section className="llm-perf-detail" aria-labelledby={`${titleId}-detail`}>
          <div className="llm-perf-detail-head">
            <div>
              <h3 id={`${titleId}-detail`} className="llm-perf-detail-title"><i aria-hidden="true" style={{ background: colorOf(current.key) }} />{currentModel}</h3>
              <span className="llm-perf-provider">{current.providerId ? PROVIDER_LABELS[current.providerId] : copy.unknownProvider}</span>
            </div>
            <div className="llm-perf-metric" role="group" aria-label={copy.metricLabel}>
              {LLM_METRICS.map(item => <button key={item} type="button" aria-pressed={activeMetric === item} onClick={() => { setSelected(current.key); setMetric(item) }}>{copy.metrics[item].label}</button>)}
            </div>
          </div>
          <div className="llm-perf-chart-meta"><MetricHelp label={copy.intervals[hours]} text={copy.intervalHelp} /></div>
          {activeMetric === 'firstOutput' && <p className="llm-perf-truncated">{copy.firstOutputBasis}</p>}
          {currentSamples.length ? <MetricChart key={`${current.key}:${activeMetric}:${hours}`} samples={currentSamples} model={currentModel} metric={activeMetric}
            from={from} to={to} hours={hours} color={colorOf(current.key)} />
            : <EmptyState size="card" className="llm-perf-empty" picture="chart" announcement="polite"
              title={copy.selectedEmpty(currentModel, copy.metrics[activeMetric].label)} />}
        </section>}
      </div>
    </ModalFrame>
  )
}
