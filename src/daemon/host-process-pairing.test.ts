import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

// B4-L4 pairing: the daemon answers the pairing screen from its own host, on main's
// enable rule, and never offers the App's own local-socket grant as a paired device.

describe('daemon pairing and host status', () => {
  it('reports remote access off where the in-process App would (dev build, no SCRY_REMOTE_HOST)', async () => {
    const saved = process.env.SCRY_REMOTE_HOST
    delete process.env.SCRY_REMOTE_HOST
    const daemon = await startTestDaemon()
    try {
      expect((await daemon.localOp('localHostStatus', 'status', [])).result).toEqual({ enabled: false })
      expect((await daemon.localOp('localPairing', 'begin', [])).error).toBe('远程访问未启用')
      expect((await daemon.localOp('localDesktopHost', 'status', [])).result).toEqual({ enabled: false })
      expect((await daemon.localOp('localDesktopHost', 'invite', [])).error).toBe('远程访问未启用')
    } finally {
      await daemon.dispose()
      if (saved !== undefined) process.env.SCRY_REMOTE_HOST = saved
    }
  }, 30_000)

  it('pairs from the daemon host and keeps the App\'s own connection out of the device list', async () => {
    const saved = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_REMOTE_HOST = '1'
    const daemon = await startTestDaemon()
    try {
      const status = (await daemon.localOp('localHostStatus', 'status', [])).result as { enabled: boolean; devices: Array<{ deviceId: string }> }
      expect(status.enabled).toBe(true)
      // The harness enrolled itself over the local socket: that grant is not a device.
      const local = daemon.host.service.authority.inspectLocal().grants.filter((grant) => grant.scope === 'local')
      expect(local.length).toBeGreaterThan(0)
      expect(status.devices.map((device) => device.deviceId)).not.toContain(local[0]!.deviceId)
      const refused = await daemon.localOp('localPairing', 'revoke', [local[0]!.deviceId])
      expect(refused.error).toBe('这是本机 App 与后台服务的连接，不是已配对设备，不能在这里撤销')
      // Still connected: the next call is answered.
      expect((await daemon.localOp('localHostStatus', 'status', [])).error).toBeUndefined()

      const begun = await daemon.localOp('localPairing', 'begin', [])
      expect(begun.error).toBeUndefined()
      const { pairingId } = begun.result as { pairingId: string }
      const pending = (await daemon.localOp('localHostStatus', 'status', [])).result as { pending: Array<{ pairingId: string }> }
      expect(pending.pending.map((item) => item.pairingId)).toContain(pairingId)
      expect((await daemon.localOp('localPairing', 'cancel', [pairingId])).error).toBeUndefined()
      // A confirmation must name the key the user compared; a made-up one is refused.
      expect((await daemon.localOp('localPairing', 'confirm', [pairingId, 'a'.repeat(64)])).error).toBeTruthy()

      // Desktop access (another desktop App pairs with this host) is the daemon host's too.
      expect((await daemon.localOp('localDesktopHost', 'status', [])).result).toMatchObject({ enabled: false })
      const invite = await daemon.localOp('localDesktopHost', 'invite', [])
      expect(invite.error).toBeUndefined()
      expect(invite.result).toMatch(/^scry-desktop1:/)
      expect((await daemon.localOp('localDesktopHost', 'status', [])).result).toMatchObject({ enabled: true })
      expect((await daemon.localOp('localDesktopHost', 'disable', [])).error).toBeUndefined()
      expect((await daemon.localOp('localDesktopHost', 'status', [])).result).toMatchObject({ enabled: false })
    } finally {
      await daemon.dispose()
      if (saved === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = saved
    }
  }, 30_000)
})
