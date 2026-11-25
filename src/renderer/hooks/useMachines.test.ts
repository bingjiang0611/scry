import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostMetricsSnapshot } from '@shared/host-metrics'
import {
  ensureMachinesRead, machinesSnapshot, refreshLocalMetrics, refreshMachines, refreshTargetMetrics, resetMachines
} from './useMachines'

const GB = 1024 ** 3
const snapshot: HostMetricsSnapshot = {
  sampledAt: 1_700_000_000_000,
  uptimeSec: 3600,
  cpu: { percent: 12, cores: 8, load1: 1 },
  memory: { totalBytes: 16 * GB, usedBytes: 8 * GB, pressure: 'low', swapUsedBytes: 0, swapTotalBytes: 0 },
  disks: [{ role: 'data', totalBytes: 100, freeBytes: 50 }],
  scry: { daemon: { cpuPercent: 1, rssBytes: 1024 }, providers: [] },
  runs: { active: 0, queued: 0 }
}

const hostMetricsRead = vi.fn<() => Promise<HostMetricsSnapshot>>()
const targetHostMetrics = vi.fn<(id: string) => Promise<HostMetricsSnapshot>>()

beforeEach(() => {
  resetMachines()
  hostMetricsRead.mockReset()
  targetHostMetrics.mockReset()
  vi.stubGlobal('window', { scry: { hostMetricsRead, desktopRemote: { hostMetrics: targetHostMetrics } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('machine reads', () => {
  it('reads the local machine once for two callers', async () => {
    hostMetricsRead.mockResolvedValue(snapshot)
    await Promise.all([refreshLocalMetrics(), refreshLocalMetrics()])
    expect(hostMetricsRead).toHaveBeenCalledTimes(1)
    expect(machinesSnapshot().local).toEqual({ status: 'ready', snapshot })
    expect(machinesSnapshot().updatedAt).toBe(snapshot.sampledAt)
  })

  it('keeps the last good numbers when a read fails, and says why', async () => {
    hostMetricsRead.mockResolvedValueOnce(snapshot)
    await refreshLocalMetrics()
    hostMetricsRead.mockRejectedValueOnce(new Error("Error invoking remote method 'hostMetrics:read': Error: host_metrics_unavailable"))
    await refreshLocalMetrics()
    expect(machinesSnapshot().local).toMatchObject({
      status: 'failed', detail: 'host_metrics_unavailable', stale: snapshot
    })
  })

  it('marks a host that does not declare the capability instead of showing an empty machine', async () => {
    targetHostMetrics.mockRejectedValue(new Error('desktop_host_metrics_unsupported'))
    await refreshTargetMetrics('mac4')
    expect(machinesSnapshot().targets.get('mac4')).toMatchObject({
      unsupported: true, read: { status: 'failed', detail: 'desktop_host_metrics_unsupported' }
    })
  })

  it('does not read a different failure as a missing capability', async () => {
    // 只有那个确切的错误码才写「请升级」；别的失败照样是读取失败。
    targetHostMetrics.mockRejectedValue(new Error('Error invoking remote method \'desktopRemote:hostMetrics\': Error: desktop_host_metrics_unsupported_timeout'))
    await refreshTargetMetrics('mac4')
    expect(machinesSnapshot().targets.get('mac4')).toMatchObject({ read: { status: 'failed' } })
    expect(machinesSnapshot().targets.get('mac4')?.unsupported).toBeUndefined()
  })

  it('refreshes the local machine and every saved target in one pass', async () => {
    hostMetricsRead.mockResolvedValue(snapshot)
    targetHostMetrics.mockResolvedValue({ ...snapshot, runs: { active: 2, queued: 1 } })
    await refreshMachines(['mac2', 'mac3'])
    expect(hostMetricsRead).toHaveBeenCalledTimes(1)
    expect(targetHostMetrics.mock.calls.map(([id]) => id)).toEqual(['mac2', 'mac3'])
    expect(machinesSnapshot().refreshing).toBe(false)
  })

  it('reads once on open and does not re-read when the page is shown again', async () => {
    hostMetricsRead.mockResolvedValue(snapshot)
    targetHostMetrics.mockResolvedValue(snapshot)
    ensureMachinesRead(['mac2'])
    await vi.waitFor(() => expect(machinesSnapshot().local.status).toBe('ready'))
    await vi.waitFor(() => expect(machinesSnapshot().targets.get('mac2')?.read.status).toBe('ready'))
    ensureMachinesRead(['mac2'])
    expect(hostMetricsRead).toHaveBeenCalledTimes(1)
    expect(targetHostMetrics).toHaveBeenCalledTimes(1)
  })
})
