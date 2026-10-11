import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { LlmMetric, LlmMetricSample, LlmPerformanceHistory, LlmPerformanceSummary, LlmRunningSession } from '@shared/llm-performance'
import { llmMetricSamples, quantile, smoothLlmMetric } from '@shared/llm-performance'
import type { ProviderId } from '@shared/provider'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'
import './llm-performance.css'

type RangeHours = 1 | 24 | 168
const RANGES: Array<{ hours: RangeHours; label: string }> = [
  { hours: 1, label: '1 小时' }, { hours: 24, label: '24 小时' }, { hours: 168, label: '7 天' }
]
// Smoothing bandwidth per range: wide enough to join neighbouring rounds, narrow enough to keep shifts visible.
const BANDWIDTH_MINUTES: Record<RangeHours, number> = { 1: 4, 24: 40, 168: 240 }
const GRID = 180
const PALETTE = 7
const providerName: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', qoder: 'Qoder', opencode: 'OpenCode', pi: 'Pi' }

const formatSpeed = (value: number): string => value >= 100 ? Math.round(value).toString() : value.toFixed(1)
const formatSeconds = (value: number): string => value >= 100 ? Math.round(value).toString() : value.toFixed(1)
const METRICS: Record<LlmMetric, { label: string; unit: string; format: (value: number) => string; chartLabel: string }> = {
  speed: { label: '输出速度', unit: 'token/s', format: formatSpeed, chartLabel: '各模型输出速度曲线' },
  firstToken: { label: '首 token', unit: '秒', format: formatSeconds, chartLabel: '各模型首 token 等待曲线' }
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
  if (session.state === 'streaming') return '生成中'
  if (session.state === 'tool') return '工具执行'
  if (session.state === 'complete') return '收尾中'
  return session.outputStarted ? '等待模型' : '等待首次输出'
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

  const speedSamples = useMemo(() => llmMetricSamples(history?.rows ?? [], 'speed'), [history])
  const firstTokenSamples = useMemo(() => llmMetricSamples(history?.rows ?? [], 'firstToken'), [history])
  const samples = metric === 'speed' ? speedSamples : firstTokenSamples
  // Stable colours: most-used model first, independent of the selected range and metric.
  const colorOf = useMemo(() => {
    const counts = new Map<string, number>()
    for (const sample of speedSamples) counts.set(sample.model, (counts.get(sample.model) ?? 0) + 1)
    for (const sample of firstTokenSamples) counts.set(sample.model, counts.get(sample.model) ?? 0)
    const order = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!)
    return (model: string): string => `var(--llm-model-${Math.max(0, order.indexOf(model)) % PALETTE})`
  }, [speedSamples, firstTokenSamples])
  // The right edge follows the clock once per minute; per-second summary polling must not redraw the chart.
  const minute = Math.floor(Date.now() / 60_000)
  const to = minute * 60_000 + 60_000
  const from = to - hours * 3_600_000
  const within = (list: LlmMetricSample[]): LlmMetricSample[] => list.filter(sample => sample.ts >= from && sample.ts <= to)
  const inRange = useMemo(() => within(samples), [samples, from, to])
  const speedInRange = useMemo(() => within(speedSamples), [speedSamples, from, to])
  const firstTokenInRange = useMemo(() => within(firstTokenSamples), [firstTokenSamples, from, to])
  const oldestKept = history?.truncated && history.rows.length ? Date.parse(history.rows.at(-1)!.ts) : undefined
  const sessions = summary?.sessions ?? []

  if (!open) return null
  return (
    <ModalFrame labelledBy={titleId} className="llm-perf-modal" onClose={onClose}>
      <header className="llm-perf-head">
        <h2 id={titleId}>LLM 性能</h2>
        <span className={`llm-perf-live${sessions.length ? ' on' : ''}`}>
          <i aria-hidden="true" />{summary ? sessions.length ? `${sessions.length} 个会话运行中` : '无运行中的会话' : '读取中'}
        </span>
        <div className="llm-perf-range" role="group" aria-label="时间范围">
          {RANGES.map(range => (
            <button key={range.hours} type="button" aria-pressed={hours === range.hours} onClick={() => setHours(range.hours)}>{range.label}</button>
          ))}
        </div>
        <button type="button" className="modal-x" onClick={onClose} aria-label="关闭 LLM 性能"><Icon name="x" /></button>
      </header>
      <div className="llm-perf-body">
        {summaryError && <p className="llm-perf-alert" role="alert">运行中会话读取失败：{summaryError}</p>}
        {sessions.length > 0 && (
          <section className="llm-perf-running" aria-label="运行中的会话">
            {sessions.map(session => (
              <div key={session.key} className="llm-perf-run">
                <i aria-hidden="true" style={session.model ? { background: colorOf(session.model) } : undefined} />
                <div><b>{session.model ?? (session.providerId ? providerName[session.providerId] : '未知 Provider')}</b>
                  {session.cwd && <span> · {session.cwd.split('/').filter(Boolean).pop()}</span>}</div>
                <span className={`llm-perf-state${session.state === 'streaming' ? ' gen' : ''}`}>{stateLabel(session)}</span>
                <div className="llm-perf-run-speed">
                  {session.tokensPerSecond != null && <><strong>{formatSpeed(session.tokensPerSecond)}</strong><small>token/s</small></>}
                </div>
                <div className="llm-perf-run-speed">
                  {session.firstTokenMs != null && <><small>首 token</small><strong>{formatSeconds(session.firstTokenMs / 1000)}</strong><small>秒</small></>}
                </div>
              </div>
            ))}
          </section>
        )}
        <section>
          <h3>
            <span className="llm-perf-metric" role="group" aria-label="指标">
              {(['speed', 'firstToken'] as const).map(item => (
                <button key={item} type="button" aria-pressed={metric === item} onClick={() => setMetric(item)}>{METRICS[item].label}</button>
              ))}
            </span>
            <span>{METRICS[metric].unit}</span>
            {oldestKept != null && oldestKept > from && <small className="llm-perf-truncated">只含最近 {history!.rows.length} 轮</small>}
          </h3>
          {historyError
            ? <p className="llm-perf-alert" role="alert">历史读取失败：{historyError}</p>
            : !history ? <div className="llm-perf-empty">读取中</div>
              : !inRange.length ? <div className="llm-perf-empty">{samples.length ? '这个时间范围内没有数据' : '还没有数据'}</div>
                : <MetricChart samples={inRange} metric={metric} from={from} to={to} hours={hours} selected={selected} colorOf={colorOf} />}
        </section>
        {!historyError && speedInRange.length > 0 && (
          <section>
            <h3>模型对比</h3>
            <ModelComparison samples={speedInRange} firstToken={firstTokenInRange} selected={selected} colorOf={colorOf}
              onSelect={model => setSelected(current => current === model ? null : model)} />
          </section>
        )}
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
    return [...byModel].map(([model, own]) => ({ model, points: smoothLlmMetric(own, from, to, BANDWIDTH_MINUTES[hours] * 60_000, GRID) }))
  }, [samples, from, to, hours])
  const measured = series.flatMap(item => item.points.flatMap(point => point.value == null ? [] : [point.value]))
  // A single extreme round must not flatten every other curve; higher values clamp to the top.
  const yMax = metric === 'speed'
    ? Math.max(10, Math.ceil(quantile(measured, 0.98) * 1.1 / 20) * 20)
    : niceCeil(Math.max(1, quantile(measured, 0.98) * 1.1))
  const H = 240, L = 30, R = 12, T = 12, B = 22
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
        <svg viewBox={`0 0 ${width} ${H}`} role="img" aria-label={METRICS[metric].chartLabel}
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
              stroke={colorOf(item.model)} strokeWidth={selected === item.model ? 2.6 : 2} />
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
        <div className="llm-perf-tip" style={{ left: Math.min(Math.max(x(hoverTs), 110), width - 110), top: T }}>
          <div className="llm-perf-tip-time">{hours > 24 ? `${day(hoverTs)} ${clock(hoverTs)}` : clock(hoverTs)}</div>
          {hits.length
            ? hits.map(item => (
              <div key={item.model} className="llm-perf-tip-row"><i style={{ background: colorOf(item.model) }} />{item.model}
                <b>{METRICS[metric].format(item.points[hover].value!)}</b></div>
            ))
            : <div className="llm-perf-tip-row">空闲</div>}
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
        model, rounds: speeds.length, p25: quantile(speeds, 0.25), p50: quantile(speeds, 0.5), p75: quantile(speeds, 0.75),
        firstToken: wait ? quantile(wait, 0.5) : undefined
      }
    }).sort((a, b) => b.p50 - a.p50)
  }, [samples, firstToken])
  const max = Math.max(10, Math.ceil(Math.max(...groups.map(group => group.p75)) / 10) * 10)
  const percent = (value: number): string => `${Math.min(value, max) / max * 100}%`
  return (
    <div className="llm-perf-models">
      <div className="llm-perf-mhead"><span>模型</span><span>速度分布</span><span>中位速度</span><span>首 token</span><span>轮数</span></div>
      {groups.map(group => (
        <button key={group.model} type="button" className="llm-perf-mrow" aria-pressed={selected === group.model} onClick={() => onSelect(group.model)}>
          <span className="llm-perf-mname"><i style={{ background: colorOf(group.model) }} /><b>{group.model}</b></span>
          <span className="llm-perf-bar" aria-hidden="true"><span className="track" />
            <span className="iqr" style={{ left: percent(group.p25), width: `calc(${percent(group.p75)} - ${percent(group.p25)})`, background: colorOf(group.model) }} />
            <span className="p50" style={{ left: percent(group.p50), background: colorOf(group.model) }} /></span>
          <span className="llm-perf-speed"><strong>{formatSpeed(group.p50)}</strong><small>token/s</small></span>
          <span className="llm-perf-speed llm-perf-wait">{group.firstToken != null
            ? <><strong>{formatSeconds(group.firstToken)}</strong><small>秒</small></>
            : <small>—</small>}</span>
          <span className="llm-perf-rounds">{group.rounds}</span>
        </button>
      ))}
      <div className="llm-perf-scale"><span /><div><span>0</span><span>{max / 2}</span><span>{max}</span></div></div>
    </div>
  )
}
