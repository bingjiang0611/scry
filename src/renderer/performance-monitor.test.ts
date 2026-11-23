import { describe, expect, it } from 'vitest'
import { hasProjectedOutput, RendererPerformanceAccumulator } from './performance-monitor'
import type { SessionHistoryPage } from '@shared/session-history'

describe('renderer performance accumulator', () => {
  it('aggregates frame gaps and long tasks by bounded windows, then resets', () => {
    const accumulator = new RendererPerformanceAccumulator()
    accumulator.recordFrame(16)
    accumulator.recordFrame(55)
    accumulator.recordLongTask(52.25)
    accumulator.recordLongTask(70.05)

    expect(accumulator.snapshotAndReset(5_000)).toEqual({
      windowMs: 5_000,
      frameCount: 2,
      slowFrameCount: 1,
      maxFrameGapMs: 55,
      longTaskCount: 2,
      longTaskTotalMs: 122.3,
      longestLongTaskMs: 70.1
    })
    expect(accumulator.snapshotAndReset(5_000)).toMatchObject({
      frameCount: 0,
      longTaskCount: 0,
      maxFrameGapMs: 0
    })
  })
})

it('attributes snapshot output only to the currently received run', () => {
  const event = { id: 'text', runId: 'new-run', ts: '2026-01-01T00:00:00Z', kind: 'model' as const, stage: 'text' as const, text: 'Visible reply' }
  const archived = { runId: 'archived-run', userText: 'prompt', items: [{ ...event, runId: 'archived-run' }] }
  const page: SessionHistoryPage = {
    turns: [archived], offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete',
    projection: { sessionKey: 'session', activeRun: { runId: 'new-run', userText: 'prompt', items: [event], done: false } }
  }
  expect(hasProjectedOutput(page, 'new-run')).toBe(true)
  expect(hasProjectedOutput(page, 'archived-run')).toBe(true)
  expect(hasProjectedOutput(page, 'unrelated')).toBe(false)
  expect(hasProjectedOutput({ ...page, projection: undefined }, 'archived-run')).toBe(false)
  expect(hasProjectedOutput({ ...page, projection: { sessionKey: 'session', activeRun: null } }, 'new-run')).toBe(false)
})
