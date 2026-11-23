import { afterEach, describe, expect, it } from 'vitest'
import { MEASURED_REMOTE_OPERATIONS, remoteOperationCounters, remoteOperationLabel, remoteRequestTrace } from './remote-request-timing'
import { setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import { HOST_PROTOCOL_VERSION } from './remote-protocol'
import type { HostController } from './host-controller'

const samples: PerformanceSample[] = []
const PEER = 'a'.repeat(64)

afterEach(() => { setPerformanceRecordingSink(null); samples.length = 0 })

describe('remote request timing labels', () => {
  it('labels known protocol operations and collapses anything else to other', () => {
    expect(remoteOperationLabel({ op: 'subscribe', waitMs: 0 })).toBe('subscribe')
    expect(remoteOperationLabel({ op: 'sessionsPage' })).toBe('sessionsPage')
    // Retired v2 operations must collapse to other rather than stay in the allowlist.
    for (const retired of ['liveRuns', 'poll', 'runState', 'questions', 'intentStatus', 'watch', 'watchStream']) {
      expect(remoteOperationLabel({ op: retired })).toBe('other')
    }
    // An unvalidated body must not become a free-text telemetry label.
    expect(remoteOperationLabel({ op: 'private prompt text' })).toBe('other')
    expect(remoteOperationLabel({ op: 'x'.repeat(64) })).toBe('other')
    expect(remoteOperationLabel({})).toBe('other')
    expect(remoteOperationLabel(null)).toBe('other')
    expect(remoteOperationLabel('request')).toBe('other')
    expect(remoteOperationCounters({ op: 'submit', intentId: 'intent-1' })).toEqual({ 'op.submit': 1 })
  })

  it('keeps only operations recognized by the current protocol dispatcher', async () => {
    const controller = new Proxy({}, {
      get: () => () => { throw new Error('reached_controller') }
    }) as HostController
    for (const op of MEASURED_REMOTE_OPERATIONS) {
      const reply = await dispatchRemoteRequest(controller, PEER, { protocol: HOST_PROTOCOL_VERSION, op })
      expect(reply, `measured operation "${op}" is not handled by dispatchRemoteRequest`).not.toEqual({ error: 'unknown_op' })
    }
  })

  it('counts v3 subscription and compatibility operations without logging their contents', () => {
    for (const op of ['subscribe', 'submitAtLog', 'intentStatusAtLog']) {
      const request = { op, knownLogId: 'private-log', detail: 'private-prompt', intentId: 'private-intent' }
      expect(remoteOperationCounters(request)).toEqual({ [`op.${op}`]: 1 })
    }
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
