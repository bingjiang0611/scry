import 'reflect-metadata'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)


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
      const local = daemon.host.service.authority.inspectLocal().grants.filter((grant) => grant.scope === 'local')
      expect(local.length).toBeGreaterThan(0)
      expect(status.devices.map((device) => device.deviceId)).not.toContain(local[0]!.deviceId)
      const refused = await daemon.localOp('localPairing', 'revoke', [local[0]!.deviceId])
      expect(refused.error).toBe('这是本机 App 与后台服务的连接，不是已配对设备，不能在这里撤销')
      expect((await daemon.localOp('localHostStatus', 'status', [])).error).toBeUndefined()

      const begun = await daemon.localOp('localPairing', 'begin', [])
      expect(begun.error).toBeUndefined()
      const { pairingId } = begun.result as { pairingId: string }
      const pending = (await daemon.localOp('localHostStatus', 'status', [])).result as { pending: Array<{ pairingId: string }> }
      expect(pending.pending.map((item) => item.pairingId)).toContain(pairingId)
      expect((await daemon.localOp('localPairing', 'cancel', [pairingId])).error).toBeUndefined()
      expect((await daemon.localOp('localPairing', 'confirm', [pairingId, 'a'.repeat(64)])).error).toBeTruthy()

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

  it('keeps inviting past the 64-record table, and the App re-enrolls after a restart', async () => {
    const saved = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_REMOTE_HOST = '1'
    const first = await startTestDaemon()
    let second: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    try {
      for (let i = 0; i < 70; i++) expect((await first.localOp('localPairing', 'begin', [])).error).toBeUndefined()
      await first.dispose()
      second = await startTestDaemon({ root: first.root })
      const state = second.host.service.authority.inspectLocal()
      expect(state.pairings.filter((p) => p.state === 'cancelled' || p.state === 'expired').length).toBeLessThanOrEqual(17)
      expect(state.grants.filter((grant) => grant.scope === 'local' && grant.revokedAt === null)).toHaveLength(1)
      expect((await second.localOp('localPairing', 'begin', [])).error).toBeUndefined()
    } finally {
      await first.dispose()
      await second?.dispose()
      if (saved === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = saved
    }
  }, 60_000)

  it('starts and enrolls the App when persisted remote grants carry approvedVia', async () => {
    const saved = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_REMOTE_HOST = '1'
    const first = await startTestDaemon()
    let second: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    try {
      const { userDataDir } = first
      const pairingFile = join(userDataDir, 'remote', 'pairing', 'pairing-state.json')
      await first.dispose()

      const envelope = JSON.parse(readFileSync(pairingFile, 'utf8')) as { version: number; payload: string; sha256: string }
      const state = JSON.parse(envelope.payload) as {
        version: 1
        hostId: string
        anchorSHA256: string
        pairings: Array<Record<string, unknown>>
        grants: Array<Record<string, unknown>>
      }
      const now = Date.now()
      const pairingId = randomUUID()
      const deviceId = randomUUID()
      state.grants.push({
        certificatePEM: 'synthetic certificate, not cryptographic evidence',
        certificateSHA256: 'e'.repeat(64),
        publicKeySHA256: 'f'.repeat(64),
        deviceId,
        expiresAt: now + 3_600_000,
        pairingId,
        deviceLabel: 'CLI Approved Phone',
        authority: 'owner-device',
        source: 'local_confirmation',
        scope: 'remote',
        approvedVia: 'host_cli',
        confirmedAt: now - 1_000,
        revokedAt: null
      })
      state.pairings.push({
        pairingId,
        secretVerifier: createHash('sha256').update(`s${'0'.repeat(42)}`).digest('hex'),
        createdAt: now - 2_000,
        expiresAt: now - 2_000 + 120_000,
        attempts: 0,
        state: 'paired',
        deviceId
      })
      const payload = JSON.stringify(state)
      const sha256 = createHash('sha256').update(payload).digest('hex')
      writeFileSync(pairingFile, JSON.stringify({ version: 1, payload, sha256 }), { mode: 0o600 })

      second = await startTestDaemon({ root: first.root })
      const status = (await second.localOp('localHostStatus', 'status', [])).result as {
        enabled: boolean
        devices: Array<{ deviceId: string; deviceLabel: string }>
      }
      expect(status.enabled).toBe(true)
      expect(status.devices).toContainEqual(expect.objectContaining({ deviceId, deviceLabel: 'CLI Approved Phone' }))
      const persisted = second.host.service.authority.inspectLocal().grants
      expect(persisted.find(g => g.deviceId === deviceId)).toMatchObject({ approvedVia: 'host_cli' })
      const localGrants = persisted.filter(g => g.scope === 'local' && g.revokedAt === null)
      expect(localGrants).toHaveLength(1)
      expect('approvedVia' in localGrants[0]!).toBe(false)
    } finally {
      await first.dispose()
      await second?.dispose()
      if (saved === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = saved
    }
  }, 30_000)
})
