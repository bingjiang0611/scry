import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { LlmMetric, LlmMetricSample, LlmPerformanceHistory, LlmPerformanceSummary, LlmRunningSession } from '@shared/llm-performance'
import { groupRunningLlmSessions, llmMetricSamples, quantile, smoothLlmMetric } from '@shared/llm-performance'
import { ModalFrame, requestModalClose } from './Modals'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY } from '../constants/copy'
import { LLM_RUNNING_MODELS_COPY as runningCopy, LLM_PERFORMANCE_COPY as copy } from '../constants/copy'
import { Icon } from './primitives/Icon'
import './llm-performance.css'

type RangeHours = 1 | 24 | 168
const RANGES: RangeHours[] = [1, 24, 168]
// Smoothing bandwidth per range: wide enough to join neighbouring rounds, narrow enough to keep shifts visible.
const BANDWIDTH_MINUTES: Record<RangeHours, number> = { 1: 4, 24: 40, 168: 240 }
const GRID = 180
const PALETTE = 7

const formatSpeed = (value: number): string => value >= 100 ? Math.round(value).toString() : value.toFixed(1)
const formatSeconds = (value: number): string => value >= 100 ? Math.round(value).toString() : value.toFixed(1)
const METRICS = {
  speed: { ...copy.metrics.speed, format: formatSpeed },
  firstToken: { ...copy.metrics.firstToken, format: formatSeconds }
}
/** Round up to a readable axis maximum: 1/2/5 × 10^n. */
function niceCeil(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value))
  return [1, 2, 5, 10].map(step => step * power).find(candidate => candidate >= value)!
}
const pad = (value: number): string => String(value).padStart(2, '0')
const clock = (ts: number): string => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const day = (ts: number): string => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}` }

function stateLabel(session: LlmRunningSession): string {
  if (session.state === 'streaming') return runningCopy.states.streaming
  if (session.state === 'tool') return runningCopy.states.tool
  if (session.state === 'complete') return runningCopy.states.complete
  return session.outputStarted ? runningCopy.states.waiting : runningCopy.states.firstOutput
}

function modelState(sessions: readonly LlmRunningSession[]): { label: string; streaming: boolean } {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const label = stateLabel(session)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return {
    label: runningCopy.stateSummary([...counts]),
    streaming: sessions.every(session => session.state === 'streaming')
  }
}

/** Monotone cubic (Fritsch–Carlson): smooth without overshooting the sampled values. */
function smoothPath(points: Array<[number, number]>): string {
  const n = points.length
  const slope: number[] = []
  const tangent: number[] = []
  for (let i = 0; i < n - 1; i++) slope.push((points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]))
  tangent[0] = slope[0]
  tangent[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { tangent[i] = tangent[i + 1] = 0; continue }
    const a = tangent[i] / slope[i]
    const b = tangent[i + 1] / slope[i]
    const h = a * a + b * b
    if (h > 9) { const t = 3 / Math.sqrt(h); tangent[i] = t * a * slope[i]; tangent[i + 1] = t * b * slope[i] }
  }
  let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const dx = (points[i + 1][0] - points[i][0]) / 3
    path += ` C${(points[i][0] + dx).toFixed(1)},${(points[i][1] + tangent[i] * dx).toFixed(1)} ` +
      `${(points[i + 1][0] - dx).toFixed(1)},${(points[i + 1][1] - tangent[i + 1] * dx).toFixed(1)} ` +
      `${points[i + 1][0].toFixed(1)},${points[i + 1][1].toFixed(1)}`
  }
  return path
}

function MetricHelp({ label, text }: { label: string; text: string }) {
  return (
    <details className="llm-perf-help">
      <summary tabIndex={0}>{label}<Icon name="info" /></summary>
      <p>{text}</p>
    </details>
  )
}

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
  const samples = metric === 'speed' ? speedSamples : firstTokenSamples
  // Stable colours: most-used model first, independent of the selected range and metric.
  const colorOf = useMemo(() => {
    const counts = new Map<string, number>()
    for (const sample of speedSamples) counts.set(sample.model, (counts.get(sample.model) ?? 0) + 1)
    for (const sample of firstTokenSamples) counts.set(sample.model, counts.get(sample.model) ?? 0)
    const order = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!)
    return (model: string): string => `var(--llm-model-${Math.max(0, order.indexOf(model)) % PALETTE})`
  }, [speedSamples, firstTokenSamples])
  // The right edge follows the clock once per minute; running measurements refresh with the summary.
  const minute = Math.floor(Date.now() / 60_000)
  const to = minute * 60_000 + 60_000
  const from = to - hours * 3_600_000
  const within = (list: LlmMetricSample[]): LlmMetricSample[] => list.filter(sample => sample.ts >= from && sample.ts <= to)
  const inRange = useMemo(() => within(samples), [samples, from, to])
  const speedInRange = useMemo(() => within(speedSamples), [speedSamples, from, to])
  const firstTokenInRange = useMemo(() => within(firstTokenSamples), [firstTokenSamples, from, to])
  const legendModels = [...new Set(inRange.map(sample => sample.model))]
  const selectionMissing = selected != null && !legendModels.includes(selected)
  if (selectionMissing) legendModels.push(selected)
  const oldestKept = history?.truncated && history.rows.length ? Date.parse(history.rows.at(-1)!.ts) : undefined
  const sessions = summary?.sessions ?? []
  const runningModels = useMemo(() => groupRunningLlmSessions(summary?.sessions ?? []), [summary])

  if (!open) return null
  return (
    <ModalFrame labelledBy={titleId} className="llm-perf-modal" onClose={onClose}>
      <header className="llm-perf-head">
        <h2 id={titleId}>{copy.title}</h2>
        {!sessions.length && <span className="llm-perf-live">{summaryError ? copy.summaryUnknown : summary ? copy.noSessions : copy.reading}</span>}
        <div className="llm-perf-range" role="group" aria-label={copy.rangeLabel}>
          {RANGES.map(range => (
            <button key={range} type="button" aria-pressed={hours === range} onClick={() => setHours(range)}>{copy.ranges[range]}</button>
          ))}
        </div>
        <ModalCloseButton onClick={() => requestModalClose()} aria-label={MODAL_COPY.closeLlmPerformance} />
      </header>
      <div className="llm-perf-body">
        {summaryError && <p className="llm-perf-alert" role="alert">{copy.summaryError(summaryError)}</p>}
        {sessions.length > 0 && (
          <section className="llm-perf-running" aria-label={runningCopy.region}>
            <h3 className="llm-perf-live on"><i aria-hidden="true" />{runningCopy.heading(sessions.length)}</h3>
            {runningModels.map(group => {
              const state = modelState(group.sessions)
              const first = group.sessions[0]
              const speedCount = group.sessions.filter(session => session.tokensPerSecond != null).length
              const waitCount = group.sessions.filter(session => session.firstTokenMs != null).length
              return (
                <details key={group.key} className="llm-perf-run">
                  <summary className="llm-perf-run-summary" tabIndex={0}>
                    <i aria-hidden="true" style={group.model ? { background: colorOf(group.model) } : undefined} />
                    <div className="llm-perf-run-model">
                      <div><b>{group.model ?? (first.providerId ? copy.providers[first.providerId] : runningCopy.unknownProvider)}</b>
                        <span>{runningCopy.sessions(group.sessions.length)}</span></div>
                      <span className={`llm-perf-state${state.streaming ? ' gen' : ''}`}>{state.label}</span>
                    </div>
                    <div className="llm-perf-run-speed"><span>{runningCopy.average}</span>
                      <div>{group.tokensPerSecond != null ? <><strong style={group.model ? { color: colorOf(group.model) } : undefined}>{formatSpeed(group.tokensPerSecond)}</strong><small>{runningCopy.speedUnit}</small></> : copy.missing}</div>
                    </div>
                    <div className="llm-perf-run-speed"><span>{runningCopy.firstToken}</span>
                      <div>{group.firstTokenMs != null ? <><strong>{formatSeconds(group.firstTokenMs / 1000)}</strong><small>{runningCopy.seconds}</small></> : copy.missing}</div>
                    </div>
                    <Icon name="chevronDown" className="llm-perf-disclosure" />
                  </summary>
                  <div className="llm-perf-run-detail">
                    <p>{runningCopy.coverage(speedCount, waitCount, group.sessions.length)}</p>
                    <ul>{group.sessions.map(session => (
                      <li key={session.key}>
                        <div><b>{session.providerId ? copy.providers[session.providerId] : runningCopy.unknownProvider}</b>
                          <span>{session.cwd ?? runningCopy.unknownWorkspace}</span></div>
                        <span>{stateLabel(session)}</span>
                      </li>
                    ))}</ul>
                  </div>
                </details>
              )
            })}
          </section>
        )}
        <section className="llm-perf-history">
          <div className="llm-perf-section-head">
            <h3>{copy.history(copy.ranges[hours])}</h3>
            {!historyError && history && [...speedInRange, ...firstTokenInRange].some(sample => sample.provisional) &&
              <MetricHelp label={copy.provisional} text={copy.provisionalHelp} />}
            {oldestKept != null && oldestKept > from && <small className="llm-perf-truncated">{copy.truncated(history!.rows.length)}</small>}
          </div>
          <div className="llm-perf-chart-controls">
            <div className="llm-perf-metric" role="group" aria-label={copy.metricLabel}>
              {(['speed', 'firstToken'] as const).map(item => (
                <button key={item} type="button" aria-pressed={metric === item} onClick={() => setMetric(item)}>{METRICS[item].label}</button>
              ))}
            </div>
            <span className="llm-perf-unit">{METRICS[metric].unit}</span>
          </div>
          {!historyError && history && legendModels.length > 0 && <div className="llm-perf-legend" role="group" aria-label={copy.legend}>
            {legendModels.map(model => (
              <button key={model} type="button" aria-pressed={selected === model} onClick={() => setSelected(current => current === model ? null : model)}>
                <i aria-hidden="true" style={{ background: colorOf(model) }} />{model}
              </button>
            ))}
          </div>}
          {historyError
            ? <p className="llm-perf-alert" role="alert">{copy.historyError(historyError)}</p>
            : !history ? <div className="llm-perf-empty">{copy.reading}</div>
              : selectionMissing ? <div className="llm-perf-empty">{copy.selectedEmpty(selected, METRICS[metric].label)}</div>
                : !inRange.length ? <div className="llm-perf-empty">{samples.length ? copy.emptyRange : copy.empty}</div>
                  : <MetricChart samples={inRange} metric={metric} from={from} to={to} hours={hours} selected={selected} colorOf={colorOf} />}
          {!historyError && speedInRange.length > 0 && <div className="llm-perf-comparison">
            <h3>{copy.comparison}</h3>
            <ModelComparison samples={speedInRange} firstToken={firstTokenInRange} selected={selected} colorOf={colorOf}
              onSelect={model => setSelected(current => current === model ? null : model)} />
          </div>}
        </section>
      </div>
    </ModalFrame>
  )
}

function MetricChart({ samples, metric, from, to, hours, selected, colorOf }: {
  samples: LlmMetricSample[]
  metric: LlmMetric
  from: number
  to: number
  hours: RangeHours
  selected: string | null
  colorOf: (model: string) => string
}) {
  const box = useRef<HTMLDivElement>(null)
  const tipId = useId()
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const node = box.current!
    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    observer.observe(node)
    setWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [])
  const series = useMemo(() => {
    const byModel = new Map<string, LlmMetricSample[]>()
    for (const sample of samples) byModel.set(sample.model, [...byModel.get(sample.model) ?? [], sample])
    return [...byModel].map(([model, own]) => {
      const points = smoothLlmMetric(own, from, to, BANDWIDTH_MINUTES[hours] * 60_000, GRID)
      return { model, points }
    })
  }, [samples, from, to, hours])
  const measured = series.flatMap(item => item.points.flatMap(point => point.value == null ? [] : [point.value]))
  // A single extreme round must not flatten every other curve; higher values clamp to the top.
  const yMax = metric === 'speed'
    ? Math.max(10, Math.ceil(quantile(measured, 0.98) * 1.1 / 20) * 20)
    : niceCeil(Math.max(1, quantile(measured, 0.98) * 1.1))
  const H = 208, L = 30, R = 12, T = 12, B = 22
  const x = (ts: number): number => L + (ts - from) / (to - from) * (width - L - R)
  const y = (value: number): number => T + (1 - Math.min(value, yMax) / yMax) * (H - T - B)
  const label = (ts: number): string => hours > 24 ? day(ts) : clock(ts)
  const firstMidnight = new Date(from).setHours(24, 0, 0, 0)
  const ticks = hours > 24
    ? Array.from({ length: 7 }, (_, i) => new Date(firstMidnight).setDate(new Date(firstMidnight).getDate() + i)).filter(ts => ts <= to)
    : Array.from({ length: 5 }, (_, i) => from + (to - from) * i / 4)
  const hits = hover == null ? [] : series
    .filter(item => item.points[hover].value != null && (!selected || item.model === selected))
    .sort((a, b) => b.points[hover].value! - a.points[hover].value!)
  const hoverTs = hover == null ? 0 : series[0].points[hover].ts
  return (
    <div className="llm-perf-chart" ref={box}>
      {width > 0 && (
        <svg viewBox={`0 0 ${width} ${H}`} role="img" aria-label={METRICS[metric].chartLabel} tabIndex={0}
          aria-describedby={hover == null ? undefined : tipId}
          onFocus={() => setHover(GRID - 1)} onBlur={() => setHover(null)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            setHover(current => event.key === 'Home' ? 0 : event.key === 'End' ? GRID - 1
              : Math.max(0, Math.min(GRID - 1, (current ?? GRID - 1) + (event.key === 'ArrowLeft' ? -1 : 1))))
          }}
          onMouseMove={event => {
            const px = event.clientX - event.currentTarget.getBoundingClientRect().left
            setHover(Math.max(0, Math.min(GRID - 1, Math.round((px - L) / (width - L - R) * (GRID - 1)))))
          }}
          onMouseLeave={() => setHover(null)}>
          <g className="llm-perf-axis">
            {[0, yMax / 2, yMax].map(value => (
              <g key={value}><line x1={L} x2={width - R} y1={y(value)} y2={y(value)} />
                <text x={L - 8} y={y(value) + 3.5} textAnchor="end">{value}</text></g>
            ))}
            {ticks.map(ts => <text key={ts} x={x(ts)} y={H - 5} textAnchor="middle">{label(ts)}</text>)}
          </g>
          {series.map(item => (
            <path key={item.model} className={`llm-perf-line${selected && item.model !== selected ? ' dim' : ''}`}
              d={smoothPath(item.points.map(point => [x(point.ts), y(point.drawn)]))}
              stroke={colorOf(item.model)} strokeWidth={selected === item.model ? 2.8 : 2.4} />
          ))}
          {hover != null && <>
            <line className="llm-perf-cross" x1={x(hoverTs)} x2={x(hoverTs)} y1={T} y2={H - B} />
            {hits.map(item => <circle key={item.model} cx={x(hoverTs)} cy={y(item.points[hover].drawn)} r={3.5}
              fill={colorOf(item.model)} stroke="var(--panel)" strokeWidth={1.5} />)}
          </>}
          <rect x={L} y={T} width={Math.max(0, width - L - R)} height={H - T - B} fill="transparent" />
        </svg>
      )}
      {hover != null && (
        <div id={tipId} className="llm-perf-tip" style={{ left: Math.min(Math.max(x(hoverTs), 110), width - 110), top: T }}>
          <div className="llm-perf-tip-time">{hours > 24 ? `${day(hoverTs)} ${clock(hoverTs)}` : clock(hoverTs)}</div>
          {hits.length
            ? hits.map(item => (
              <div key={item.model} className="llm-perf-tip-row"><i style={{ background: colorOf(item.model) }} />{item.model}
                <b>{METRICS[metric].format(item.points[hover].value!)}</b><small>{METRICS[metric].unit}</small></div>
            ))
            : <div className="llm-perf-tip-row">{copy.idle}</div>}
        </div>
      )}
    </div>
  )
}

function ModelComparison({ samples, firstToken, selected, colorOf, onSelect }: {
  samples: LlmMetricSample[]
  firstToken: LlmMetricSample[]
  selected: string | null
  colorOf: (model: string) => string
  onSelect: (model: string) => void
}) {
  const groups = useMemo(() => {
    const valuesByModel = (list: LlmMetricSample[]): Map<string, number[]> => {
      const byModel = new Map<string, number[]>()
      for (const sample of list) byModel.set(sample.model, [...byModel.get(sample.model) ?? [], sample.value])
      return byModel
    }
    const waits = valuesByModel(firstToken)
    return [...valuesByModel(samples)].map(([model, speeds]) => {
      const wait = waits.get(model)
      return {
        model, running: samples.filter(sample => sample.model === model && sample.provisional).length,
        rounds: speeds.length, p25: quantile(speeds, 0.25), p50: quantile(speeds, 0.5), p75: quantile(speeds, 0.75),
        firstToken: wait ? quantile(wait, 0.5) : undefined
      }
    }).sort((a, b) => b.p50 - a.p50)
  }, [samples, firstToken])
  const max = Math.max(10, Math.ceil(Math.max(...groups.map(group => group.p75)) / 10) * 10)
  const percent = (value: number): string => `${Math.min(value, max) / max * 100}%`
  return (
    <div className="llm-perf-models">
      <div className="llm-perf-mhead"><span>{copy.columns.model}</span>
        <MetricHelp label={copy.columns.distribution} text={copy.distributionHelp} />
        <span>{copy.columns.speed}</span><span>{copy.columns.firstToken}</span>
        <MetricHelp label={copy.columns.rounds} text={copy.roundsHelp} /></div>
      {groups.map(group => (
        <button key={group.model} type="button" className="llm-perf-mrow" aria-pressed={selected === group.model} onClick={() => onSelect(group.model)}>
          <span className="llm-perf-mname"><i style={{ background: colorOf(group.model) }} /><b>{group.model}</b></span>
          <span className="llm-perf-bar" aria-hidden="true"><span className="track" />
            <span className="iqr" style={{ left: percent(group.p25), width: `calc(${percent(group.p75)} - ${percent(group.p25)})`, background: colorOf(group.model) }} />
            <span className="p50" style={{ left: percent(group.p50), background: colorOf(group.model) }} /></span>
          <span className="llm-perf-speed"><strong>{formatSpeed(group.p50)}</strong><small>{copy.metrics.speed.unit}</small></span>
          <span className="llm-perf-speed llm-perf-wait">{group.firstToken != null
            ? <><strong>{formatSeconds(group.firstToken)}</strong><small>{copy.metrics.firstToken.unit}</small></>
            : <small>{copy.missing}</small>}</span>
          <span className="llm-perf-rounds" aria-label={copy.roundsLabel(group.rounds - group.running, group.running)}>{copy.rounds(group.rounds - group.running, group.running)}</span>
        </button>
      ))}
      <div className="llm-perf-scale"><span /><div><span>0</span><span>{max / 2}</span><span>{max}</span></div></div>
    </div>
  )
}
