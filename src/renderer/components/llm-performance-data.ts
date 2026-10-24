import { quantile, type LlmMetricSample } from '@shared/llm-performance'

export type RangeHours = 1 | 24 | 168
export const INTERVAL_MS: Record<RangeHours, number> = { 1: 600_000, 24: 7_200_000, 168: 86_400_000 }

export function metricDistribution(samples: readonly LlmMetricSample[]) {
  if (!samples.length) return null
  const values = samples.map(sample => sample.value)
  return {
    count: values.length, provisional: samples.filter(sample => sample.provisional).length,
    min: Math.min(...values), max: Math.max(...values),
    q1: quantile(values, .25), median: quantile(values, .5), q3: quantile(values, .75)
  }
}

export function compareModels(speed: readonly LlmMetricSample[], firstToken: readonly LlmMetricSample[]) {
  const groups = new Map<string, { model: string; speed: LlmMetricSample[]; firstToken: LlmMetricSample[] }>()
  for (const [metric, samples] of [['speed', speed], ['firstToken', firstToken]] as const) {
    for (const sample of samples) {
      let group = groups.get(sample.model)
      if (!group) { group = { model: sample.model, speed: [], firstToken: [] }; groups.set(sample.model, group) }
      group[metric].push(sample)
    }
  }
  return [...groups.values()].map(group => ({
    ...group, speedSummary: metricDistribution(group.speed), waitSummary: metricDistribution(group.firstToken)
  })).sort((a, b) => (b.speedSummary?.median ?? -1) - (a.speedSummary?.median ?? -1))
}
export type ModelDistribution = ReturnType<typeof compareModels>[number]

/** Empty buckets stay absent; 1–2 samples retain their actual times and values. */
export function metricIntervals(samples: readonly LlmMetricSample[], from: number, to: number, span: number) {
  const buckets = new Map<number, LlmMetricSample[]>()
  for (const sample of samples) {
    if (sample.ts < from || sample.ts > to) continue
    const start = Math.floor(sample.ts / span) * span
    const group = buckets.get(start)
    if (group) group.push(sample)
    else buckets.set(start, [sample])
  }
  return [...buckets].flatMap(([bucket, group]) => {
    if (group.length < 3) return group.map(sample => ({
      ...metricDistribution([sample])!, ts: sample.ts, start: sample.ts, stop: sample.ts, individual: true
    }))
    const start = Math.max(from, bucket), stop = Math.min(to, bucket + span)
    return [{ ...metricDistribution(group)!, ts: (start + stop) / 2, start, stop, individual: false }]
  }).sort((a, b) => a.ts - b.ts)
}

/** Full measured range, never percentile-clipped; 1/2/4/5 × 10^n ticks. */
export function metricAxisMax(values: readonly number[]): number {
  if (!values.length) return 1
  const max = Math.max(...values) * 1.05
  const power = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 4, 5, 10].map(step => step * power).find(value => value >= max)!
}

export const formatMetric = (value: number): string => value.toFixed(1)
const pad = (value: number): string => String(value).padStart(2, '0')
export const clock = (ts: number): string => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
export const day = (ts: number): string => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}` }
