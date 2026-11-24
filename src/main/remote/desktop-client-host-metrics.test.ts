import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { setup, ssh } from './desktop-client-fixtures'
import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'

// P8 §5: the Desktop reads an execution target's resources through
// `desktopRemote:hostMetrics`, and only when that host declared `hostMetrics: 1`.
// An older host is named as such; a malformed answer is refused, and no local
// detail (PID) can ride along even if a host tried to send it.

const SNAPSHOT = {
  sampledAt: 1_700_000_000_000,
  uptimeSec: 100,
  cpu: { percent: 12, cores: 8, load1: 1.5 },
  memory: { totalBytes: 16, usedBytes: 8, pressure: 'low', swapUsedBytes: 0, swapTotalBytes: 20 },
  disks: [{ role: 'data', totalBytes: 100, freeBytes: 40 }],
  scry: { daemon: { cpuPercent: 1, rssBytes: 10 }, providers: [{ providerId: 'other', processes: 1, cpuPercent: 0, rssBytes: 5 }] },
  runs: { active: 0, queued: 0 }
}

async function connect(hostMetrics?: unknown) {
  const fixture = await setup()
  const pending = await fixture.client.pair({ label: 'machines', ssh, invitation: fixture.invitation })
  await fixture.client.finishPairing(pending.connection.id)
  const original = fixture.tlsRequest.getMockImplementation()!
  fixture.tlsRequest.mockImplementation(async (options) => {
    const request = options.request as { op?: string }
    if (request.op === 'desktop') {
      return {
        desktop: {
          kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: fixture.host.hostId, execution: 'canonical', subscribe: 1,
          ...(hostMetrics !== undefined ? { hostMetrics: 1 } : {})
        }
      }
    }
    if (request.op === 'hostMetrics') return { hostMetrics: hostMetrics ?? SNAPSHOT }
    return original(options)
  })
  await fixture.client.connect(pending.connection.id)
  return { fixture, connectionId: pending.connection.id }
}

describe('Desktop host metrics forwarding', () => {
  it('reads the snapshot when the target declared hostMetrics: 1', async () => {
    const { fixture, connectionId } = await connect(SNAPSHOT)
    try {
      await expect(fixture.client.hostMetrics(connectionId)).resolves.toEqual(SNAPSHOT)
    } finally {
      await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('names an older host instead of pretending an empty machine', async () => {
    const { fixture, connectionId } = await connect(undefined)
    try {
      await expect(fixture.client.hostMetrics(connectionId)).rejects.toThrow('desktop_host_metrics_unsupported')
    } finally {
      await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('refuses a malformed snapshot', async () => {
    const { fixture, connectionId } = await connect({ sampledAt: 'yesterday' })
    try {
      await expect(fixture.client.hostMetrics(connectionId)).rejects.toThrow('invalid_host_metrics')
    } finally {
      await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('keeps an unmeasured queue as null instead of refusing the whole snapshot', async () => {
    // 真机 daemon 报 `queued: null`（排队数在 W20 的编排投影里，第一版没接）。
    // 这不是坏数据，界面就显示「排队 不可用」。当成非法值会把整台主机的资源读取废掉。
    const unmeasured = { ...SNAPSHOT, runs: { active: 2, queued: null } }
    const { fixture, connectionId } = await connect(unmeasured)
    try {
      await expect(fixture.client.hostMetrics(connectionId)).resolves.toEqual(unmeasured)
    } finally {
      await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('still refuses a queue count that is not a count', async () => {
    const broken = { ...SNAPSHOT, runs: { active: 0, queued: 1.5 } }
    const { fixture, connectionId } = await connect(broken)
    try {
      await expect(fixture.client.hostMetrics(connectionId)).rejects.toThrow('invalid_host_metrics')
    } finally {
      await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('cannot carry a PID into the Desktop, even from a host that sends one', async () => {
    const withPid = { ...SNAPSHOT, scry: { daemon: { ...SNAPSHOT.scry.daemon, pid: 4242 }, providers: SNAPSHOT.scry.providers } }
    const { fixture, connectionId } = await connect(withPid)
    try {
      const snapshot = await fixture.client.hostMetrics(connectionId)
      expect(snapshot).toEqual(SNAPSHOT)
      expect(JSON.stringify(snapshot)).not.toContain('pid')
    } finally {
      await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
