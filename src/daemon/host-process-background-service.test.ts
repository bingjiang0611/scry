import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

// B4-S S0-1: the «后台服务» section asks the daemon what only it knows, on the App's
// local endpoint. Paired devices only: the App's own local grant is not a device.

describe('daemon background service status (local op)', () => {
  it('reports its version, pid, start time and runs, and says when remote access is off', async () => {
    const saved = process.env.SCRY_REMOTE_HOST
    delete process.env.SCRY_REMOTE_HOST
    const daemon = await startTestDaemon()
    try {
      const reply = await daemon.localOp('localBackgroundService', 'status', [])
      expect(reply.error).toBeUndefined()
      expect(reply.result).toEqual({
        version: 'test',
        pid: process.pid,
        startedAt: Math.round(performance.timeOrigin),
        // Remote access off is a state, not "0 devices".
        devices: { state: 'remote-disabled' },
        activeRuns: 0
      })
    } finally {
      await daemon.dispose()
      if (saved !== undefined) process.env.SCRY_REMOTE_HOST = saved
    }
  }, 30_000)

  it('counts paired devices without the App\'s own local grant, and takes no arguments', async () => {
    const saved = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_REMOTE_HOST = '1'
    const daemon = await startTestDaemon()
    try {
      // The harness enrolled over the local socket; that grant exists and is not counted.
      const local = daemon.host.service.authority.inspectLocal().grants.filter((grant) => grant.scope === 'local')
      expect(local.length).toBeGreaterThan(0)
      const reply = await daemon.localOp('localBackgroundService', 'status', [])
      expect(reply.result).toMatchObject({ devices: { state: 'known', paired: 0 }, activeRuns: 0 })
      expect((await daemon.localOp('localBackgroundService', 'status', ['extra'])).error).toBe('invalid_request')
    } finally {
      await daemon.dispose()
      if (saved !== undefined) process.env.SCRY_REMOTE_HOST = saved
    }
  }, 30_000)
})
