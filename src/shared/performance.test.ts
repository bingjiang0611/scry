import { describe, expect, it } from 'vitest'
import { isRendererPerformanceSample } from './performance'

const valid = {
  windowMs: 5_000,
  frameCount: 240,
  slowFrameCount: 2,
  maxFrameGapMs: 34,
  longTaskCount: 1,
  longTaskTotalMs: 52,
  longestLongTaskMs: 52
}

describe('renderer performance sample contract', () => {
  it('accepts only bounded numeric aggregates', () => {
    expect(isRendererPerformanceSample(valid)).toBe(true)
    expect(isRendererPerformanceSample({ ...valid, prompt: 'secret' })).toBe(false)
    expect(isRendererPerformanceSample({ ...valid, slowFrameCount: 241 })).toBe(false)
    expect(isRendererPerformanceSample({ ...valid, maxFrameGapMs: Number.NaN })).toBe(false)
    expect(isRendererPerformanceSample({ ...valid, windowMs: 0 })).toBe(false)
  })
})
