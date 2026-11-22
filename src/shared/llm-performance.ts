import type { ActiveRun } from './trace.js'
import type { ProviderId } from './provider.js'
import { sessionAttentionKey } from './session-attention.js'

export interface LlmRunningSession {
  key: string
  runId: string
  observedAt?: string
  providerId?: ProviderId
  cwd?: string
  model?: string
  state: LlmPerformance['state']
  outputStarted: boolean
  tokensPerSecond?: number
  firstTokenMs?: number
  firstOutputWaitMs?: number
}

export interface LlmPerformanceSummary {
  observedAt: string
  sessions: LlmRunningSession[]
}

export interface LlmRunningModel {
  key: string
  model?: string
  providerId?: ProviderId
  sessions: LlmRunningSession[]
  tokensPerSecond?: number
  firstTokenMs?: number
  firstOutputWaitMs?: number
}

export function groupRunningLlmSessions(sessions: readonly LlmRunningSession[]): LlmRunningModel[] {
  const groups = new Map<string, LlmRunningSession[]>()
  for (const session of sessions) {
    const key = session.model ? `model:${JSON.stringify([session.providerId, session.model])}` : `session:${session.key}`
    const group = groups.get(key)
    if (group) group.push(session)
    else groups.set(key, [session])
  }
  return [...groups].map(([key, members]) => {
    const speeds = members.flatMap(session => session.tokensPerSecond != null ? [session.tokensPerSecond] : [])
    const waits = members.flatMap(session => session.firstTokenMs != null ? [session.firstTokenMs] : [])
    const outputWaits = members.flatMap(session => session.firstOutputWaitMs != null ? [session.firstOutputWaitMs] : [])
    return {
      key, model: members[0].model, providerId: members[0].providerId, sessions: members,
      ...(speeds.length ? { tokensPerSecond: speeds.reduce((sum, value) => sum + value, 0) / speeds.length } : {}),
      ...(waits.length ? { firstTokenMs: waits.reduce((sum, value) => sum + value, 0) / waits.length } : {}),
      ...(outputWaits.length ? { firstOutputWaitMs: outputWaits.reduce((sum, value) => sum + value, 0) / outputWaits.length } : {})
    }
  })
}

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
        key, runId: run.runId, observedAt: sample?.observedAt,
        providerId: run.providerId, cwd: run.cwd, model: sample?.model,
        state: sample?.state ?? 'waiting',
        outputStarted: sample?.firstOutputWaitMs != null,
        ...(sample?.apiTokensPerSecond != null ? { tokensPerSecond: sample.apiTokensPerSecond } : {}),
        ...(sample?.firstTokenMs != null ? { firstTokenMs: sample.firstTokenMs } : {}),
        ...(sample?.firstOutputWaitMs != null ? { firstOutputWaitMs: sample.firstOutputWaitMs } : {})
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
  tokenTimingSource?: 'provider_api' | 'observed_calls'
  llmCalls?: number
  firstTokenMs?: number
  firstTokenCalls?: number
  model?: string
}

export interface LlmPerformanceHistoryRow {
  runId: string
  ts: string
  providerId: ProviderId
  agentProfileId?: string
  model: string
  modelSource?: 'antigravity_transcript'
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

export const LLM_METRICS = ['speed', 'firstToken', 'firstOutput'] as const
export type LlmMetric = typeof LLM_METRICS[number]

export interface LlmMetricSample {
  ts: number
  value: number
  provisional?: boolean
}

export interface LlmComparisonRound {
  ts: number
  providerId?: ProviderId
  model?: string
  state: 'completed' | 'failed' | 'running'
  metrics: Partial<Record<LlmMetric, number>>
}

function comparisonMetrics(speed?: number, firstTokenMs?: number, firstOutputWaitMs?: number): LlmComparisonRound['metrics'] {
  const metrics: LlmComparisonRound['metrics'] = {}
  if (speed != null && speed > 0 && Number.isFinite(speed)) metrics.speed = speed
  if (firstTokenMs != null && firstTokenMs > 0 && Number.isFinite(firstTokenMs)) metrics.firstToken = firstTokenMs / 1000
  if (firstOutputWaitMs != null && firstOutputWaitMs >= 0 && Number.isFinite(firstOutputWaitMs)) metrics.firstOutput = firstOutputWaitMs / 1000
  return metrics
}

export function llmComparisonRounds(rows: readonly LlmPerformanceHistoryRow[], sessions: readonly LlmRunningSession[] = []): LlmComparisonRound[] {
  const rounds: LlmComparisonRound[] = []
  const persisted = new Set(rows.map(row => row.runId))
  for (const row of rows) {
    const ts = Date.parse(row.ts)
    if (!Number.isFinite(ts)) continue
    const performance = row.performance
    rounds.push({
      ts, providerId: row.providerId, model: row.model, state: row.failed ? 'failed' : 'completed',
      metrics: row.failed ? {} : comparisonMetrics(performance.apiTokensPerSecond, performance.firstTokenMs, performance.firstOutputWaitMs)
    })
  }
  for (const session of sessions) {
    if (persisted.has(session.runId) || session.state === 'complete' || !session.observedAt) continue
    const ts = Date.parse(session.observedAt)
    if (!Number.isFinite(ts)) continue
    const metrics = comparisonMetrics(session.tokensPerSecond, session.firstTokenMs, session.firstOutputWaitMs)
    if (Object.keys(metrics).length) rounds.push({ ts, providerId: session.providerId, model: session.model, state: 'running', metrics })
  }
  return rounds
}

export function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low)
}
