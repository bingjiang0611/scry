import { afterEach, describe, expect, it } from 'vitest'
import { remoteOperationCounters, remoteOperationLabel, remoteRequestTrace } from './remote-request-timing'
import { setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'

const samples: PerformanceSample[] = []

afterEach(() => { setPerformanceRecordingSink(null); samples.length = 0 })

describe('remote request timing labels', () => {
  it('labels known protocol operations and collapses anything else to other', () => {
    expect(remoteOperationLabel({ op: 'liveRuns', waitMs: 0 })).toBe('liveRuns')
    expect(remoteOperationLabel({ op: 'watch', runId: 'run-1' })).toBe('watch')
    // An unvalidated body must not become a free-text telemetry label.
    expect(remoteOperationLabel({ op: 'private prompt text' })).toBe('other')
    expect(remoteOperationLabel({ op: 'x'.repeat(64) })).toBe('other')
    expect(remoteOperationLabel({})).toBe('other')
    expect(remoteOperationLabel(null)).toBe('other')
    expect(remoteOperationLabel('request')).toBe('other')
    expect(remoteOperationCounters({ op: 'poll', cursor: 3 })).toEqual({ 'op.poll': 1 })
  })

  it('records only stage names and bounded op counters, never request content', () => {
    setPerformanceRecordingSink(sample => samples.push(sample))
    const trace = remoteRequestTrace('remote.desktop.request')!
    trace.mark('connect_started')
    trace.mark('secure_connect')
    trace.finish({ ...remoteOperationCounters({ op: 'desktop' }), handshakes: 1 })
    expect(samples).toHaveLength(1)
    const [sample] = samples
    expect(sample.name).toBe('remote.desktop.request')
    expect(sample.dimensions).toEqual({})
    expect(sample.checkpoints.map(point => point.stage)).toEqual(['connect_started', 'secure_connect'])
    expect(sample.counters).toEqual({ 'op.desktop': 1, handshakes: 1 })
    expect(JSON.stringify(samples)).not.toMatch(/private|secret/)
  })

  it('does not allocate a trace when recording is off', () => {
    setPerformanceRecordingSink(null)
    expect(remoteRequestTrace('remote.host.request')).toBeUndefined()
  })
})
