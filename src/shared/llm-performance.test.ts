import { describe, expect, it } from 'vitest'
import { aggregateLlmPerformance, compareLlmPerformanceHistory, LlmPerformanceSampler } from './llm-performance'
import type { ActiveRun } from './trace'
import { RunRegistry } from '../main/run-registry'

const run = (runId: string, state?: 'streaming' | 'waiting', wait?: number): ActiveRun => ({
  runId, done: false, userText: '', items: [],
  llmPerformance: state ? {
    state, observedAt: new Date().toISOString(), networkLabel: '', streamCharacters: 4,
    recentOutput: [], windowMs: 3000, streamDurationMs: 1000,
    ...(wait == null ? {} : { firstOutputWaitMs: wait })
  } : undefined
})

describe('global LLM performance aggregation', () => {
  it('uses equal-session means and keeps live token evidence unavailable', () => {
    const summary = aggregateLlmPerformance([run('fast', 'streaming', 1000), run('slow', 'streaming', 3000), run('waiting', 'waiting')])
    expect(summary.running).toBe(3)
    expect(summary.outputting).toBe(2)
    expect(summary.firstOutputWaitMs).toBe(2000)
    expect(summary.firstOutputWaitMeasured).toBe(2)
    expect(summary.liveOutputRate).toBeNull()
    expect(summary.sessionAverageRate).toBeNull()
    expect(summary.liveOutputMeasured).toBe(0)
  })

  it('reads only bounded observations and selects one current main run per scoped session', () => {
    const old = { ...run('old', 'streaming', 999), providerId: 'claude' as const, cwd: '/a', sessionId: 'session' }
    const current = { ...run('new', 'waiting', 3000), providerId: 'claude' as const, cwd: '/a', sessionId: 'session' }
    Object.defineProperty(current, 'items', { get: () => { throw new Error('trace must not be scanned') } })
    expect(aggregateLlmPerformance([old, current, { ...run('other', 'waiting', 1000), cwd: '/b', sessionId: 'session' }]))
      .toMatchObject({ running: 2, outputting: 0, firstOutputWaitMs: 2000, firstOutputWaitMeasured: 2 })
  })

  it('excludes done runs at the production registry boundary', () => {
    const registry = new RunRegistry<ActiveRun, { runId: string }>()
    const active = run('active', 'waiting')
    const ended = { ...run('ended', 'streaming', 1000), done: true }
    registry.register(active, { runId: active.runId })
    registry.register(ended, { runId: ended.runId })
    const summary = aggregateLlmPerformance(registry.activeStates())
    expect(summary.running).toBe(1)
    expect(summary.outputting).toBe(0)
  })

  it('does not turn final-only output token usage into live token speed', () => {
    const sample = run('final-only', 'waiting')
    sample.llmPerformance = { ...sample.llmPerformance!, outputTokens: 120, apiDurationMs: 4000, apiTokensPerSecond: 30 }
    const summary = aggregateLlmPerformance([sample])
    expect(summary.liveOutputRate).toBeNull()
    expect(summary.sessionAverageRate).toBeNull()
  })

  it('keeps canonical API history separate from unavailable live token history', () => {
    const comparison = compareLlmPerformanceHistory([{
      runId: 'history', ts: new Date().toISOString(), providerId: 'claude', model: 'model', networkLabel: '', failed: false,
      performance: { state: 'complete', observedAt: new Date().toISOString(), networkLabel: '', streamCharacters: 10, recentOutput: [], windowMs: 3000,
        streamDurationMs: 1000, outputTokens: 100, apiDurationMs: 5000, apiTokensPerSecond: 20 }
    }])
    expect(comparison[0].liveTokenSamples).toBe(0)
    expect(comparison[0].medianLiveTokensPerSecond).toBeUndefined()
    expect(comparison[0].apiSamples).toBe(1)
    expect(comparison[0].medianApiTokensPerSecond).toBe(20)
  })

  it('groups automatic configuration evidence separately from historical notes and unknown system state', () => {
    const row = { runId: 'a', ts: new Date().toISOString(), providerId: 'claude' as const, model: 'model', networkLabel: 'VPN A', failed: false,
      performance: { state: 'complete' as const, observedAt: new Date().toISOString(), networkLabel: 'VPN A', streamCharacters: 0,
        recentOutput: [], windowMs: 3000, streamDurationMs: 0 } }
    const config = { source: 'macos-system-and-app-environment' as const, observedAt: row.ts,
      systemProxy: { http: false, https: true, socks: false, pac: false, discovery: false },
      environmentProxy: { http: false, https: false, all: false, bypass: false } }
    const automatic = { ...row, runId: 'auto', performance: { ...row.performance, networkConfiguration: config } }
    const later = { ...automatic, runId: 'later', performance: { ...automatic.performance,
      networkConfiguration: { ...config, observedAt: new Date(Date.parse(row.ts) + 60_000).toISOString() } } }
    const unknown = { ...automatic, runId: 'unknown', performance: { ...automatic.performance, networkConfiguration: { ...config, systemProxy: null } } }
    const groups = compareLlmPerformanceHistory([row, automatic, later, unknown, { ...unknown, runId: 'other-unknown' }])
    expect(groups).toHaveLength(4)
    expect(groups.map(group => group.runs)).toEqual([1, 2, 1, 1])
  })

  it('limits snapshots to one sample per second and 30 points', () => {
    const sampler = new LlmPerformanceSampler()
    const active = [run('a', 'streaming')]
    const first = sampler.sample(active, 1000)
    const same = sampler.sample([run('a', 'streaming')], 1500)
    expect(same).toBe(first)
    expect(sampler.sample([...active, run('b', 'waiting')], 1600)).toBe(first)
    for (let second = 2; second <= 40; second++) sampler.sample(active, second * 1000)
    expect(sampler.sample(active, 41000).trend).toHaveLength(30)
    expect(sampler.sample(active, 100000).trend).toHaveLength(1)
    expect(sampler.sample([], 101000).trend).toEqual([])
  })
})
