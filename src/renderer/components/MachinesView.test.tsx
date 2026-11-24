import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HostMetricsSnapshot } from '@shared/host-metrics'
import type { DesktopRemoteCatalog, DesktopRemoteConnection } from '@shared/desktop-remote'
import { refreshDesktopConnections } from '../hooks/useDesktopConnections'
import { resetMachines, refreshLocalMetrics, refreshTargetMetrics } from '../hooks/useMachines'
import { MachinesView } from './MachinesView'
import { MACHINES_COPY as copy } from '../constants/machines-copy'

const GB = 1024 ** 3
const snapshot: HostMetricsSnapshot = {
  sampledAt: Date.now() - 3000,
  uptimeSec: 3 * 86400,
  cpu: { percent: 34, cores: 10, load1: 4.1 },
  memory: { totalBytes: 16 * GB, usedBytes: 9.1 * GB, pressure: 'medium', swapUsedBytes: 2 * GB, swapTotalBytes: 4 * GB },
  disks: [{ role: 'data', totalBytes: 1000 * GB, freeBytes: 212 * GB }],
  scry: { daemon: { cpuPercent: 0.8, rssBytes: 210 * 1024 ** 2 }, providers: [] },
  runs: { active: 2, queued: 1 }
}
const host: DesktopRemoteConnection = {
  id: 'mac2', label: 'mac2', hostId: 'host', anchorSHA256: 'anchor',
  ssh: { hostname: 'mac2.example', username: 'test', port: 22 }, state: 'connected', expiresAt: 4102444800000
}
const list = vi.fn<() => Promise<DesktopRemoteConnection[]>>()
const catalog = vi.fn<() => Promise<DesktopRemoteCatalog>>()
const hostMetricsRead = vi.fn<() => Promise<HostMetricsSnapshot>>()
const targetHostMetrics = vi.fn<(id: string) => Promise<HostMetricsSnapshot>>()

const page = () => renderToStaticMarkup(<MachinesView onNewSession={() => {}} />)

beforeEach(async () => {
  resetMachines()
  hostMetricsRead.mockReset().mockResolvedValue(snapshot)
  targetHostMetrics.mockReset().mockResolvedValue(snapshot)
  list.mockReset().mockResolvedValue([])
  catalog.mockReset().mockResolvedValue({ projects: [], providers: [], providerEvidence: 'host_snapshot', sessions: [] })
  vi.stubGlobal('window', {
    scry: {
      hostMetricsRead,
      desktopRemote: { list, catalog, hostMetrics: targetHostMetrics },
      remoteDesktopHostStatus: vi.fn(async () => ({ enabled: true })),
      remoteStatus: vi.fn(async () => ({ kind: 'disabled' })),
      backgroundServiceStatus: vi.fn(async () => ({ state: 'running' }))
    }
  })
  await refreshDesktopConnections()
})
afterEach(() => vi.unstubAllGlobals())

describe('machines page', () => {
  it('shows 本机、执行目标 and 已配对的设备 in that order', () => {
    const html = page()
    const order = ['aria-label="本机"', 'aria-label="执行目标"', 'aria-label="已配对的设备"']
      .map((needle) => html.indexOf(needle))
    expect(order.every((position) => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain(copy.subtitle)
    expect(html).toContain('添加主机')
  })

  it('draws this machine from the read snapshot instead of placeholders', async () => {
    await refreshLocalMetrics()
    const html = page()
    expect(html).toContain(copy.online)
    expect(html).toContain('10 核 · 开机 3 天 · 运行中 2')
    expect(html).toContain('已用 9.1 GB / 16 GB')
    expect(html).toContain('剩余 212 GB')
    expect(html).toContain(copy.scryUsage)
    expect(html).toContain('后台服务')
    // 明细默认收起，但按钮在。
    expect(html).toContain(copy.expandDetail)
  })

  it('says why this machine could not be read instead of showing zeros', async () => {
    hostMetricsRead.mockRejectedValue(new Error("Error invoking remote method 'hostMetrics:read': Error: host_metrics_unavailable"))
    await refreshLocalMetrics()
    const html = page()
    expect(html).toContain(copy.readFailed)
    expect(html).toContain('host_metrics_unavailable')
    expect(html).not.toContain('0%')
  })

  it('shows a target machine\'s own numbers once they are read', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    await refreshTargetMetrics(host.id)
    const html = page()
    expect(html).toContain('data-connection-id="mac2"')
    expect(html).toContain('machine-target-metrics')
    expect(html).toContain('Provider 0 个进程')
  })

  it('tells an older host to upgrade instead of drawing an empty machine', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    targetHostMetrics.mockRejectedValue(new Error('desktop_host_metrics_unsupported'))
    await refreshTargetMetrics(host.id)
    const html = page()
    expect(html).toContain(copy.targetUnsupported)
    expect(html).not.toContain('machine-target-metrics')
  })

  it('says 离线 for a saved target that is not connected', async () => {
    list.mockResolvedValue([{ ...host, state: 'disconnected' }])
    await refreshDesktopConnections()
    const html = page()
    expect(html).toContain(copy.targetOffline)
    expect(html).not.toContain('machine-target-metrics')
  })

  it('keeps the last good numbers and names the failure when a target read breaks', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    await refreshTargetMetrics(host.id)
    targetHostMetrics.mockRejectedValue(new Error('请求超时（2 秒）'))
    await refreshTargetMetrics(host.id)
    const html = page()
    expect(html).toContain(`${copy.targetFailed('请求超时（2 秒）')}`)
    expect(html).toContain('machine-target-metrics')
  })
})
