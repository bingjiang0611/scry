import { describe, expect, it } from 'vitest'
import { llmSpeedSamples, smoothLlmSpeed, summarizeRunningLlmSessions, type LlmPerformance, type LlmPerformanceHistoryRow } from './llm-performance'
import type { ActiveRun } from './trace'
import { RunRegistry } from '../main/run-registry'

const performance = (partial: Partial<LlmPerformance> = {}): LlmPerformance => ({
  state: 'waiting', observedAt: new Date(0).toISOString(), networkLabel: '', streamCharacters: 0,
  recentOutput: [], windowMs: 3000, streamDurationMs: 0, ...partial
})
const run = (runId: string, partial: Partial<LlmPerformance> | undefined = {}): ActiveRun => ({
  runId, done: false, userText: '', items: [], llmPerformance: partial && performance(partial)
})

describe('running LLM sessions', () => {
  it('reads only bounded observations and keeps the latest main run per scoped session', () => {
    const old = { ...run('old', { state: 'streaming' }), providerId: 'pi' as const, cwd: '/a', sessionId: 'session' }
    const current = { ...run('new', { state: 'tool', firstOutputWaitMs: 900, apiTokensPerSecond: 42, model: 'm' }), providerId: 'pi' as const, cwd: '/a', sessionId: 'session' }
    Object.defineProperty(current, 'items', { get: () => { throw new Error('trace must not be scanned') } })
    const summary = summarizeRunningLlmSessions([old, current, { ...run('other', undefined), cwd: '/b', sessionId: 'session' }])
    expect(summary.sessions).toEqual([
      expect.objectContaining({ providerId: 'pi', cwd: '/a', model: 'm', state: 'tool', outputStarted: true, tokensPerSecond: 42 }),
      expect.objectContaining({ cwd: '/b', state: 'waiting', outputStarted: false })
    ])
    expect(summary.sessions[1]).not.toHaveProperty('tokensPerSecond')
  })

  it('excludes done runs at the production registry boundary', () => {
    const registry = new RunRegistry<ActiveRun, { runId: string }>()
    const active = run('active')
    const ended = { ...run('ended', { state: 'streaming' }), done: true }
    registry.register(active, { runId: active.runId })
    registry.register(ended, { runId: ended.runId })
    expect(summarizeRunningLlmSessions(registry.activeStates()).sessions.map(session => session.key)).toHaveLength(1)
  })
})

describe('LLM speed history', () => {
  const row = (ts: number, partial: Partial<LlmPerformanceHistoryRow> & { speed?: number } = {}): LlmPerformanceHistoryRow => ({
    runId: String(ts), ts: new Date(ts).toISOString(), providerId: 'pi', model: 'm', networkLabel: '', failed: false,
    performance: performance({ state: 'complete', apiTokensPerSecond: partial.speed ?? 20 }), ...partial
  })

  it('omits failed rounds and rounds without token timing instead of treating them as 0 token/s', () => {
    const missing = row(2000)
    delete missing.performance.apiTokensPerSecond
    expect(llmSpeedSamples([row(1000), missing, row(3000, { failed: true })])).toEqual([{ ts: 1000, model: 'm', tokensPerSecond: 20 }])
  })

  it('keeps the curve continuous on the 0 axis while marking idle points as unmeasured', () => {
    const minute = 60_000
    const samples = [{ ts: 10 * minute, model: 'm', tokensPerSecond: 20 }, { ts: 11 * minute, model: 'm', tokensPerSecond: 80 }]
    const points = smoothLlmSpeed(samples, 0, 60 * minute, minute, 61)
    const busy = points[10]
    const idle = points[40]
    // Weighted geometric mean (≈33.8) stays below the weighted arithmetic mean (≈42.6) of a 4x outlier.
    expect(busy.speed).toBeCloseTo(Math.exp((Math.log(20) + Math.exp(-0.5) * Math.log(80)) / (1 + Math.exp(-0.5))))
    expect(busy.speed).toBeLessThan((20 + Math.exp(-0.5) * 80) / (1 + Math.exp(-0.5)))
    expect(busy.drawn).toBeCloseTo(busy.speed!)
    expect(idle).toEqual({ ts: 40 * minute, speed: null, drawn: 0 })
    expect(points.every(point => Number.isFinite(point.drawn))).toBe(true)
  })
})
