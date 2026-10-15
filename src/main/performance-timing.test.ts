import { describe, expect, it } from 'vitest'
import { PerformanceTrace, type PerformanceSample } from './performance-timing'

describe('PerformanceTrace', () => {
  it('emits bounded content-free checkpoints and counters', () => {
    const samples: PerformanceSample[] = []
    const trace = new PerformanceTrace('session_history.load', { provider: 'codex' }, (sample) => samples.push(sample))
    trace.mark('archive', { turns: 40, bytes: 1024 })
    const sample = trace.finish({ returnedTurns: 40 })

    expect(sample).toEqual(samples[0])
    expect(sample).toMatchObject({
      name: 'session_history.load',
      dimensions: { provider: 'codex' },
      counters: { returnedTurns: 40 },
      checkpoints: [{ stage: 'archive', counters: { turns: 40, bytes: 1024 } }]
    })
    expect(sample!.durationMs).toBeGreaterThanOrEqual(0)
    expect(sample!.checkpoints[0].deltaMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(sample)).not.toContain('prompt')
    expect(trace.finish()).toBeNull()
  })

  it('does not persist malformed provider values from rejected IPC requests', () => {
    const samples: PerformanceSample[] = []
    new PerformanceTrace('session_history.load', { provider: 'SECRET/path/or/prompt' }, sample => samples.push(sample)).finish(undefined, 'error')
    expect(samples[0]).toMatchObject({ outcome: 'error', dimensions: { provider: 'unknown' } })
    expect(JSON.stringify(samples)).not.toContain('SECRET')
  })

  it('is a no-op without a sink when performance logging is disabled', () => {
    const previous = process.env.SCRY_PERF_LOG
    delete process.env.SCRY_PERF_LOG
    try {
      const trace = new PerformanceTrace('disabled')
      trace.mark('ignored', { count: 1 })
      expect(trace.finish()).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.SCRY_PERF_LOG
      else process.env.SCRY_PERF_LOG = previous
    }
  })
})
