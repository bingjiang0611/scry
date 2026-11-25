import { describe, expect, it } from 'vitest'
import { llmComparisonRounds, type LlmMetricSample, type LlmPerformanceHistoryRow, type LlmRunningSession } from '@shared/llm-performance'
import { compareModels, metricAxisMax, metricDistribution } from './llm-performance-data'

const sample = (ts: number, value: number, provisional = false): LlmMetricSample => ({ ts, value, provisional })

describe('performance distributions', () => {
  it('summarizes full measured range and quartiles without inventing missing measurements', () => {
    expect(metricDistribution([])).toBeNull()
    expect(metricDistribution([sample(1, 10), sample(2, 20), sample(3, 30), sample(4, 400, true)]))
      .toEqual({ count: 4, provisional: 1, min: 10, q1: 17.5, median: 25, q3: 122.5, max: 400 })
  })

  it('keeps unmeasured rounds and separates same-named models by Agent', () => {
    const rows = compareModels([
      { ts: 1, model: 'shared', providerId: 'pi', state: 'completed', metrics: { speed: 20, firstToken: 2 } },
      { ts: 2, model: 'shared', providerId: 'pi', state: 'running', metrics: { speed: 40 } },
      { ts: 1, model: 'shared', providerId: 'antigravity', state: 'completed', metrics: { firstOutput: 14 } },
      { ts: 2, model: 'shared', providerId: 'antigravity', state: 'completed', metrics: {} },
      { ts: 3, model: 'shared', providerId: 'antigravity', state: 'failed', metrics: {} },
      { ts: 4, providerId: 'opencode', state: 'completed', metrics: {} }
    ])
    expect(rows.map(row => row.providerId)).toEqual(['pi', 'antigravity', 'opencode'])
    expect(rows[0].speedSummary).toMatchObject({ count: 2, provisional: 1, median: 30 })
    expect(rows[0].waitSummary).toMatchObject({ count: 1, median: 2 })
    expect(rows[1]).toMatchObject({ completed: 2, failed: 1, running: 0, speedSummary: null, waitSummary: null, outputSummary: { count: 1, median: 14 } })
    expect(rows[2]).toMatchObject({ completed: 1, speedSummary: null, waitSummary: null, outputSummary: null })
  })

  it('picks an axis top above the measured peak, never a percentile cut', () => {
    expect(metricAxisMax([10, 20, 1000])).toBeGreaterThanOrEqual(1000)
    expect(metricAxisMax([])).toBe(1)
  })

  it('keeps live completed-call evidence and replaces it with the final persisted round', () => {
    const live: LlmRunningSession = { key: 'key', runId: 'r', model: 'm', state: 'tool', outputStarted: true,
      observedAt: new Date(100).toISOString(), tokensPerSecond: 40, firstTokenMs: 1500 }
    const rows: LlmPerformanceHistoryRow[] = [{ runId: 'r', ts: new Date(200).toISOString(), model: 'm', providerId: 'pi',
      networkLabel: '', failed: false, performance: { state: 'complete', observedAt: new Date(200).toISOString(),
        networkLabel: '', streamCharacters: 0, recentOutput: [], windowMs: 1000, streamDurationMs: 0,
        apiTokensPerSecond: 50, firstTokenMs: 2000 } }]
    const before = compareModels(llmComparisonRounds([], [live]))[0]
    expect(before.speedSummary).toMatchObject({ count: 1, provisional: 1, median: 40 })
    const after = compareModels(llmComparisonRounds(rows, [live]))[0]
    expect(after.speedSummary).toMatchObject({ count: 1, provisional: 0, median: 50 })
    expect(after.waitSummary?.median).toBe(2)
  })
})
