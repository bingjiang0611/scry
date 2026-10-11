import type { ActiveRun } from './trace.js'
import type { ProviderId } from './provider.js'
import { sessionAttentionKey } from './session-attention.js'

export interface LlmRunningSession {
  key: string
  providerId?: ProviderId
  cwd?: string
  /** Model of the latest completed call in this turn; unknown before the first call. */
  model?: string
  state: LlmPerformance['state']
  outputStarted: boolean
  /** Completed main-agent calls of this turn only; absent until a Provider gives per-call evidence. */
  tokensPerSecond?: number
}

/** A bounded, read-only snapshot of currently registered sessions for the global modal. */
export interface LlmPerformanceSummary {
  observedAt: string
  sessions: LlmRunningSession[]
}

/** Reads only the bounded per-run observation, never the trace. The latest main run owns its session. */
export function summarizeRunningLlmSessions(activeRuns: readonly ActiveRun[], now = Date.now()): LlmPerformanceSummary {
  const sessions = new Map<string, ActiveRun>()
  for (const run of activeRuns) {
    if (run.done) continue
    const key = sessionAttentionKey({ providerId: run.providerId ?? '', agentProfileId: run.agentProfileId,
      cwd: run.cwd ?? '', sessionId: run.externalSessionId ?? run.sessionId ?? run.runId })
    sessions.set(key, run)
  }
  return {
    observedAt: new Date(now).toISOString(),
    sessions: [...sessions].map(([key, run]) => {
      const sample = run.llmPerformance
      return {
        key, providerId: run.providerId, cwd: run.cwd, model: sample?.model,
        state: sample?.state ?? 'waiting',
        outputStarted: sample?.firstOutputWaitMs != null,
        ...(sample?.apiTokensPerSecond != null ? { tokensPerSecond: sample.apiTokensPerSecond } : {})
      }
    })
  }
}

export interface LlmNetworkConfiguration {
  observedAt: string
  source: 'macos-system-and-app-environment' | 'app-environment'
  systemProxy: { http: boolean; https: boolean; socks: boolean; pac: boolean; discovery: boolean } | null
  environmentProxy: { http: boolean; https: boolean; all: boolean; bypass: boolean }
}

/** Local observation, not network bandwidth or server-side generation telemetry. */
export interface LlmPerformance {
  state: 'waiting' | 'streaming' | 'tool' | 'buffered' | 'complete'
  observedAt: string
  networkLabel: string
  networkConfiguration?: LlmNetworkConfiguration
  firstOutputWaitMs?: number
  streamCharacters: number
  recentOutput: Array<{ ts: number; characters: number }>
  windowMs: number
  streamDurationMs: number
  averageCharactersPerSecond?: number
  outputTokens?: number
  apiDurationMs?: number
  apiTokensPerSecond?: number
  /**
   * provider_api: SDK-reported API time (Claude). observed_calls: sum of locally timed main-agent
   * requests (request start → message end, including first-token wait; tool time excluded).
   */
  tokenTimingSource?: 'provider_api' | 'observed_calls'
  /** Completed main-agent calls behind observed_calls timing. */
  llmCalls?: number
  /** Model of the latest observed call. */
  model?: string
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

export interface LlmSpeedSample {
  ts: number
  model: string
  tokensPerSecond: number
}

/** Successful rounds with both token and timing evidence. Missing evidence is omitted, never 0. */
export function llmSpeedSamples(rows: readonly LlmPerformanceHistoryRow[]): LlmSpeedSample[] {
  return rows.flatMap(row => {
    const ts = Date.parse(row.ts)
    const speed = row.performance.apiTokensPerSecond
    return !row.failed && speed != null && speed > 0 && Number.isFinite(ts)
      ? [{ ts, model: row.model, tokensPerSecond: speed }] : []
  })
}

export function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low)
}

export interface LlmSpeedPoint {
  ts: number
  /** Smoothed measured speed; null when no round lies within 1.5 bandwidths (idle). */
  speed: number | null
  /** Drawing height: eases to the 0 axis when idle. It is not a measurement. */
  drawn: number
}

/**
 * Gaussian-weighted geometric mean of one model's rounds on a regular grid. The geometric mean keeps
 * one outlier from dominating. The curve stays continuous, but idle points are marked with speed=null
 * so no tooltip or statistic presents the 0 baseline as a 0 token/s measurement.
 */
export function smoothLlmSpeed(samples: readonly LlmSpeedSample[], from: number, to: number, bandwidthMs: number, points: number): LlmSpeedPoint[] {
  return Array.from({ length: points }, (_, index) => {
    const ts = from + (to - from) * index / (points - 1)
    let weight = 0
    let logSum = 0
    let near = false
    for (const sample of samples) {
      const distance = (sample.ts - ts) / bandwidthMs
      if (Math.abs(distance) > 3) continue
      if (Math.abs(distance) <= 1.5) near = true
      const w = Math.exp(-distance * distance / 2)
      weight += w
      logSum += w * Math.log(sample.tokensPerSecond)
    }
    const speed = weight > 1e-6 ? Math.exp(logSum / weight) : 0
    return { ts, speed: near ? speed : null, drawn: speed * Math.min(1, weight / 0.6) }
  })
}
