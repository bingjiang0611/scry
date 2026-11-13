import { describe, expect, it } from 'vitest'
import { loadPerCore, loadVerdict, percentile, summarize, timingSummary, voidReasons } from './stats.mjs'

describe('b4s stats', () => {
  it('uses the same nearest-rank percentile as daemon-mode-timing', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentile(values, 0.5)).toBe(60)
    expect(percentile(values, 0.95)).toBe(100)
    expect(percentile([5], 0.95)).toBe(5)
    expect(percentile([3, 1, 2], 0.5)).toBe(2)
  })

  it('keeps missing measurements out instead of counting them as 0', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([null, undefined, Number.NaN], 0.5)).toBeNull()
    expect(summarize([100, null, 300])).toEqual({ samples: 2, missing: 1, p50: 300, p95: 300, min: 100, max: 300 })
    expect(() => percentile([1], 1.5)).toThrow(/range/)
  })

  it('voids the round when load per core exceeds the bound or cannot be read', () => {
    expect(loadPerCore({ load1: 4, cores: 8 })).toBe(0.5)
    expect(loadVerdict([{ load1: 4, cores: 8 }]).void).toBe(false)
    const busy = loadVerdict([{ load1: 1, cores: 8, label: 'a' }, { load1: 4.2, cores: 8, label: 'b' }])
    expect(busy).toMatchObject({ void: true, worstPerCore: 0.525 })
    expect(busy.exceeded.map((reading) => reading.label)).toEqual(['b'])
    expect(loadVerdict([{ load1: Number.NaN, cores: 8 }]).void).toBe(true)
    expect(loadVerdict([]).void).toBe(true)
  })

  it('lists every void reason', () => {
    const quiet = loadVerdict([{ load1: 0.1, cores: 8 }])
    expect(voidReasons({ load: quiet, underTimingLock: true })).toEqual([])
    expect(voidReasons({ load: loadVerdict([{ load1: 8, cores: 8 }]), underTimingLock: false, invalidSamples: 2, error: 'x' }))
      .toEqual(['round_error', 'load_exceeded', 'not_under_timing_lock', 'invalid_samples'])
    expect(voidReasons({ load: loadVerdict([]), underTimingLock: true })).toEqual(['load_unavailable'])
  })

  it('publishes no percentile for a void round, and only valid samples otherwise', () => {
    const cases = {
      'daemon-cold': [
        { valid: true, metrics: { runSurfaceReadyMs: 900 } },
        { valid: false, metrics: { runSurfaceReadyMs: 5 } },
        { valid: true, metrics: { runSurfaceReadyMs: 1100 } }
      ]
    }
    const valid = timingSummary(cases, { reasons: [] })
    expect(valid.cases['daemon-cold'].runSurfaceReadyMs).toMatchObject({ samples: 2, p50: 1100 })
    const voided = timingSummary(cases, { reasons: ['load_exceeded'] })
    expect(voided).toMatchObject({ void: true, reasons: ['load_exceeded'] })
    expect(voided.cases['daemon-cold'].runSurfaceReadyMs).toEqual({ samples: 2, missing: 0, p50: null, p95: null, void: true })
  })
})
