import { describe, expect, it } from 'vitest'
import { groupRunningLlmSessions, llmComparisonRounds, summarizeRunningLlmSessions, type LlmPerformance, type LlmPerformanceHistoryRow, type LlmRunningSession } from './llm-performance'
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

  it('merges matching models across projects only within an Agent', () => {
    const sessions = [
      session('a', { cwd: '/scry', providerId: 'codex', tokensPerSecond: 28.9, firstTokenMs: 3000, state: 'tool' }),
      session('b', { model: 'sol', tokensPerSecond: 36.9, firstTokenMs: 2500 }),
      session('c', { cwd: '/etch', providerId: 'codex', tokensPerSecond: 24.4, firstTokenMs: 3400 }),
      session('d', { cwd: '/etch', providerId: 'pi', tokensPerSecond: 22.5, firstTokenMs: 2900 }),
      session('e', { model: 'sol', tokensPerSecond: 33.3, firstTokenMs: 2400 })
    ]
    const groups = groupRunningLlmSessions(sessions)
    expect(groups.map(group => [group.providerId, group.model, group.sessions.length])).toEqual([
      ['codex', 'astra', 2], [undefined, 'sol', 2], ['pi', 'astra', 1]
    ])
    expect(groups[0].tokensPerSecond).toBeCloseTo(26.65)
    expect(groups[0].firstTokenMs).toBe(3200)
    expect(groups[1].tokensPerSecond).toBeCloseTo(35.1)
    expect(groups[1].firstTokenMs).toBe(2450)
    expect(groups[0].sessions.map(member => member.key)).toEqual(['a', 'c'])
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

describe('LLM comparison rounds', () => {
  const row = (ts: number, partial: Partial<LlmPerformanceHistoryRow> = {}): LlmPerformanceHistoryRow => ({
    runId: String(ts), ts: new Date(ts).toISOString(), providerId: 'pi', model: 'm', networkLabel: '', failed: false,
    performance: performance({ state: 'complete', apiTokensPerSecond: 20, firstTokenMs: 2500 }), ...partial
  })

  it('retains coverage without timing and never substitutes first visible output for TTFT', () => {
    const agy = row(1000, { providerId: 'antigravity', performance: performance({ firstOutputWaitMs: 14_000, outputTokens: 40, averageCharactersPerSecond: 25 }) })
    const missing = row(2000, { performance: performance() })
    const failed = row(3000, { failed: true })
    expect(llmComparisonRounds([agy, missing, failed, row(4000)]).map(({ providerId, state, metrics }) => ({ providerId, state, metrics }))).toEqual([
      { providerId: 'antigravity', state: 'completed', metrics: { firstOutput: 14 } },
      { providerId: 'pi', state: 'completed', metrics: {} },
      { providerId: 'pi', state: 'failed', metrics: {} },
      { providerId: 'pi', state: 'completed', metrics: { speed: 20, firstToken: 2.5 } }
    ])
  })

  it('drops the placeholder model prefixes and unmodelled failed rounds (Q7)', () => {
    const selected = row(1000, { model: '所选：model-a' })
    const unknown = row(2000, { model: '未知模型' })
    const failedUnknown = row(3000, { model: '未知模型', failed: true })
    const rounds = llmComparisonRounds([selected, unknown, failedUnknown])
    expect(rounds).toEqual([expect.objectContaining({ model: 'model-a', state: 'completed' })])
    expect(JSON.stringify(rounds)).not.toContain('所选：')
    expect(JSON.stringify(rounds)).not.toContain('未知模型')
  })

  it('only shows provisional rounds once a model is observed, and persisted failure wins', () => {
    const sessions = summarizeRunningLlmSessions([
      { ...run('1000', { firstOutputWaitMs: 900 }), providerId: 'antigravity' },
      run('missing', { model: 'm' }),
      run('terminal', { state: 'complete', model: 'm', apiTokensPerSecond: 60, firstTokenMs: 900 }),
      run('call', { model: 'm', apiTokensPerSecond: 40, firstTokenMs: 1200 })
    ]).sessions
    // 还没有观测到模型的一轮没有行可归：表里不能出现只写 Agent 名的「模型」行（Q1/Q7）。
    expect(llmComparisonRounds([], sessions)).toEqual([
      { ts: 0, model: 'm', state: 'running', metrics: { speed: 40, firstToken: 1.2 } }
    ])
    expect(llmComparisonRounds([row(1000, { providerId: 'antigravity', failed: true })], sessions)).toEqual([
      { ts: 1000, providerId: 'antigravity', model: 'm', state: 'failed', metrics: {} },
      { ts: 0, model: 'm', state: 'running', metrics: { speed: 40, firstToken: 1.2 } }
    ])
  })
})
