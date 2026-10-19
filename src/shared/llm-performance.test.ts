import { describe, expect, it } from 'vitest'
import { groupRunningLlmSessions, llmMetricSamples, smoothLlmMetric, summarizeRunningLlmSessions, type LlmPerformance, type LlmPerformanceHistoryRow, type LlmRunningSession } from './llm-performance'
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
    const current = { ...run('new', { state: 'tool', firstOutputWaitMs: 900, apiTokensPerSecond: 42, firstTokenMs: 1200, model: 'm' }), providerId: 'pi' as const, cwd: '/a', sessionId: 'session' }
    Object.defineProperty(current, 'items', { get: () => { throw new Error('trace must not be scanned') } })
    const summary = summarizeRunningLlmSessions([old, current, { ...run('other', undefined), cwd: '/b', sessionId: 'session' }])
    expect(summary.sessions).toEqual([
      expect.objectContaining({ runId: 'new', observedAt: new Date(0).toISOString(), providerId: 'pi', cwd: '/a', model: 'm', state: 'tool', outputStarted: true, tokensPerSecond: 42, firstTokenMs: 1200 }),
      expect.objectContaining({ cwd: '/b', state: 'waiting', outputStarted: false })
    ])
    expect(summary.sessions[1]).not.toHaveProperty('tokensPerSecond')
    expect(summary.sessions[1]).not.toHaveProperty('firstTokenMs')
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

