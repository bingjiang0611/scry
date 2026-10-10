import type { ProviderId } from './provider.js'

/** Local observation, not network bandwidth or server-side generation telemetry. */
export interface LlmPerformance {
  state: 'waiting' | 'streaming' | 'tool' | 'buffered' | 'complete'
  observedAt: string
  networkLabel: string
  firstOutputWaitMs?: number
  streamCharacters: number
  recentOutput: Array<{ ts: number; characters: number }>
  windowMs: number
  streamDurationMs: number
  averageCharactersPerSecond?: number
  outputTokens?: number
  apiDurationMs?: number
  apiTokensPerSecond?: number
}

export interface LlmPerformanceHistoryRow {
  runId: string
  ts: string
  providerId: ProviderId
  agentProfileId?: string
  model: string
  upstreamProvider?: string
  networkLabel: string
  failed: boolean
  performance: LlmPerformance
}

export interface LlmPerformanceHistory {
  rows: LlmPerformanceHistoryRow[]
  invalidLines: number
  truncated: boolean
}

/** A stale stream decays to zero; a finished or buffered response has no live rate. */
export function liveCharactersPerSecond(sample: LlmPerformance, now: number): number | undefined {
  if (sample.state !== 'streaming') return undefined
  const characters = sample.recentOutput.reduce((sum, bucket) =>
    now - bucket.ts < sample.windowMs ? sum + bucket.characters : sum, 0)
  return characters / (sample.windowMs / 1000)
}

export interface LlmPerformanceComparison {
  key: string
  providerId: ProviderId
  agentProfileId?: string
  model: string
  upstreamProvider?: string
  networkLabel: string
  runs: number
  failedRuns: number
  waitSamples: number
  medianWaitMs?: number
  speedSamples: number
  medianCharactersPerSecond?: number
  apiSamples: number
  medianApiTokensPerSecond?: number
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  values.sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
}

export function compareLlmPerformance(rows: LlmPerformanceHistoryRow[]): LlmPerformanceComparison[] {
  const groups = new Map<string, LlmPerformanceHistoryRow[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.providerId, row.agentProfileId, row.upstreamProvider, row.model, row.networkLabel])
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return [...groups].map(([key, group]) => {
    const successful = group.filter(row => !row.failed)
    const values = (field: 'firstOutputWaitMs' | 'averageCharactersPerSecond' | 'apiTokensPerSecond'): number[] =>
      successful.flatMap(row => row.performance[field] == null ? [] : [row.performance[field]!])
    const waits = values('firstOutputWaitMs')
    const speeds = values('averageCharactersPerSecond')
    const api = values('apiTokensPerSecond')
    const first = group[0]
    return {
      key, providerId: first.providerId, agentProfileId: first.agentProfileId,
      model: first.model, upstreamProvider: first.upstreamProvider, networkLabel: first.networkLabel,
      runs: group.length, failedRuns: group.length - successful.length,
      waitSamples: waits.length, medianWaitMs: median(waits),
      speedSamples: speeds.length, medianCharactersPerSecond: median(speeds),
      apiSamples: api.length, medianApiTokensPerSecond: median(api)
    }
  })
}
