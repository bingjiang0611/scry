import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { HOST_METRICS_CACHE_MS } from '../shared/host-metrics'

afterEach(cleanupTempDirs)

// P8 §9 集成：临时 HOME/userData 下真实启动 daemon，读一次 hostMetrics，字段齐全，
// null 的语义正确。这台机器上的 vm_stat / ps 是真的，其他一切都在临时目录里。
describe('host metrics on a real daemon', () => {
  it('answers a complete snapshot for the App, with the local PID', async () => {
    const daemon = await startTestDaemon()
    try {
      const reply = await daemon.localOp('hostMetrics', 'read', [])
      expect(reply.error).toBeUndefined()
      const snapshot = reply.result
      expect(typeof snapshot.sampledAt).toBe('number')
      expect(snapshot.cpu.cores).toBeGreaterThan(0)
      expect(snapshot.cpu.percent === null || (snapshot.cpu.percent >= 0 && snapshot.cpu.percent <= 100)).toBe(true)
      expect(snapshot.memory.totalBytes).toBeGreaterThan(0)
      // Either the platform read worked, or the field is honestly null.
      expect(snapshot.memory.usedBytes === null || snapshot.memory.usedBytes > 0).toBe(true)
      expect(snapshot.memory.usedBytes === null || snapshot.memory.usedBytes < snapshot.memory.totalBytes).toBe(true)
      expect(snapshot.uptimeSec === null || snapshot.uptimeSec > 0).toBe(true)
      expect(Array.isArray(snapshot.disks)).toBe(true)
      expect(snapshot.disks[0]).toMatchObject({ role: 'data' })
      expect(snapshot.disks[0].totalBytes).toBeGreaterThan(0)
      expect(snapshot.scry.daemon.pid).toBe(process.pid)
      expect(snapshot.scry.daemon.rssBytes).toBeGreaterThan(0)
      expect(snapshot.scry.providers === null || Array.isArray(snapshot.scry.providers)).toBe(true)
      expect(snapshot.runs).toEqual({ active: expect.any(Number), queued: expect.any(Number) })
    } finally {
      await daemon.dispose()
    }
  })

  it('serves a second read inside the cache window from the cached sample', async () => {
    const daemon = await startTestDaemon()
    try {
      const first = await daemon.localOp('hostMetrics', 'read', [])
      const second = await daemon.localOp('hostMetrics', 'read', [])
      expect(second.result.sampledAt).toBe(first.result.sampledAt)
      expect(first.result.sampledAt).toBeGreaterThan(Date.now() - HOST_METRICS_CACHE_MS - 60_000)
    } finally {
      await daemon.dispose()
    }
  })

  it('refuses arguments instead of silently ignoring a scope request', async () => {
    const daemon = await startTestDaemon()
    try {
      // The op takes no argument at all: a caller cannot ask for another scope.
      const reply = await daemon.localOp('hostMetrics', 'read', [{ scope: 'remote' }])
      expect(reply.error).toBe('invalid_request')
    } finally {
      await daemon.dispose()
    }
  })
})