describe('running LLM models', () => {
  const session = (key: string, partial: Partial<LlmRunningSession> = {}): LlmRunningSession => ({
    key, runId: key, model: 'astra', state: 'waiting', outputStarted: true, ...partial
  })

  it('merges matching models across projects and Providers and averages each session equally', () => {
    const sessions = [
      session('a', { cwd: '/scry', providerId: 'codex', tokensPerSecond: 28.9, firstTokenMs: 3000, state: 'tool' }),
      session('b', { model: 'sol', tokensPerSecond: 36.9, firstTokenMs: 2500 }),
      session('c', { cwd: '/scry', tokensPerSecond: 24.4, firstTokenMs: 3400 }),
      session('d', { cwd: '/etch', providerId: 'pi', tokensPerSecond: 22.5, firstTokenMs: 2900 }),
      session('e', { model: 'sol', tokensPerSecond: 33.3, firstTokenMs: 2400 })
    ]
    const groups = groupRunningLlmSessions(sessions)
    expect(groups.map(group => [group.model, group.sessions.length])).toEqual([['astra', 3], ['sol', 2]])
    expect(groups[0].tokensPerSecond).toBeCloseTo(25.2666667)
    expect(groups[0].firstTokenMs).toBeCloseTo(3100)
    expect(groups[1].tokensPerSecond).toBeCloseTo(35.1)
    expect(groups[1].firstTokenMs).toBe(2450)
    expect(groups[0].sessions.map(member => member.key)).toEqual(['a', 'c', 'd'])
    expect(sessions).toHaveLength(5)
  })

  it('uses separate measured-session denominators and never treats absent evidence as zero', () => {
    const [group] = groupRunningLlmSessions([
      session('a', { tokensPerSecond: 20 }), session('b', { firstTokenMs: 2000 }),
      session('c', { tokensPerSecond: 60, firstTokenMs: 0 }), session('d')
    ])
    expect(group).toMatchObject({ tokensPerSecond: 40, firstTokenMs: 1000 })
    const [missing] = groupRunningLlmSessions([session('missing')])
    expect(missing).not.toHaveProperty('tokensPerSecond')
    expect(missing).not.toHaveProperty('firstTokenMs')
  })

  it('keeps unknown models separate and recomputes when members leave', () => {
    const unknown = [session('a', { model: undefined, providerId: 'pi' }), session('b', { model: undefined, providerId: 'pi' })]
    expect(groupRunningLlmSessions(unknown).map(group => group.sessions.length)).toEqual([1, 1])
    expect(groupRunningLlmSessions([])).toEqual([])
    const remaining = session('last', { tokensPerSecond: 60 })
    expect(groupRunningLlmSessions([remaining])[0]).toMatchObject({ sessions: [remaining], tokensPerSecond: 60 })
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
    expect(llmMetricSamples([row(1000), missing, row(3000, { failed: true })], 'speed')).toEqual([{ ts: 1000, model: 'm', value: 20 }])
  })

  it('reads first-token wait in seconds and omits rounds without a first-block signal', () => {
    const timed = row(1000)
    timed.performance.firstTokenMs = 2500
    const failed = row(3000, { failed: true })
    failed.performance.firstTokenMs = 100
    // Speed evidence alone (e.g. Claude provider_api) never becomes a 0 s first-token wait.
    expect(llmMetricSamples([timed, row(2000), failed], 'firstToken')).toEqual([{ ts: 1000, model: 'm', value: 2.5 }])
  })

  it('includes one provisional sample per running Sol turn, using observation time rather than poll time', () => {
    const active = { ...run('sol', { model: 'gpt-6.1-sol', apiTokensPerSecond: 23.1, firstTokenMs: 3400,
      observedAt: new Date(5000).toISOString(), state: 'tool' }), providerId: 'codex' as const }
    const sessions = summarizeRunningLlmSessions([active], 9000).sessions
    expect(llmMetricSamples([], 'speed', sessions)).toEqual([
      { ts: 5000, model: 'gpt-6.1-sol', value: 23.1, provisional: true }
    ])
    expect(llmMetricSamples([], 'firstToken', sessions)).toEqual([
      { ts: 5000, model: 'gpt-6.1-sol', value: 3.4, provisional: true }
    ])
    active.llmPerformance!.apiTokensPerSecond = 30
    const updated = summarizeRunningLlmSessions([active], 10_000).sessions
    expect(llmMetricSamples([], 'speed', updated)).toHaveLength(1)
    expect(llmMetricSamples([], 'speed', updated)[0].value).toBe(30)
  })

  it('lets persisted completion or failure replace a stale running snapshot without double counting', () => {
    const sessions = summarizeRunningLlmSessions([run('1000', { model: 'm', apiTokensPerSecond: 40 })]).sessions
    expect(llmMetricSamples([row(1000)], 'speed', sessions)).toEqual([{ ts: 1000, model: 'm', value: 20 }])
    expect(llmMetricSamples([row(1000, { failed: true })], 'speed', sessions)).toEqual([])
  })

  it('omits missing live evidence, unknown models and terminal observations instead of inventing data', () => {
    const sessions = summarizeRunningLlmSessions([
      run('missing', { model: 'm' }),
      run('unknown-model', { apiTokensPerSecond: 50 }),
      run('terminal', { state: 'complete', model: 'm', apiTokensPerSecond: 60, firstTokenMs: 900 }),
      run('speed-only', { model: 'm', apiTokensPerSecond: 40 })
    ]).sessions
    expect(llmMetricSamples([], 'speed', sessions)).toEqual([{ ts: 0, model: 'm', value: 40, provisional: true }])
    expect(llmMetricSamples([], 'firstToken', sessions)).toEqual([])
    expect(llmMetricSamples([], 'speed', [])).toEqual([])
  })

  it('keeps the curve continuous on the 0 axis while marking idle points as unmeasured', () => {
    const minute = 60_000
    const samples = [{ ts: 10 * minute, model: 'm', value: 20 }, { ts: 11 * minute, model: 'm', value: 80 }]
    const points = smoothLlmMetric(samples, 0, 60 * minute, minute, 61)
    const busy = points[10]
    const idle = points[40]
    // Weighted geometric mean (≈33.8) stays below the weighted arithmetic mean (≈42.6) of a 4x outlier.
    expect(busy.value).toBeCloseTo(Math.exp((Math.log(20) + Math.exp(-0.5) * Math.log(80)) / (1 + Math.exp(-0.5))))
    expect(busy.value).toBeLessThan((20 + Math.exp(-0.5) * 80) / (1 + Math.exp(-0.5)))
    expect(busy.drawn).toBeCloseTo(busy.value!)
    expect(idle).toEqual({ ts: 40 * minute, value: null, drawn: 0 })
    expect(points.every(point => Number.isFinite(point.drawn))).toBe(true)
  })
})
