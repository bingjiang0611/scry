import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { HOST_METRICS_CACHE_MS } from '../shared/host-metrics'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'

afterEach(cleanupTempDirs)

// P8 §9 集成：临时 HOME/userData 下真实启动 daemon，读一次 hostMetrics，字段齐全，
// null 的语义正确。这台机器上的 vm_stat / ps 是真的，其他一切都在临时目录里。
describe('host metrics on a real daemon', () => {
  it('answers a complete snapshot for the App, with the local PID', async () => {
    const daemon = await startTestDaemon()
    try {
      const reply = await daemon.localOp('localHostMetrics', 'read', [])
      expect(reply.error).toBeUndefined()
      const snapshot = reply.result
      expect(typeof snapshot.sampledAt).toBe('number')
      expect(snapshot.cpu.cores).toBeGreaterThan(0)
      expect(snapshot.cpu.percent === null || (snapshot.cpu.percent >= 0 && snapshot.cpu.percent <= 100)).toBe(true)
      expect(snapshot.memory.totalBytes).toBeGreaterThan(0)
      expect(snapshot.memory.usedBytes === null || snapshot.memory.usedBytes > 0).toBe(true)
      expect(snapshot.memory.usedBytes === null || snapshot.memory.usedBytes < snapshot.memory.totalBytes).toBe(true)
      expect(snapshot.uptimeSec === null || snapshot.uptimeSec > 0).toBe(true)
      expect(Array.isArray(snapshot.disks)).toBe(true)
      expect(snapshot.disks[0]).toMatchObject({ role: 'data' })
      expect(snapshot.disks[0].totalBytes).toBeGreaterThan(0)
      expect(snapshot.scry.daemon.pid).toBe(process.pid)
      expect(snapshot.scry.daemon.rssBytes).toBeGreaterThan(0)
      expect(snapshot.scry.providers === null || Array.isArray(snapshot.scry.providers)).toBe(true)
      // 排队数在编排投影里，第一版没接：null 而不是 0。
      expect(snapshot.runs).toEqual({ active: expect.any(Number), queued: null })
    } finally {
      await daemon.dispose()
    }
  })

  it('serves a second read inside the cache window from the cached sample', async () => {
    const daemon = await startTestDaemon()
    try {
      const first = await daemon.localOp('localHostMetrics', 'read', [])
      const second = await daemon.localOp('localHostMetrics', 'read', [])
      expect(second.result.sampledAt).toBe(first.result.sampledAt)
      expect(first.result.sampledAt).toBeGreaterThan(Date.now() - HOST_METRICS_CACHE_MS - 60_000)
    } finally {
      await daemon.dispose()
    }
  })

  it('declares hostMetrics: 1 to a Desktop, and serves it when asked', async () => {
    const saved = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_REMOTE_HOST = '1'
    const daemon = await startTestDaemon()
    try {
      const begun = await daemon.localOp('localPairing', 'begin', [])
      const { pairingId, secret } = begun.result as { pairingId: string; secret: string }
      const dev = await generateDesktopDeviceIdentity()
      await daemon.host.service.authority.prove({ pairingId, secret, csrPEM: dev.csrPEM, deviceLabel: 'Paired Desktop' }, dev.publicKeySHA256)
      await daemon.localOp('localPairing', 'confirm', [pairingId, dev.publicKeySHA256])
      const peer = daemon.host.service.authority.inspectLocal().grants.find((grant) => grant.publicKeySHA256 === dev.publicKeySHA256)!.certificateSHA256
      const info = await daemon.host.service.controller.readDesktop(peer, { kind: 'info' })
      expect(info).toMatchObject({ kind: 'info', hostMetrics: 1 })
      const reply = await daemon.request({ op: 'hostMetrics' })
      expect(reply.error).toBeUndefined()
      expect(reply.hostMetrics.scry.daemon).not.toHaveProperty('pid')
    } finally {
      await daemon.dispose()
      if (saved === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = saved
    }
  })

  it('answers a paired device with the redacted remote scope only', async () => {
    const daemon = await startTestDaemon()
    try {
      const reply = await daemon.request({ op: 'hostMetrics' })
      expect(reply.error).toBeUndefined()
      const serialized = JSON.stringify(reply.hostMetrics)
      // P8 §5: no PID, no process name, no path, no volume name.
      expect(serialized).not.toContain('"pid"')
      expect(serialized).not.toContain(process.pid.toString())
      expect(serialized).not.toContain(daemon.root)
      expect(serialized).not.toMatch(/\/(Users|private|tmp|var)\//)
      for (const disk of reply.hostMetrics.disks) expect(Object.keys(disk).sort()).toEqual(['freeBytes', 'role', 'totalBytes'])
      for (const provider of reply.hostMetrics.providers ?? []) {
        expect(Object.keys(provider).sort()).toEqual(['cpuPercent', 'processes', 'providerId', 'rssBytes'])
      }
      expect(reply.hostMetrics.sampledAt).toBeGreaterThan(0)
    } finally {
      await daemon.dispose()
    }
  })

  it('refuses arguments instead of silently ignoring a scope request', async () => {
    const daemon = await startTestDaemon()
    try {
      // The op takes no argument at all: a caller cannot ask for another scope.
      const reply = await daemon.localOp('localHostMetrics', 'read', [{ scope: 'remote' }])
      expect(reply.error).toBe('invalid_request')
    } finally {
      await daemon.dispose()
    }
  })
})
