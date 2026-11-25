import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { LLM_METRICS, type LlmMetric, type LlmMetricSample } from '@shared/llm-performance'
import { PROVIDER_LABELS } from '@shared/provider'
import { LLM_PERFORMANCE_COPY as copy } from '../constants/llm-performance-copy'
import { useFirstReadyList } from '../hooks/useFirstReadyList'
import { clock, day, formatMetric, metricAxisMax, type ModelDistribution, type RangeHours } from './llm-performance-data'

const agentLabel = (providerId: ModelDistribution['providerId']): string => providerId ? PROVIDER_LABELS[providerId] : ''

/** 模型对比表：表头带单位，缺值留空；已完成和运行中轮次均为零的模型不成行。 */
export function PerfTable({ groups, selected, colorOf, gatewayOf, onSelect }: {
  groups: ModelDistribution[]
  selected: string
  colorOf: (key: string) => string
  gatewayOf: (agent?: string, model?: string) => string | undefined
  onSelect: (key: string) => void
}) {
  const rows = groups.filter((group) => group.completed + group.running > 0)
  const max = metricAxisMax(rows.flatMap((group) => group.samples.speed.map((sample) => sample.value)))
  const motion = useFirstReadyList(rows.length > 0)
  const x = (value: number): number => 8 + value / max * 384
  const summariesOf = (group: ModelDistribution) => ({ speed: group.speedSummary, firstToken: group.waitSummary, firstOutput: group.outputSummary })
  return <div className="analytics-table-scroll">
    <table className={`analytics-table is-models ${motion.className}`}>
      <thead>
        <tr>
          <th scope="col">{copy.columns.identity}</th>
          <th scope="col" className="is-num">{copy.columns.turns}</th>
          <th scope="col" className="is-distribution">{copy.columns.distribution}</th>
          {LLM_METRICS.map((metric) => <th key={metric} scope="col" className="is-num">
            {copy.columns[metric]}<span className="analytics-th-unit">{copy.metrics[metric].unit}</span>
          </th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((group, index) => {
          const model = group.model ?? ''
          const agent = agentLabel(group.providerId)
          const gateway = gatewayOf(group.providerId, group.model)
          const summaries = summariesOf(group)
          const failed = group.failed > 0 ? copy.failedRounds(group.failed) : null
          return <tr key={group.key} className="analytics-row is-model motion-stagger-item" style={motion.itemStyle(index)} aria-selected={selected === group.key}>
            <th scope="row">
              <button type="button" className="analytics-row-select" aria-pressed={selected === group.key} onClick={() => onSelect(group.key)}>
                <i aria-hidden="true" className="analytics-dot" style={{ background: colorOf(group.key) }} />
                <span className="analytics-identity">
                  <b title={model}>{model}</b>
                  <span className="analytics-sub">{agent}{gateway ? ` · ${gateway}` : ''}</span>
                </span>
              </button>
            </th>
            <td className="is-num" title={[copy.rounds(group.completed, group.running), failed].filter(Boolean).join(' · ')}>
              {group.completed + group.running || ''}
              {failed && <span className="analytics-sub">{failed}</span>}
            </td>
            <td className="is-distribution">
              {group.speedSummary ? <svg className="analytics-dist" viewBox="0 0 400 20" preserveAspectRatio="none" role="img"
                aria-label={group.speedSummary.count < 3
                  ? copy.sparseDistribution(copy.valueList(group.samples.speed.map((sample) => formatMetric(sample.value))))
                  : copy.distributionLabel(formatMetric(group.speedSummary.min), formatMetric(group.speedSummary.q1),
                    formatMetric(group.speedSummary.median), formatMetric(group.speedSummary.q3), formatMetric(group.speedSummary.max))}
                style={{ color: colorOf(group.key) }}>
                {group.speedSummary.count < 3
                  ? group.samples.speed.map((sample, tick) => <line key={tick} className="analytics-dist-median" x1={x(sample.value)} x2={x(sample.value)} y1={4} y2={16} />)
                  : <>
                    <line className="analytics-dist-extent" x1={x(group.speedSummary.min)} x2={x(group.speedSummary.max)} y1={10} y2={10} />
                    <rect className="analytics-dist-box" x={x(group.speedSummary.q1)} y={6} width={Math.max(1, x(group.speedSummary.q3) - x(group.speedSummary.q1))} height={8} rx={2} />
                    <line className="analytics-dist-median" x1={x(group.speedSummary.median)} x2={x(group.speedSummary.median)} y1={3} y2={17} />
                  </>}
              </svg> : null}
            </td>
            {LLM_METRICS.map((metric) => {
              const stats = summaries[metric]
              return <td key={metric} className="is-num is-strong" title={stats ? copy.coverage(copy.columns[metric], stats.count) : undefined}>
                {stats ? formatMetric(stats.median) : ''}
              </td>
            })}
          </tr>
        })}
      </tbody>
    </table>
  </div>
}

/** 趋势图：每轮一个点，不连线、不画中位线。 */
export function RoundScatter({ samples, model, metric, from, to, hours, color }: {
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
  const [active, setActive] = useState<number | null>(null)
  useEffect(() => {
    const node = box.current!
    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    observer.observe(node)
    setWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [])
  const points = useMemo(() => [...samples].sort((a, b) => a.ts - b.ts), [samples])
  const unit = copy.metrics[metric].unit
  const max = metricAxisMax(points.map((point) => point.value))
  const H = 200, L = 44, R = 14, T = 14, B = 26
  const x = (ts: number): number => L + (to === from ? 0 : (ts - from) / (to - from)) * Math.max(1, width - L - R)
  const y = (value: number): number => H - B - (value / max) * (H - T - B)
  const label = (index: number): string => {
    const point = points[index]
    const stamp = `${day(point.ts)} ${clock(point.ts)}`
    return copy.pointLabel(stamp, formatMetric(point.value), unit)
  }
  const current = active == null ? undefined : points[active]
  return <div className="analytics-trend" ref={box}>
    {width > 0 && <svg viewBox={`0 0 ${width} ${H}`} role="group" aria-label={copy.chartLabel(model, copy.metrics[metric].label)} tabIndex={0}
      aria-describedby={current ? tipId : undefined} style={{ color }}
      onFocus={() => setActive(0)} onBlur={() => setActive(null)} onMouseLeave={() => setActive(null)}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { setActive(null); return }
        setActive((index) => event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
          : Math.max(0, Math.min(points.length - 1, (index ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1))))
      }}>
      {/* 单位写在绘图区内侧，避免和左上角第一个刻度标签叠在一起。 */}
      <text className="analytics-axis-unit" x={L + 4} y={T + 10} textAnchor="start">{unit}</text>
      <g className="analytics-axis">{[0, max / 2, max].map((value) => <g key={value}>
        <line x1={L} x2={width - R} y1={y(value)} y2={y(value)} />
        <text x={L - 8} y={y(value) + 4} textAnchor="end">{Number.isInteger(value) ? value : value.toFixed(1)}</text>
      </g>)}
        {[0, 1, 2, 3, 4].map((index) => {
          const ts = from + (to - from) * index / 4
          return <text key={index} x={x(ts)} y={H - 4} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}>
            {hours > 24 ? day(ts) : clock(ts)}
          </text>
        })}
      </g>
      {points.map((point, index) => <circle key={`${point.ts}:${index}`} className={`analytics-point${active === index ? ' is-active' : ''}`}
        cx={x(point.ts)} cy={y(point.value)} r={4} role="img" aria-label={label(index)}
        onPointerEnter={() => setActive(index)} onPointerLeave={() => setActive(null)} />)}
    </svg>}
    {current && <div id={tipId} role="status" className="analytics-tip" style={{ left: Math.max(0, Math.min(x(current.ts) - 90, Math.max(0, width - 200))) }}>
      {label(active!)}
    </div>}
  </div>
}
