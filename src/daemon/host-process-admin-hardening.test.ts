import 'reflect-metadata'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildIdentity } from '../shared/build-identity'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { callHostAdmin } from './host-admin-client'
import { HOST_ADMIN_DIR_NAME } from './host-admin-socket'

const extraDirs: string[] = []
function makeShortRoot(): string {
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  const dir = mkdtempSync(join(base, 'scry-hh-'))
  extraDirs.push(dir)
  return dir
}

afterEach(() => {
  cleanupTempDirs()
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('W11 review hardening: notice gate, invite rate limit, non-fatal socket errors, startup cleanup & log escaping', () => {
  it('omits hostAdminNotices and hostAdminNoticeItems from desktop info and catalogSnapshot when flag is off, and includes them when on (review #1)', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_REMOTE_HOST = '1'
    const root = makeShortRoot()
    let daemonOff: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    let daemonOn: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    try {
      // Flag OFF: pair a remote device, record a notice in HostAdminStore, and verify neither desktop info nor catalogSnapshot exposes it.
      process.env.SCRY_EXPERIMENTAL_HOST_CLI = '0'
      daemonOff = await startTestDaemon({ root })
      const begun = await daemonOff.localOp('localPairing', 'begin', [])
      const { pairingId, secret } = begun.result as { pairingId: string; secret: string }
      const dev = await generateDesktopDeviceIdentity()
      await daemonOff.host.service.authority.prove({ pairingId, secret, csrPEM: dev.csrPEM, deviceLabel: 'Paired Desktop' }, dev.publicKeySHA256)
      await daemonOff.localOp('localPairing', 'confirm', [pairingId, dev.publicKeySHA256])
      const remotePeer = daemonOff.host.service.authority.inspectLocal().grants.find((g) => g.publicKeySHA256 === dev.publicKeySHA256)!.certificateSHA256
      daemonOff.host.hostAdmin.recordNotice({ kind: 'desktop_disabled_via_cli' })
      const infoOff = await daemonOff.host.service.controller.readDesktop(remotePeer, { kind: 'info' })
      expect(infoOff.kind).toBe('info')
      expect('hostAdminNotices' in infoOff).toBe(false)
      const snapOff = await daemonOff.host.service.controller.catalogSnapshot(remotePeer, {})
      expect('unchanged' in snapOff).toBe(false)
      if (!('unchanged' in snapOff)) {
        expect('hostAdminNotices' in snapOff.info).toBe(false)
        expect('hostAdminNoticeItems' in snapOff).toBe(false)
      }
      await daemonOff.dispose()
      daemonOff = undefined

      // Flag ON: desktop info advertises hostAdminNotices: 1 and catalogSnapshot includes hostAdminNoticeItems.
      process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
      daemonOn = await startTestDaemon({ root })
      daemonOn.host.hostAdmin.recordNotice({ kind: 'desktop_disabled_via_cli' })
      const infoOn = await daemonOn.host.service.controller.readDesktop(remotePeer, { kind: 'info' })
      expect(infoOn).toMatchObject({ kind: 'info', hostAdminNotices: 1 })
      const snapOn = await daemonOn.host.service.controller.catalogSnapshot(remotePeer, {})
      expect('unchanged' in snapOn).toBe(false)
      if (!('unchanged' in snapOn)) {
        expect(snapOn.info).toMatchObject({ kind: 'info', hostAdminNotices: 1 })
        expect(snapOn.hostAdminNoticeItems?.some((n) => n.kind === 'desktop_disabled_via_cli')).toBe(true)
      }
    } finally {
      await daemonOff?.dispose()
      await daemonOn?.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
    }
  }, 30_000)

  it('starts daemon without adminSocket and logs error when socket path exceeds 100 bytes or admin dir is invalid (review #4)', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
    process.env.SCRY_REMOTE_HOST = '1'
    const base = makeShortRoot()
    // Size longRoot so `daemonStateDir` is 78 bytes: local.sock (89 B) & local-enroll.sock (96 B) <= 100 B,
    // while host-admin/host-admin.sock (105 B) > 100 B and triggers host_admin_socket_path_too_long only on admin socket.
    const suffixLen = Math.max(1, 78 - Buffer.byteLength(join(base, 'a', 'userData', 'daemon')))
    const longRoot = join(base, 'x'.repeat(suffixLen))
    mkdirSync(longRoot, { recursive: true })
    const logsLong: string[] = []
    let dLong: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    let dBadDir: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    try {
      dLong = await startTestDaemon({ root: longRoot, log: (line) => logsLong.push(line) })
      expect(dLong.host.adminSocket).toBeUndefined()
      expect((await dLong.localOp('localBackgroundService', 'status', [])).error).toBeUndefined()
      expect(logsLong.some((l) => l.includes('host-admin.disabled') && l.includes('host_admin_socket_path_too_long'))).toBe(true)

      const badRoot = makeShortRoot()
      const badStateDir = join(badRoot, 'userData', 'daemon')
      mkdirSync(badStateDir, { recursive: true })
      // Place a regular file where `host-admin` directory should be.
      writeFileSync(join(badStateDir, HOST_ADMIN_DIR_NAME), 'not-a-dir')
      const logsBad: string[] = []
      dBadDir = await startTestDaemon({ root: badRoot, log: (line) => logsBad.push(line) })
      expect(dBadDir.host.adminSocket).toBeUndefined()
      expect((await dBadDir.localOp('localBackgroundService', 'status', [])).error).toBeUndefined()
      expect(logsBad.some((l) => l.includes('host-admin.disabled'))).toBe(true)
    } finally {
      await dLong?.dispose()
      await dBadDir?.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
    }
  }, 30_000)

  it('enforces socket-level invite rate limit (6/h shared across phone & desktop, persists across restart), cleans stale challenge-* on startup, and escapes method in logs (review #5 + small items)', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
    process.env.SCRY_REMOTE_HOST = '1'
    const root = makeShortRoot()
    const adminDir = join(root, 'userData', 'daemon', HOST_ADMIN_DIR_NAME)
    mkdirSync(adminDir, { recursive: true, mode: 0o700 })
    const staleChallenge = join(adminDir, `challenge-${'f'.repeat(32)}`)
    writeFileSync(staleChallenge, 'stale-token', { mode: 0o600 })
    const logs: string[] = []
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    let restarted: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    try {
      daemon = await startTestDaemon({ root, log: (line) => logs.push(line) })
      // Startup cleanup removes leftover challenge-* files.
      expect(existsSync(staleChallenge)).toBe(false)

      const id = buildIdentity('test')
      const stateDir = join(daemon.userDataDir, 'daemon')
      const call = (method: string, args?: Record<string, unknown>) =>
        callHostAdmin({ daemonStateDirectory: stateDir, clientIdentity: id, method, ...(args ? { args } : {}) })

      // Method log injection must be escaped onto a single line.
      const forged = 'bad\nhost-admin method=approve result=ok'
      expect(await call(forged)).toEqual({ ok: false, error: 'unsupported_method' })
      const methodLogs = logs.filter((line) => line.includes('unsupported_method'))
      expect(methodLogs.length).toBeGreaterThanOrEqual(1)
      for (const line of methodLogs) {
        expect(line).not.toContain('\n')
      }

      // Enable CLI approval and exhaust 6/h invite rate limit across phone & desktop.
      expect((await daemon.localOp('localHostAdmin', 'setCliApproval', [true])).error).toBeUndefined()
      for (let i = 0; i < 6; i++) {
        const res = await call(i % 2 === 0 ? 'invite_phone' : 'invite_desktop')
        expect(res.ok, `invite #${i + 1}`).toBe(true)
      }
      const seventh = await call('invite_phone')
      expect(seventh).toMatchObject({ ok: false, error: 'host_cli_rate_limited', retryAfterMs: expect.any(Number) })

      // Restart preserves invite rate limit counter.
      await daemon.dispose()
      daemon = undefined
      restarted = await startTestDaemon({ root })
      const afterRestart = await callHostAdmin({
        daemonStateDirectory: join(restarted.userDataDir, 'daemon'),
        clientIdentity: id,
        method: 'invite_desktop'
      })
      expect(afterRestart).toMatchObject({ ok: false, error: 'host_cli_rate_limited' })
    } finally {
      await daemon?.dispose()
      await restarted?.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
    }
  }, 45_000)
})
