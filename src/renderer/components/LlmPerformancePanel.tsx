import { useEffect, useId, useMemo, useState } from 'react'
import type { LlmMetric, LlmMetricSample, LlmPerformanceHistory, LlmPerformanceSummary } from '@shared/llm-performance'
import { llmMetricSamples } from '@shared/llm-performance'
import { ModalFrame, requestModalClose } from './Modals'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY } from '../constants/copy'
import { LLM_PERFORMANCE_COPY as copy } from '../constants/llm-performance-copy'
import { MetricChart, MetricHelp, ModelComparison } from './LlmPerformanceCharts'
import { compareModels, formatMetric, type RangeHours } from './llm-performance-data'
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

  const speedSamples = useMemo(() => llmMetricSamples(history?.rows ?? [], 'speed', summary?.sessions), [history, summary])
  const firstTokenSamples = useMemo(() => llmMetricSamples(history?.rows ?? [], 'firstToken', summary?.sessions), [history, summary])
  // Stable across range/metric changes; keep the existing model-colour mapping.
  const colorOf = useMemo(() => {
    const counts = new Map<string, number>()
    for (const sample of speedSamples) counts.set(sample.model, (counts.get(sample.model) ?? 0) + 1)
    for (const sample of firstTokenSamples) counts.set(sample.model, counts.get(sample.model) ?? 0)
    const order = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!)
    return (model: string): string => `var(--llm-model-${Math.max(0, order.indexOf(model)) % PALETTE})`
  }, [speedSamples, firstTokenSamples])
  const to = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
  const from = to - hours * 3_600_000
  const groups = useMemo(() => {
    const within = (list: LlmMetricSample[]): LlmMetricSample[] => list.filter(sample => sample.ts >= from && sample.ts <= to)
    return compareModels(within(speedSamples), within(firstTokenSamples))
  }, [speedSamples, firstTokenSamples, from, to])
  const current = groups.find(group => group.model === selected) ??
    [...groups].sort((a, b) => Math.max(b.speed.length, b.firstToken.length) - Math.max(a.speed.length, a.firstToken.length))[0]
  const currentSamples = current?.[metric] ?? []
  const provisional = groups.some(group => group.speedSummary?.provisional || group.waitSummary?.provisional)
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
        {summaryError && <p className="llm-perf-alert" role="alert">{copy.summaryError(summaryError)}</p>}
        <section className="llm-perf-comparison" aria-labelledby={`${titleId}-comparison`}>
          <div className="llm-perf-section-head">
            <h3 id={`${titleId}-comparison`}>{copy.comparison}</h3>
            <div className="llm-perf-notices">
              {!historyError && history && provisional && <MetricHelp label={copy.provisional} text={copy.provisionalHelp} />}
              <MetricHelp label={copy.explanation} text={copy.distributionHelp} />
            </div>
          </div>
          {historyError ? <p className="llm-perf-alert" role="alert">{copy.historyError(historyError)}</p>
            : !history ? <div className="llm-perf-empty">{copy.reading}</div>
              : !current ? <div className="llm-perf-empty">{speedSamples.length || firstTokenSamples.length ? copy.emptyRange : copy.empty}</div>
                : <ModelComparison groups={groups} selected={current.model} colorOf={colorOf} onSelect={setSelected} />}
          {oldestKept != null && oldestKept > from && <p className="llm-perf-truncated">{copy.truncated(history!.rows.length)}</p>}
        </section>
        {!historyError && history && current && <section className="llm-perf-detail" aria-labelledby={`${titleId}-detail`}>
          <div className="llm-perf-detail-head">
            <div>
              <h3 id={`${titleId}-detail`} className="llm-perf-detail-title"><i aria-hidden="true" style={{ background: colorOf(current.model) }} />{current.model}</h3>
              <p className="llm-perf-detail-summary">{current.waitSummary ? copy.firstTokenSummary(formatMetric(current.waitSummary.median)) : copy.missingFirstToken}</p>
            </div>
            <div className="llm-perf-metric" role="group" aria-label={copy.metricLabel}>
              {(['speed', 'firstToken'] as const).map(item => <button key={item} type="button" aria-pressed={metric === item} onClick={() => setMetric(item)}>{copy.metrics[item].label}</button>)}
            </div>
          </div>
          <div className="llm-perf-chart-meta"><span className="llm-perf-unit">{copy.metrics[metric].unit}</span><MetricHelp label={copy.intervals[hours]} text={copy.intervalHelp} /></div>
          {currentSamples.length ? <MetricChart key={`${current.model}:${metric}:${hours}`} samples={currentSamples} model={current.model} metric={metric}
            from={from} to={to} hours={hours} color={colorOf(current.model)} />
            : <div className="llm-perf-empty">{copy.selectedEmpty(current.model, copy.metrics[metric].label)}</div>}
        </section>}
      </div>
    </ModalFrame>
  )
}
