import type { ActiveRun } from './trace.js'
import type { ProviderId } from './provider.js'
import { sessionAttentionKey } from './session-attention.js'

/** A bounded, read-only snapshot for the global performance modal. */
export interface LlmPerformanceSummary {
  observedAt: string
  networkConfiguration?: LlmNetworkConfiguration
  running: number
  outputting: number
  nonOutputting: number
  liveOutputRate: number | null
  liveOutputMeasured: number
  firstOutputWaitMs: number | null
  firstOutputWaitMeasured: number
  sessionAverageRate: number | null
  sessionAverageMeasured: number
  liveTokenStatus: 'unavailable'
  liveTokenReason: string
  trend: Array<{ ts: number; value: number | null; measured: number; running: number }>
}

/**
 * Aggregate only the current registry members. Character observations are deliberately not
 * converted or displayed as tokens; all live token metrics remain unavailable until a Provider
 * exposes interval-aligned authoritative token counts.
 */
export function aggregateLlmPerformance(activeRuns: readonly ActiveRun[]): Omit<LlmPerformanceSummary, 'trend' | 'observedAt'> {
  let outputting = 0
  const waits: number[] = []
  const sessions = new Map<string, ActiveRun>()
  for (const run of activeRuns) {
    if (run.done) continue
    const key = sessionAttentionKey({ providerId: run.providerId ?? '', agentProfileId: run.agentProfileId,
      cwd: run.cwd ?? '', sessionId: run.externalSessionId ?? run.sessionId ?? run.runId })
    // Registry insertion order follows registration; the latest main run owns the session.
    sessions.set(key, run)
  }
  for (const run of sessions.values()) {
    const sample = run.llmPerformance
    if (sample?.state === 'streaming') outputting++
    if (sample?.firstOutputWaitMs != null && Number.isFinite(sample.firstOutputWaitMs)) waits.push(sample.firstOutputWaitMs)
  }
  const running = sessions.size
  return {
    running,
    outputting,
    nonOutputting: running - outputting,
    liveOutputRate: null,
    liveOutputMeasured: 0,
    firstOutputWaitMs: waits.length ? waits.reduce((sum, value) => sum + value, 0) / waits.length : null,
    firstOutputWaitMeasured: waits.length,
    sessionAverageRate: null,
    sessionAverageMeasured: 0,
    liveTokenStatus: 'unavailable',
    liveTokenReason: '当前 Provider 未提供可与实时区间对齐的权威 token 计数'
  }
}

/** Main-process cache: one bounded O(N) read at most once per second, never a trace poll. */
export class LlmPerformanceSampler {
  private lastSampleAt = -Infinity
  private snapshot: LlmPerformanceSummary = {
    observedAt: new Date(0).toISOString(), running: 0, outputting: 0, nonOutputting: 0,
    liveOutputRate: null, liveOutputMeasured: 0, firstOutputWaitMs: null, firstOutputWaitMeasured: 0,
    sessionAverageRate: null, sessionAverageMeasured: 0, liveTokenStatus: 'unavailable',
    liveTokenReason: '当前 Provider 未提供可与实时区间对齐的权威 token 计数', trend: []
  }

  sample(activeRuns: readonly ActiveRun[], now = Date.now()): LlmPerformanceSummary {
    // Idle is a lifecycle clear, not a trend sample. Other membership changes appear on the next tick.
    if (now - this.lastSampleAt < 1000 && activeRuns.length > 0) return this.snapshot
    this.lastSampleAt = now
    const summary = aggregateLlmPerformance(activeRuns)
    const point = { ts: now, value: summary.liveOutputRate, measured: summary.liveOutputMeasured, running: summary.running }
    const recent = this.snapshot.trend.filter(item => now - item.ts < 30_000)
    const trend = summary.running === 0 ? [] : [...recent, point].slice(-30)
    this.snapshot = { ...summary, observedAt: new Date(now).toISOString(), trend }
    return this.snapshot
  }

  read(): LlmPerformanceSummary {
    return this.snapshot
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

export interface LlmPerformanceHistoricalComparison {
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
  liveTokenSamples: number
  medianLiveTokensPerSecond?: number
  apiSamples: number
  medianApiTokensPerSecond?: number
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

export function performanceEnvironmentKey(row: LlmPerformanceHistoryRow): string {
  const config = row.performance.networkConfiguration
  if (!config) return `历史备注：${row.networkLabel || '未标注'}`
  if (config.source === 'macos-system-and-app-environment' && config.systemProxy === null) return `配置未知：${row.runId}`
  return JSON.stringify([config.source, config.systemProxy, config.environmentProxy])
}

export function performanceEnvironmentLabel(row: LlmPerformanceHistoryRow): string {
  const config = row.performance.networkConfiguration
  if (!config) return `历史备注：${row.networkLabel || '未标注'}`
  return networkConfigurationLabel(config)
}

export function networkConfigurationLabel(config: LlmNetworkConfiguration): string {
  const system = config.systemProxy
  const enabled = [system?.http && '系统 HTTP', system?.https && '系统 HTTPS', system?.socks && '系统 SOCKS',
    system?.pac && '系统 PAC', system?.discovery && '自动发现', config.environmentProxy.http && '环境 HTTP',
    config.environmentProxy.https && '环境 HTTPS', config.environmentProxy.all && '环境 ALL',
    config.environmentProxy.bypass && '环境绕过规则'].filter(Boolean)
  const unknownSystem = system === null && config.source === 'macos-system-and-app-environment'
  return `自动配置：${enabled.join(' / ') || '未检测到代理开关'}${unknownSystem ? ' · 系统配置未知' : ''}`
}

export function performanceHistoryKey(row: LlmPerformanceHistoryRow): string {
  return JSON.stringify([row.providerId, row.agentProfileId, row.upstreamProvider, row.model, performanceEnvironmentKey(row)])
}

export function compareLlmPerformanceHistory(rows: LlmPerformanceHistoryRow[]): LlmPerformanceHistoricalComparison[] {
  const groups = new Map<string, LlmPerformanceHistoryRow[]>()
  for (const row of rows) {
    const key = performanceHistoryKey(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return [...groups].map(([key, group]) => {
    const successful = group.filter(row => !row.failed)
    const waits = successful.flatMap(row => row.performance.firstOutputWaitMs == null ? [] : [row.performance.firstOutputWaitMs])
    // No current adapter exposes interval-aligned token deltas. Keep this separate from API history.
    const liveTokens: number[] = []
    const api = successful.flatMap(row => row.performance.apiTokensPerSecond == null ? [] : [row.performance.apiTokensPerSecond])
    const first = group[0]
    return {
      key, providerId: first.providerId, agentProfileId: first.agentProfileId, model: first.model,
      upstreamProvider: first.upstreamProvider, networkLabel: first.networkLabel,
      runs: group.length, failedRuns: group.length - successful.length,
      waitSamples: waits.length, medianWaitMs: median(waits),
      liveTokenSamples: liveTokens.length, medianLiveTokensPerSecond: median(liveTokens),
      apiSamples: api.length, medianApiTokensPerSecond: median(api)
    }
  })
}

export function compareLlmPerformance(rows: LlmPerformanceHistoryRow[]): LlmPerformanceComparison[] {
  const groups = new Map<string, LlmPerformanceHistoryRow[]>()
  for (const row of rows) {
    const key = performanceHistoryKey(row)
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
