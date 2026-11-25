import { LLM_METRICS, quantile, type LlmComparisonRound, type LlmMetric, type LlmMetricSample } from '@shared/llm-performance'
import type { ProviderId } from '@shared/provider'

export type RangeHours = 1 | 24 | 168 | 720

export function metricDistribution(samples: readonly LlmMetricSample[]) {
  if (!samples.length) return null
  const values = samples.map(sample => sample.value)
  return {
    count: values.length, provisional: samples.filter(sample => sample.provisional).length,
    min: Math.min(...values), max: Math.max(...values),
    q1: quantile(values, .25), median: quantile(values, .5), q3: quantile(values, .75)
  }
}

export function llmComparisonKey(providerId?: ProviderId, model?: string): string {
  return JSON.stringify([providerId, model])
}

export function compareModels(rounds: readonly LlmComparisonRound[]) {
  const groups = new Map<string, {
    key: string; providerId?: ProviderId; model?: string
    completed: number; failed: number; running: number
    samples: Record<LlmMetric, LlmMetricSample[]>
  }>()
  for (const round of rounds) {
    const { providerId, model, ts, state } = round
    const key = llmComparisonKey(providerId, model)
    let group = groups.get(key)
    if (!group) {
      group = { key, providerId, model, completed: 0, failed: 0, running: 0, samples: { speed: [], firstToken: [], firstOutput: [] } }
      groups.set(key, group)
    }
    group[state]++
    for (const metric of LLM_METRICS) {
      const value = round.metrics[metric]
      if (value != null) group.samples[metric].push({ ts, value, ...(state === 'running' ? { provisional: true } : {}) })
    }
  }
  return [...groups.values()].map(group => ({
    ...group,
    speedSummary: metricDistribution(group.samples.speed),
    waitSummary: metricDistribution(group.samples.firstToken),
    outputSummary: metricDistribution(group.samples.firstOutput)
  })).sort((a, b) => (b.speedSummary?.median ?? -1) - (a.speedSummary?.median ?? -1) ||
    (a.outputSummary?.median ?? Infinity) - (b.outputSummary?.median ?? Infinity))
}
export type ModelDistribution = ReturnType<typeof compareModels>[number]

/** Full measured range, never percentile-clipped; 1/2/4/5 × 10^n ticks. */
export function metricAxisMax(values: readonly number[]): number {
  const peak = Math.max(0, ...values)
  if (peak === 0) return 1
  const max = peak * 1.05
  const power = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 4, 5, 10].map(step => step * power).find(value => value >= max)!
}

export const formatMetric = (value: number): string => value.toFixed(1)
const pad = (value: number): string => String(value).padStart(2, '0')
export const clock = (ts: number): string => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
export const day = (ts: number): string => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}` }
