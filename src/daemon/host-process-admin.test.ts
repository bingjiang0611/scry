import 'reflect-metadata'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildIdentity } from '../shared/build-identity'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { callHostAdmin, readHostAdminChallengeFile } from './host-admin-client'
import { HOST_ADMIN_DIR_NAME, HOST_ADMIN_SOCKET_NAME } from './host-admin-socket'

const extraDirs: string[] = []
function makeShortRoot(): string {
  // Keep unix socket path `<root>/userData/daemon/host-admin/host-admin.sock` < 100 bytes on macOS.
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  const dir = mkdtempSync(join(base, 'scry-ha-'))
  extraDirs.push(dir)
  return dir
}
afterEach(() => {
  cleanupTempDirs()
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sendRawFrames(socketPath: string, lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const replies: string[] = []
    let buffer = ''
    let step = 0
    const socket = createConnection(socketPath)
    socket.on('error', reject)
    socket.on('connect', () => {
      if (lines[0] !== undefined) socket.write(`${lines[0]}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        replies.push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
        step += 1
        if (lines[step] !== undefined) socket.write(`${lines[step]}\n`)
        idx = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => resolve(replies))
  })
}

async function createProvedPairing(
  daemon: Awaited<ReturnType<typeof startTestDaemon>>,
  pairingId: string,
  secret: string,
  label = 'Test Phone'
) {
  const dev = await generateDesktopDeviceIdentity()
  const receipt = await daemon.host.service.authority.prove(
    { pairingId, secret, csrPEM: dev.csrPEM, deviceLabel: label },
    dev.publicKeySHA256
  )
  return { receipt, publicKeySHA256: dev.publicKeySHA256 }
}

describe('W11 P5-5: host-admin.sock security, challenge auth, whitelist, rate limits & pairing', () => {
  it('does NOT listen on host-admin.sock and does NOT write approvedVia when SCRY_EXPERIMENTAL_HOST_CLI is off', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '0'
    process.env.SCRY_REMOTE_HOST = '1'
    const daemon = await startTestDaemon({ root: makeShortRoot() })
    try {
      const stateDir = join(daemon.userDataDir, 'daemon')
      const sock = join(stateDir, HOST_ADMIN_DIR_NAME, HOST_ADMIN_SOCKET_NAME)
      expect(existsSync(sock)).toBe(false)
      expect(daemon.host.adminSocket).toBeUndefined()

      // App pairing confirmation must NOT write approvedVia when flag is off (release-order compatibility).
      const begun = await daemon.localOp('localPairing', 'begin', [])
      const { pairingId, secret } = begun.result as { pairingId: string; secret: string }
      const { publicKeySHA256 } = await createProvedPairing(daemon, pairingId, secret, 'Legacy Phone')
      const confirmed = await daemon.localOp('localPairing', 'confirm', [pairingId, publicKeySHA256])
      expect(confirmed.error).toBeUndefined()
      const grant = daemon.host.service.authority.inspectLocal().grants.find((g) => g.publicKeySHA256 === publicKeySHA256)
      expect(grant).toBeDefined()
      expect('approvedVia' in grant!).toBe(false)
    } finally {
      await daemon.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
    }
  }, 30_000)

  it('enforces 0600 socket perms, version mismatch, challenge failures/replay/cleanup, symlink/mode/owner checks', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
    process.env.SCRY_REMOTE_HOST = '1'
    const daemon = await startTestDaemon({ root: makeShortRoot() })
    try {
      const stateDir = join(daemon.userDataDir, 'daemon')
      const adminDir = join(stateDir, HOST_ADMIN_DIR_NAME)
      const sockPath = join(adminDir, HOST_ADMIN_SOCKET_NAME)
      expect(statSync(adminDir).mode & 0o777).toBe(0o700)
      expect(statSync(sockPath).mode & 0o777).toBe(0o600)

      // 1. Version mismatch rejected before challenge creation.
      const mismatch = await callHostAdmin({
        daemonStateDirectory: stateDir,
        clientIdentity: { version: '9.9.9', build: 'other-build' },
        method: 'status'
      })
      expect(mismatch).toMatchObject({ ok: false, error: 'daemon_version_mismatch', daemon: { version: 'test' } })

      // 2. Missing challenge token & wrong challenge token rejected, and challenge file is deleted.
      const id = buildIdentity('test')
      const badTokenReplies = await sendRawFrames(sockPath, [
        JSON.stringify({ version: 1, client: id }),
        JSON.stringify({ challenge: '0'.repeat(64), method: 'status' })
      ])
      expect(JSON.parse(badTokenReplies[0]!)).toMatchObject({ ok: true, challenge: expect.stringMatching(/^challenge-[0-9a-f]{32}$/) })
      expect(JSON.parse(badTokenReplies[1]!)).toEqual({ ok: false, error: 'host_admin_auth_failed' })
      expect(readdirSync(adminDir).filter((f) => f.startsWith('challenge-'))).toEqual([])

      const missingTokenReplies = await sendRawFrames(sockPath, [
        JSON.stringify({ version: 1, client: id }),
        JSON.stringify({ method: 'status' })
      ])
      expect(JSON.parse(missingTokenReplies[1]!)).toEqual({ ok: false, error: 'host_admin_auth_failed' })
      expect(readdirSync(adminDir).filter((f) => f.startsWith('challenge-'))).toEqual([])

      // 3. Replay of a consumed challenge token on a second connection fails.
      const captured = await new Promise<{ file: string; token: string }>((resolve, reject) => {
        const s = createConnection(sockPath)
        s.on('error', reject)
        s.on('connect', () => s.write(`${JSON.stringify({ version: 1, client: id })}\n`))
        let buf = ''
        let challenged = false
        s.on('data', (chunk) => {
          if (challenged) return
          buf += chunk.toString('utf8')
          const nl = buf.indexOf('\n')
          if (nl < 0) return
          challenged = true
          const msg = JSON.parse(buf.slice(0, nl)) as { challenge: string }
          const token = readHostAdminChallengeFile(adminDir, msg.challenge)
          s.write(`${JSON.stringify({ challenge: token, method: 'status' })}\n`)
          s.once('close', () => resolve({ file: msg.challenge, token }))
        })
      })
      expect(existsSync(join(adminDir, captured.file))).toBe(false)
      const replayReplies = await sendRawFrames(sockPath, [
        JSON.stringify({ version: 1, client: id }),
        JSON.stringify({ challenge: captured.token, method: 'status' })
      ])
      expect(JSON.parse(replayReplies[1]!)).toEqual({ ok: false, error: 'host_admin_auth_failed' })

      // 4. Client challenge reader rejects symlink, non-0600 mode, wrong owner, and invalid filename.
      const checkDir = mkdtempSync(join(tmpdir(), 'scry-chal-check-'))
      extraDirs.push(checkDir)
      const validName = `challenge-${'a'.repeat(32)}`
      const target = join(checkDir, 'real-target')
      writeFileSync(target, 'b'.repeat(64), { mode: 0o600 })
      symlinkSync(target, join(checkDir, validName))
      expect(() => readHostAdminChallengeFile(checkDir, validName)).toThrow(/host_admin_challenge/)

      const looseName = `challenge-${'c'.repeat(32)}`
      writeFileSync(join(checkDir, looseName), 'd'.repeat(64), { mode: 0o644 })
      chmodSync(join(checkDir, looseName), 0o644)
      expect(() => readHostAdminChallengeFile(checkDir, looseName)).toThrow('host_admin_challenge_mode')

      const ownerName = `challenge-${'e'.repeat(32)}`
      writeFileSync(join(checkDir, ownerName), 'f'.repeat(64), { mode: 0o600 })
      expect(() => readHostAdminChallengeFile(checkDir, ownerName, { expectedUid: (process.getuid?.() ?? 0) + 1 })).toThrow('host_admin_challenge_owner')
      expect(() => readHostAdminChallengeFile(checkDir, '../escape')).toThrow('host_admin_challenge_invalid')
    } finally {
      await daemon.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
    }
  }, 30_000)

  it('enforces switch-off read/tighten-only, whitelist, rate limits, machine codes, approvedVia:host_cli, notices & no secret in logs', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
    process.env.SCRY_REMOTE_HOST = '1'
    const logs: string[] = []
    const daemon = await startTestDaemon({ root: makeShortRoot(), log: (line) => logs.push(line) })
    let restarted: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    try {
      const id = buildIdentity('test')
      const stateDir = join(daemon.userDataDir, 'daemon')
      const call = (method: string, args?: Record<string, unknown>) =>
        callHostAdmin({ daemonStateDirectory: stateDir, clientIdentity: id, method, ...(args ? { args } : {}) })

      // 1. Switch OFF: status/pending/devices work; invite/approve refused; whitelist enforced.
      const st = await call('status')
      expect(st).toMatchObject({
        ok: true,
        result: {
          cliApproval: { enabled: false },
          pairingCapacity: { limit: 64 }
        }
      })
      expect(await call('pending')).toMatchObject({ ok: true, result: { pending: [] } })
      expect(await call('devices')).toMatchObject({ ok: true, result: { devices: [] } })
      expect(await call('invite_phone')).toEqual({ ok: false, error: 'host_cli_approval_disabled' })
      expect(await call('invite_desktop')).toEqual({ ok: false, error: 'host_cli_approval_disabled' })
      expect(await call('approve', { pairingId: '00000000-0000-4000-8000-000000000000', publicKeySHA256: 'a'.repeat(64) })).toEqual({
        ok: false, error: 'host_cli_approval_disabled'
      })
      // Forbidden methods outside whitelist -> unsupported_method.
      for (const badMethod of ['setCliApproval', 'localHostAdmin', 'submit', 'enroll', 'stop', 'unknown_op']) {
        expect(await call(badMethod)).toEqual({ ok: false, error: 'unsupported_method' })
      }

      // 2. Switch OFF tightening still works (cancel, revoke, desktop_off) & maps Chinese errors to machine codes.
      const localGrant = daemon.host.service.authority.inspectLocal().grants.find((g) => g.scope === 'local')!
      expect(await call('revoke', { deviceId: localGrant.deviceId })).toEqual({ ok: false, error: 'local_grant_not_revocable' })
      expect(await call('cancel', { pairingId: 'not-a-uuid' })).toEqual({ ok: false, error: 'invalid_arguments' })
      expect(await call('desktop_off')).toEqual({ ok: true, result: { disabled: true } })
      expect(daemon.host.hostAdmin.recentNotices().some((n) => n.kind === 'desktop_disabled_via_cli')).toBe(true)

      // 3. Turn switch ON via local op -> full flow: invite -> prove -> wrong fp refused -> right fp approved with approvedVia:host_cli + notice.
      expect((await daemon.localOp('localHostAdmin', 'setCliApproval', [true])).error).toBeUndefined()
      const inv = await call('invite_phone')
      expect(inv.ok).toBe(true)
      const inviteData = (inv as { ok: true; result: { pairingId: string; secret: string } }).result
      const { publicKeySHA256 } = await createProvedPairing(daemon, inviteData.pairingId, inviteData.secret, 'CLI Phone')

      const wrong = await call('approve', { pairingId: inviteData.pairingId, publicKeySHA256: '0'.repeat(64) })
      expect(wrong).toEqual({ ok: false, error: 'local_confirmation_mismatch' })

      const okApprove = await call('approve', { pairingId: inviteData.pairingId, publicKeySHA256 })
      expect(okApprove.ok).toBe(true)
      const approvedDevice = (okApprove as { ok: true; result: { deviceId: string; approvedVia?: string } }).result
      expect(approvedDevice.approvedVia).toBe('host_cli')

      const persistedGrant = daemon.host.service.authority.inspectLocal().grants.find((g) => g.deviceId === approvedDevice.deviceId)
      expect(persistedGrant?.approvedVia).toBe('host_cli')
      expect(daemon.host.hostAdmin.recentNotices().some((n) => n.kind === 'device_approved_via_cli' && n.deviceId === approvedDevice.deviceId)).toBe(true)

      // Logs must NEVER contain the pairing secret!
      expect(logs.join('\n')).not.toContain(inviteData.secret)

      // 4. Rate limit on approve (3/h; we already used 2 above -> 3rd attempt allowed, 4th rate-limited even after restart).
      const inv2 = await call('invite_phone')
      expect(inv2.ok).toBe(true)
      const inv2Data = (inv2 as { ok: true; result: { pairingId: string; secret: string } }).result
      await createProvedPairing(daemon, inv2Data.pairingId, inv2Data.secret, 'Phone 2')
      // 3rd approve call hits wrong fp (consumes 3rd slot); 4th is rate-limited!
      expect(await call('approve', { pairingId: inv2Data.pairingId, publicKeySHA256: '1'.repeat(64) })).toEqual({
        ok: false, error: 'local_confirmation_mismatch'
      })
      const rateLimited = await call('approve', { pairingId: inv2Data.pairingId, publicKeySHA256: '2'.repeat(64) })
      expect(rateLimited).toMatchObject({ ok: false, error: 'host_cli_rate_limited', retryAfterMs: expect.any(Number) })

      // Restart preserves rate limit counter in host-admin.json.
      await daemon.dispose()
      restarted = await startTestDaemon({ root: daemon.root })
      const afterRestart = await callHostAdmin({
        daemonStateDirectory: join(restarted.userDataDir, 'daemon'),
        clientIdentity: id,
        method: 'approve',
        args: { pairingId: inv2Data.pairingId, publicKeySHA256: '2'.repeat(64) }
      })
      expect(afterRestart).toMatchObject({ ok: false, error: 'host_cli_rate_limited' })
    } finally {
      await daemon.dispose()
      await restarted?.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
    }
  }, 45_000)
})
