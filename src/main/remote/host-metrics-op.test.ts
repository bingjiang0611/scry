import { describe, expect, it, vi } from 'vitest'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import type { HostMetricsSnapshot } from '../../shared/host-metrics'

// P8 §5: `hostMetrics` is a device-facing read-only op, answered with the
// remote-scope snapshot (no PID, no process name, no path, no volume name).
const PEER = 'a'.repeat(64)

const snapshot: HostMetricsSnapshot = {
  sampledAt: 1,
  uptimeSec: 10,
  cpu: { percent: 12, cores: 8, load1: 1 },
  memory: { totalBytes: 100, usedBytes: 40, pressure: 'low', swapUsedBytes: 0 },
  disks: [{ role: 'data', totalBytes: 100, freeBytes: 60 }],
  scry: { daemon: { cpuPercent: 1, rssBytes: 1 }, providers: [{ providerId: 'other', processes: 1, cpuPercent: 0, rssBytes: 1 }] },
  runs: { active: 0, queued: 0 }
}

function controller(overrides: Partial<{ hostMetrics: (peer: string) => Promise<HostMetricsSnapshot> }> = {}) {
  return {
    authority: { updateDeviceLabel: vi.fn(async () => undefined) },
    hostMetrics: overrides.hostMetrics ?? vi.fn(async () => snapshot)
  }
}

describe('device hostMetrics op', () => {
  it('returns the snapshot under the op key', async () => {
    const reply = await dispatchRemoteRequest(controller() as never, PEER, { op: 'hostMetrics', protocol: 3 })
    expect(reply).toEqual({ hostMetrics: snapshot })
  })

  it('answers invalid_request for any field the op does not define', async () => {
    const hostMetrics = vi.fn(async () => snapshot)
    const reply = await dispatchRemoteRequest(controller({ hostMetrics }) as never, PEER, { op: 'hostMetrics', protocol: 3, runId: 'run-1' })
    expect(reply).toEqual({ error: 'invalid_request' })
    expect(hostMetrics).not.toHaveBeenCalled()
  })

  it('reports a missing sampler by name instead of an empty machine', async () => {
    const failing = vi.fn(async (): Promise<HostMetricsSnapshot> => { throw new Error('host_metrics_unavailable') })
    const reply = await dispatchRemoteRequest(controller({ hostMetrics: failing }) as never, PEER, { op: 'hostMetrics', protocol: 3 })
    expect(reply).toEqual({ error: 'host_metrics_unavailable' })
  })

  it('keeps the protocol version gate ahead of the op', async () => {
    const hostMetrics = vi.fn(async () => snapshot)
    const reply = await dispatchRemoteRequest(controller({ hostMetrics }) as never, PEER, { op: 'hostMetrics', protocol: 2 })
    expect(reply).toMatchObject({ error: 'protocol_mismatch' })
    expect(hostMetrics).not.toHaveBeenCalled()
  })
})
