import { useEffect, useId, useMemo, useState } from 'react'
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
import { Notice } from './primitives/Notice'
import './llm-performance.css'

const RANGES: RangeHours[] = [1, 24, 168]
const PALETTE = 7

export function LlmPerformancePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId()
  const [summary, setSummary] = useState<LlmPerformanceSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [history, setHistory] = useState<LlmPerformanceHistory | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
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
    const loadSummary = async (): Promise<void> => {
      try {
        const next = await window.scry.llmPerformanceSummary()
        if (current) { setSummary(next); setSummaryError(null) }
      } catch (error) {
        if (current) { setSummary(null); setSummaryError(error instanceof Error ? error.message : String(error)) }
      } finally {
        if (current) timer = window.setTimeout(() => { void loadSummary() }, 1000)
      }
    }
    const loadHistory = async (): Promise<void> => {
      const request = ++historyRequest
      try {
        const next = await window.scry.llmPerformanceHistory()
        if (current && request === historyRequest) { setHistory(next); setHistoryError(null) }
      } catch (error) {
        if (current && request === historyRequest) {
          setHistory(null)
          setHistoryError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    void loadSummary()
    void loadHistory()
    const unsubscribe = window.scry.onDataUpdated?.(() => { void loadHistory() })
    return () => { current = false; window.clearTimeout(timer); unsubscribe?.() }
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
        {summaryError && <Notice tone="bad" className="llm-perf-alert" role="alert">{copy.summaryError(summaryError)}</Notice>}
        <section className="llm-perf-comparison" aria-labelledby={`${titleId}-comparison`}>
          <div className="llm-perf-section-head">
            <h3 id={`${titleId}-comparison`}>{copy.comparison}</h3>
          </div>
          {historyError ? <Notice tone="bad" className="llm-perf-alert" role="alert">{copy.historyError(historyError)}</Notice>
            : !history ? <div className="llm-perf-loading" aria-busy="true"><DelayedSkeletonRows loading rows={4} meta rowHeight={48} label={copy.reading} /></div>
              : !current ? <div className="llm-perf-empty">{rounds.length ? copy.emptyRange : copy.empty}</div>
                : <><ModelComparison groups={groups} selected={current.key} colorOf={colorOf} onSelect={selectGroup} />
                  <p className="llm-perf-truncated">{copy.metricUnavailable}</p></>}
          {oldestKept != null && oldestKept > from && <p className="llm-perf-truncated">{copy.truncated(history!.rows.length)}</p>}
        </section>
        {!historyError && history && current && <section className="llm-perf-detail" aria-labelledby={`${titleId}-detail`}>
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
            : <div className="llm-perf-empty">{copy.selectedEmpty(currentModel, copy.metrics[activeMetric].label)}</div>}
        </section>}
      </div>
    </ModalFrame>
  )
}
