import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { LlmMetric, LlmMetricSample } from '@shared/llm-performance'
import { LLM_PERFORMANCE_COPY as copy } from '../constants/llm-performance-copy'
import { Icon } from './primitives/Icon'
import { clock, day, formatMetric, INTERVAL_MS, metricAxisMax, metricIntervals, type ModelDistribution, type RangeHours } from './llm-performance-data'

export function MetricHelp({ label, text }: { label: string; text: string }) {
  return <details className="llm-perf-help"><summary>{label}<Icon name="info" /></summary><p>{text}</p></details>
}

export function ModelComparison({ groups, selected, colorOf, onSelect }: {
  groups: ModelDistribution[]
  selected: string
  colorOf: (model: string) => string
  onSelect: (model: string) => void
}) {
  const max = metricAxisMax(groups.flatMap(group => group.speed.map(sample => sample.value)))
  const x = (value: number): number => 8 + value / max * 384
  return <div className="llm-perf-comparison-scroll"><div className="llm-perf-models">
    <div className="llm-perf-mhead">
      <span>{copy.columns.model}</span><span>{copy.columns.distribution}</span>
      <span>{copy.columns.speed}<small>{copy.metrics.speed.unit}</small></span>
      <span>{copy.columns.firstToken}<small>{copy.metrics.firstToken.unit}</small></span>
    </div>
    {groups.map(group => {
      const speed = group.speedSummary, wait = group.waitSummary
      const count = speed ?? wait!
      const rounds = copy.rounds(count.count - count.provisional, count.provisional)
      return <button key={group.model} type="button" className="llm-perf-mrow" aria-pressed={selected === group.model}
        onClick={() => onSelect(group.model)}>
        <span className="llm-perf-mname"><i aria-hidden="true" style={{ background: colorOf(group.model) }} /><b>{group.model}</b>
          <small aria-label={copy.roundsLabel(copy.metrics[speed ? 'speed' : 'firstToken'].label, count.count - count.provisional, count.provisional)}>
            {speed ? rounds : copy.waitRounds(rounds)}</small></span>
        {speed ? <svg className="llm-perf-distribution" viewBox="0 0 400 50" preserveAspectRatio="none" role="img"
          aria-label={speed.count < 3 ? copy.sparseDistribution(copy.valueList(group.speed.map(sample => formatMetric(sample.value))))
            : copy.distributionLabel(formatMetric(speed.min), formatMetric(speed.q1), formatMetric(speed.median), formatMetric(speed.q3), formatMetric(speed.max))}
          style={{ color: colorOf(group.model) }}>
          {speed.count < 3 ? group.speed.map((sample, index) => <line key={index} className="llm-perf-median" x1={x(sample.value)} x2={x(sample.value)} y1={20} y2={30} />) : <>
            <line className="llm-perf-extent" x1={x(speed.min)} x2={x(speed.max)} y1={25} y2={25} />
            <rect className="llm-perf-middle" x={x(speed.q1)} y={19} width={x(speed.q3) - x(speed.q1)} height={12} rx={3} />
            <line className="llm-perf-median" x1={x(speed.median)} x2={x(speed.median)} y1={16} y2={34} />
          </>}
        </svg> : <span className="llm-perf-missing">{copy.missing}</span>}
        <span className="llm-perf-reading" aria-label={copy.columns.speed}>{speed ? formatMetric(speed.median) : copy.missing}</span>
        <span className="llm-perf-reading" aria-label={copy.columns.firstToken}>{wait ? formatMetric(wait.median) : copy.missing}</span>
      </button>
    })}
    <div className="llm-perf-scale" aria-hidden="true"><span /><div>{[0, max / 2, max].map((value, index) => <span key={value} style={{ left: `${2 + index * 48}%` }}>{value}</span>)}</div></div>
  </div></div>
}

export function MetricChart({ samples, model, metric, from, to, hours, color }: {
  samples: LlmMetricSample[]
  model: string
  metric: LlmMetric
  from: number
  to: number
  hours: RangeHours
  color: string
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
  const intervals = useMemo(() => metricIntervals(samples, from, to, INTERVAL_MS[hours]), [samples, from, to, hours])
  const max = metricAxisMax(intervals.map(interval => interval.max))
  const H = 160, L = 38, R = 12, T = 15, B = 28
  const x = (ts: number): number => L + (ts - from) / (to - from) * (width - L - R)
  const y = (value: number): number => H - B - value / max * (H - T - B)
  const label = (index: number): string => {
    const interval = intervals[index], unit = copy.metrics[metric].unit
    const start = `${day(interval.start)} ${clock(interval.start)}`
    if (interval.individual) return copy.singleLabel(start, formatMetric(interval.median), unit, interval.provisional > 0)
    const stop = `${day(interval.stop)} ${clock(interval.stop)}`
    return copy.intervalLabel(copy.intervalStamp(start, stop), interval.count, formatMetric(interval.median), formatMetric(interval.min), formatMetric(interval.max), unit, interval.provisional)
  }
  const active = hover == null ? undefined : intervals[hover]
  return <div className="llm-perf-chart" ref={box}>
    {width > 0 && <svg viewBox={`0 0 ${width} ${H}`} role="group" aria-label={copy.chartLabel(model, copy.metrics[metric].label)} tabIndex={0}
      aria-describedby={active ? tipId : undefined} style={{ color }}
      onFocus={() => setHover(0)} onBlur={() => setHover(null)} onMouseLeave={() => setHover(null)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { setHover(null); return }
        setHover(current => event.key === 'Home' ? 0 : event.key === 'End' ? intervals.length - 1
          : Math.max(0, Math.min(intervals.length - 1, (current ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1))))
      }}>
      <g className="llm-perf-axis">{[0, max / 2, max].map(value => <g key={value}>
        <line x1={L} x2={width - R} y1={y(value)} y2={y(value)} /><text x={L - 10} y={y(value) + 4} textAnchor="end">{value}</text>
      </g>)}
        {[0, 1, 2, 3, 4].map(index => {
          const ts = from + (to - from) * index / 4
          return <text key={index} x={x(ts)} y={H - 3} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}>{hours > 24 ? day(ts) : clock(ts)}</text>
        })}
      </g>
      {intervals.map((interval, index) => <g key={`${interval.ts}:${index}`} className={`llm-perf-interval${hover === index ? ' active' : ''}`}
        role="img" aria-label={label(index)} onPointerEnter={() => setHover(index)} onPointerLeave={() => setHover(null)}>
        {!interval.individual && <>
          <line className="llm-perf-extent" x1={x(interval.ts)} x2={x(interval.ts)} y1={y(interval.min)} y2={y(interval.max)} />
          <rect className="llm-perf-middle" x={x(interval.ts) - 4} y={y(interval.q3)} width={8} height={y(interval.q1) - y(interval.q3)} rx={2} />
          <path className="llm-perf-extent" d={`M${x(interval.ts) - 3},${y(interval.min)}h6 M${x(interval.ts) - 3},${y(interval.max)}h6`} />
        </>}
        <path className="llm-perf-median" d={`M${x(interval.ts) - (interval.individual ? 4 : 7)},${y(interval.median)}h${interval.individual ? 8 : 14}`} />
        <rect className="llm-perf-hit" x={x(interval.ts) - 12} y={Math.max(T, y(interval.max) - 8)} width={24} height={Math.max(20, y(interval.min) - y(interval.max) + 16)} />
      </g>)}
    </svg>}
    {active && <div id={tipId} role="status" className="llm-perf-tip" style={{ left: Math.max(0, Math.min(x(active.ts) - 100, width - 240)) }}>{label(hover!)}</div>}
  </div>
}
