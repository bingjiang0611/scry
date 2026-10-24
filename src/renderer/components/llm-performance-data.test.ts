import { describe, expect, it } from 'vitest'
import { llmMetricSamples, type LlmMetricSample, type LlmPerformanceHistoryRow, type LlmRunningSession } from '@shared/llm-performance'
import { compareModels, INTERVAL_MS, metricAxisMax, metricDistribution, metricIntervals } from './llm-performance-data'

const sample = (ts: number, value: number, model = 'm', provisional = false): LlmMetricSample => ({ ts, value, model, provisional })

describe('performance distributions', () => {
  it('summarizes full measured range and quartiles without inventing missing measurements', () => {
    expect(metricDistribution([])).toBeNull()
    expect(metricDistribution([sample(1, 10), sample(2, 20), sample(3, 30), sample(4, 400, 'm', true)]))
      .toEqual({ count: 4, provisional: 1, min: 10, q1: 17.5, median: 25, q3: 122.5, max: 400 })
  })

  it('retains speed-only and first-token-only models, with independent denominators', () => {
    const rows = compareModels([sample(1, 20, 'both'), sample(2, 40, 'both', true), sample(3, 50, 'speed')],
      [sample(1, 2, 'both'), sample(3, 3, 'wait')])
    expect(rows.map(row => row.model)).toEqual(['speed', 'both', 'wait'])
    expect(rows[0].waitSummary).toBeNull()
    expect(rows[1].speedSummary).toMatchObject({ count: 2, provisional: 1, median: 30 })
    expect(rows[1].waitSummary).toMatchObject({ count: 1, median: 2 })
    expect(rows[2].speedSummary).toBeNull()
    expect(rows[2].waitSummary?.median).toBe(3)
  })

  it('keeps sparse samples at actual times, with no fabricated median or idle zero', () => {
    const input = [sample(11, 20), sample(19, 80, 'm', true)]
    const intervals = metricIntervals(input, 0, 100, 10)
    expect(intervals).toHaveLength(2)
    expect(intervals.map(point => [point.ts, point.median, point.individual, point.provisional]))
      .toEqual([[11, 20, true, 0], [19, 80, true, 1]])
    expect(metricIntervals([], 0, 100, 10)).toEqual([])
  })

  it('clips interval time boundaries, not measured extremes, and excludes out-of-range samples', () => {
    const input = [sample(1, 9999), sample(3, 10), sample(5, 20), sample(7, 1000, 'm', true), sample(9, 9999)]
    expect(metricIntervals(input, 2, 8, 10)).toEqual([{
      ts: 5, start: 2, stop: 8, individual: false, count: 3, provisional: 1,
      min: 10, q1: 15, median: 20, q3: 510, max: 1000
    }])
    expect(metricAxisMax([10, 20, 1000])).toBeGreaterThanOrEqual(1000)
    expect(metricAxisMax([])).toBe(1)
  })

  it('conserves all evidence across production time ranges including boundary and singleton samples', () => {
    for (const span of Object.values(INTERVAL_MS)) {
      const input = [sample(0, 1), sample(1, 2), sample(2, 3, 'm', true),
        sample(span + 1, 4), sample(span + 2, 5), sample(span * 3, 6000)]
      const points = metricIntervals(input, 0, span * 3, span)
      expect(points.reduce((sum, point) => sum + point.count, 0)).toBe(input.length)
      expect(points.reduce((sum, point) => sum + point.provisional, 0)).toBe(1)
      expect(Math.min(...points.map(point => point.min))).toBe(1)
      expect(Math.max(...points.map(point => point.max))).toBe(6000)
      expect(points.some(point => point.ts > span * 2 && point.ts < span * 3)).toBe(false)
    }
  })

  it('keeps live completed-call evidence and replaces it with the final persisted round', () => {
    const live: LlmRunningSession = { key: 'key', runId: 'r', model: 'm', state: 'tool', outputStarted: true,
      observedAt: new Date(100).toISOString(), tokensPerSecond: 40, firstTokenMs: 1500 }
    const rows: LlmPerformanceHistoryRow[] = [{ runId: 'r', ts: new Date(200).toISOString(), model: 'm', providerId: 'pi',
      networkLabel: '', failed: false, performance: { state: 'complete', observedAt: new Date(200).toISOString(),
        networkLabel: '', streamCharacters: 0, recentOutput: [], windowMs: 1000, streamDurationMs: 0,
        apiTokensPerSecond: 50, firstTokenMs: 2000 } }]
    const before = compareModels(llmMetricSamples([], 'speed', [live]), llmMetricSamples([], 'firstToken', [live]))[0]
    expect(before.speedSummary).toMatchObject({ count: 1, provisional: 1, median: 40 })
    const after = compareModels(llmMetricSamples(rows, 'speed', [live]), llmMetricSamples(rows, 'firstToken', [live]))[0]
    expect(after.speedSummary).toMatchObject({ count: 1, provisional: 0, median: 50 })
    expect(after.waitSummary?.median).toBe(2)
  })
})
