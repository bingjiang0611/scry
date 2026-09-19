import { describe, expect, it } from 'vitest'
import { RendererPerformanceAccumulator } from './performance-monitor'

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
