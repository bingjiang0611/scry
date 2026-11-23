import 'reflect-metadata'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIdentity } from '../shared/build-identity'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import { processIdentityKey, type ProcessRow } from '../main/process-diagnostics'
import { createLoginStartManager, loginStartTargetFromBundle } from './login-start'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { runHostCli, type HostCliIo } from './host-cli'
import { defaultHostUserDataDir, resolveHostCliTarget } from './host-cli-paths'

const extraDirs: string[] = []
function makeShortRoot(): string {
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  const dir = mkdtempSync(join(base, 'scry-hc-'))
  extraDirs.push(dir)
  return dir
}

afterEach(() => {
  cleanupTempDirs()
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeIo(overrides: Partial<HostCliIo> & { answers?: string[] } = {}) {
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const queue = [...(overrides.answers ?? [])]
  const io: HostCliIo = {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    prompt: async () => queue.shift() ?? '',
    env: { ...process.env },
    platform: process.platform,
    homeDir: tmpdir(),
    clientIdentity: buildIdentity('test'),
    ...overrides
  }
  return { io, out: () => stdoutLines.join(''), err: () => stderrLines.join('') }
}

describe('W11 P5-6: scry-host CLI commands, security gates, restart & login-start', () => {
  it('derives default userDataDir & bundle layout byte-for-byte identical to main login-start', () => {
    expect(defaultHostUserDataDir('darwin', '/Users/alice', {})).toBe('/Users/alice/Library/Application Support/Scry')
    expect(defaultHostUserDataDir('linux', '/home/alice', {})).toBe('/home/alice/.config/Scry')
    expect(defaultHostUserDataDir('linux', '/home/alice', { XDG_CONFIG_HOME: '/srv/xdg' })).toBe('/srv/xdg/Scry')

    const macBundle = resolveHostCliTarget({
      executable: '/Applications/Scry.app/Contents/MacOS/Scry',
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: {}
    })
    expect(macBundle).toEqual(loginStartTargetFromBundle(
      '/Applications/Scry.app/Contents/MacOS/Scry',
      '/Users/alice/Library/Application Support/Scry',
      'darwin'
    ))
  })

  it('refuses invite/approve with exit 4 when SCRY_EXPERIMENTAL_HOST_CLI is off, and exit 2 without creating daemon.lock when daemon is not running', async () => {
    const root = makeShortRoot()
    const userDataDir = join(root, 'userData')
    mkdirSync(userDataDir, { recursive: true })

    const offInv = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '0' } })
    expect(await runHostCli(['invite', 'phone'], offInv.io)).toBe(4)
    expect(offInv.err()).toContain('SCRY_EXPERIMENTAL_HOST_CLI')

    const offApp = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '0' } })
    expect(await runHostCli(['approve'], offApp.io)).toBe(4)

    const notRunning = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' } })
    expect(await runHostCli(['status'], notRunning.io)).toBe(2)
    expect(existsSync(join(userDataDir, 'daemon', 'daemon.lock'))).toBe(false)
  })

  it('refuses non-TTY (piped) invite/approve and refuses inside SCRY_HOST_CHILD / SCRY_MANAGED_RUN_ID', async () => {
    const root = makeShortRoot()
    const userDataDir = join(root, 'userData')

    const pipedInv = makeIo({ userDataDir, stdinIsTTY: false, stdoutIsTTY: false, env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' } })
    expect(await runHostCli(['invite', 'phone'], pipedInv.io)).toBe(1)
    expect(pipedInv.err()).toContain('host_cli_requires_tty')

    const pipedApp = makeIo({ userDataDir, stdinIsTTY: false, stdoutIsTTY: true, env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' } })
    expect(await runHostCli(['approve'], pipedApp.io)).toBe(1)
    expect(pipedApp.err()).toContain('host_cli_requires_tty')

    const badFlag = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' } })
    expect(await runHostCli(['approve', '--yes'], badFlag.io)).toBe(1)
    const badFpFlag = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' } })
    expect(await runHostCli(['approve', '--fingerprint', 'a'.repeat(64)], badFpFlag.io)).toBe(1)

    for (const markerEnv of [
      { SCRY_EXPERIMENTAL_HOST_CLI: '1', SCRY_HOST_CHILD: 'run' },
      { SCRY_EXPERIMENTAL_HOST_CLI: '1', SCRY_HOST_CHILD: 'terminal' },
      { SCRY_EXPERIMENTAL_HOST_CLI: '1', SCRY_MANAGED_RUN_ID: 'run-123' }
    ]) {
      for (const cmd of [['invite', 'phone'], ['approve'], ['login-start', 'enable']]) {
        const res = makeIo({ userDataDir, env: markerEnv })
        expect(await runHostCli(cmd, res.io)).toBe(1)
        expect(res.err()).toContain('host_cli_inside_agent')
      }
    }
  })

  it('runs interactive invite, status (with pairing counts), fingerprint validation (<16 rejected), approve (approvedVia:host_cli), devices & revoke', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
    process.env.SCRY_REMOTE_HOST = '1'
    const daemon = await startTestDaemon({ root: makeShortRoot() })
    try {
      const env = { ...process.env, SCRY_EXPERIMENTAL_HOST_CLI: '1' }
      expect((await daemon.localOp('localHostAdmin', 'setCliApproval', [true])).error).toBeUndefined()

      const st = makeIo({ userDataDir: daemon.userDataDir, env })
      expect(await runHostCli(['status', '--json'], st.io)).toBe(0)
      const stJson = JSON.parse(st.out()) as { pairingCapacity: { pairings: number; grants: number; limit: number }; cliApproval: { enabled: boolean } }
      expect(stJson.cliApproval.enabled).toBe(true)
      expect(stJson.pairingCapacity.limit).toBe(64)
      expect(stJson.pairingCapacity.grants).toBeGreaterThanOrEqual(1)

      const invJsonRefused = makeIo({ userDataDir: daemon.userDataDir, env })
      expect(await runHostCli(['invite', 'phone', '--json'], invJsonRefused.io)).toBe(1)

      const inv = makeIo({ userDataDir: daemon.userDataDir, env })
      expect(await runHostCli(['invite', 'phone'], inv.io)).toBe(0)
      const pendingBefore = daemon.host.service.authority.inspectLocal().pairings.find((p) => p.state === 'created')!
      expect(pendingBefore).toBeDefined()
      const secretMatch = inv.out().match(/([A-Za-z0-9_-]{43})/)
      expect(secretMatch).toBeTruthy()
      const secret = secretMatch![1]!

      const dev = await generateDesktopDeviceIdentity()
      await daemon.host.service.authority.prove(
        { pairingId: pendingBefore.pairingId, secret, csrPEM: dev.csrPEM, deviceLabel: 'CLI Approved iPhone' },
        dev.publicKeySHA256
      )

      const shortFp = makeIo({
        userDataDir: daemon.userDataDir,
        env,
        answers: [dev.publicKeySHA256.slice(0, 12)]
      })
      expect(await runHostCli(['approve'], shortFp.io)).toBe(1)
      expect(shortFp.err()).toMatch(/16/)

      const cancelApprove = makeIo({
        userDataDir: daemon.userDataDir,
        env,
        answers: [dev.publicKeySHA256.slice(0, 16), 'no']
      })
      expect(await runHostCli(['approve'], cancelApprove.io)).toBe(5)

      const groupedPrefix = dev.publicKeySHA256.slice(0, 16).replace(/(.{4})/g, '$1 ').trim().toUpperCase()
      const okApprove = makeIo({
        userDataDir: daemon.userDataDir,
        env,
        answers: [groupedPrefix, 'yes']
      })
      expect(await runHostCli(['approve'], okApprove.io)).toBe(0)

      const devs = makeIo({ userDataDir: daemon.userDataDir, env })
      expect(await runHostCli(['devices'], devs.io)).toBe(0)
      expect(devs.out()).toContain('CLI Approved iPhone')
      expect(devs.out()).toContain('命令行')

      const approved = daemon.host.service.authority.inspectLocal().grants.find((g) => g.publicKeySHA256 === dev.publicKeySHA256)!
      expect(approved.approvedVia).toBe('host_cli')
      const badRevoke = makeIo({ userDataDir: daemon.userDataDir, env })
      expect(await runHostCli(['revoke', approved.deviceId.slice(0, 8), '--yes'], badRevoke.io)).toBe(1)

      const okRevoke = makeIo({ userDataDir: daemon.userDataDir, env })
      expect(await runHostCli(['revoke', approved.deviceId, '--yes'], okRevoke.io)).toBe(0)
      expect(daemon.host.service.authority.inspectLocal().grants.find((g) => g.deviceId === approved.deviceId)?.revokedAt).not.toBeNull()
    } finally {
      await daemon.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
    }
  }, 30_000)

  it('restart sends exactly one SIGTERM after identity check and starts via service when installed', async () => {
    const root = makeShortRoot()
    const userDataDir = join(root, 'userData')
    const stateDir = join(userDataDir, 'daemon')
    mkdirSync(stateDir, { recursive: true })
    const row: ProcessRow = {
      pid: 54321,
      ppid: 1,
      status: 'S',
      startedAt: 'Fri Nov 20 10:00:00 2026',
      command: '/Applications/Scry.app/Contents/MacOS/Scry out/main/daemon.js'
    }
    const holder = {
      pid: row.pid,
      startedAt: row.startedAt,
      identityKey: processIdentityKey(row),
      startedBy: 'supervisor:1000'
    }
    writeFileSync(join(stateDir, 'daemon.lock'), JSON.stringify(holder))

    const signals: Array<{ pid: number; signal: string }> = []
    let alive = true
    const startViaService = vi.fn(async () => ({ ok: true as const }))
    const loginStart = {
      ...createLoginStartManager({
        
        target: loginStartTargetFromBundle('/Applications/Scry.app/Contents/MacOS/Scry', userDataDir, 'darwin'),
        platform: 'darwin',
        homeDir: root,
        env: {}
      }),
      canLaunchViaService: () => true,
      startViaService
    }

    const res = makeIo({
      userDataDir,
      answers: ['yes'],
      loginStart,
      stopDeps: {
        paths: { stateDirectory: stateDir, userDataDir },
        readIdentity: async (pid) => (pid === 54321 && alive) ? row : undefined,
        signal: (pid, sig) => { signals.push({ pid, signal: sig }); alive = false },
        exists: async () => false,
        pollMs: 5
      }
    })
    expect(await runHostCli(['restart'], res.io)).toBe(0)
    expect(signals).toEqual([{ pid: 54321, signal: 'SIGTERM' }])
    expect(startViaService).toHaveBeenCalledTimes(1)
  })

  it('build/scry-host wrapper exists, clears §2.1 env vars, and launches out/main/host-cli.js', () => {
    const wrapper = readFileSync(join(process.cwd(), 'build', 'scry-host'), 'utf8')
    expect(wrapper).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(wrapper).toContain('out/main/host-cli.js')
    for (const v of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) {
      expect(wrapper).toContain(v)
    }
  })

  it('reports feature disabled (not daemon_not_running) when daemon holds daemon.lock with flag off and strips C0/C1 control chars in deviceLabel (W11 review #7 + small items)', async () => {
    const root = makeShortRoot()
    const userDataDir = join(root, 'userData')
    const stateDir = join(userDataDir, 'daemon')
    mkdirSync(stateDir, { recursive: true })
    const row: ProcessRow = {
      pid: 65432,
      ppid: 1,
      status: 'S',
      startedAt: 'Fri Nov 20 11:00:00 2026',
      command: '/Applications/Scry.app/Contents/MacOS/Scry out/main/daemon.js'
    }
    writeFileSync(join(stateDir, 'daemon.lock'), JSON.stringify({
      pid: row.pid,
      startedAt: row.startedAt,
      identityKey: processIdentityKey(row)
    }))

    const stopDeps = {
      paths: { stateDirectory: stateDir, userDataDir },
      readIdentity: async (pid: number) => (pid === 65432 ? row : undefined)
    }

    const stText = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '0' }, stopDeps })
    expect(await runHostCli(['status'], stText.io)).toBe(4)
    expect(stText.err()).toContain('功能未开启')
    expect(stText.err()).not.toContain('后台服务未运行')

    const stJson = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '0' }, stopDeps })
    expect(await runHostCli(['status', '--json'], stJson.io)).toBe(4)
    expect(JSON.parse(stJson.out())).toMatchObject({
      daemon: { running: true, pid: 65432 },
      hostCliEnabled: false,
      error: 'host_cli_experimental_disabled'
    })

    const stFlagOn = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' }, stopDeps })
    expect(await runHostCli(['status'], stFlagOn.io)).toBe(4)
    expect(stFlagOn.err()).toContain('daemon.log')
    expect(stFlagOn.err()).toContain('host-admin.disabled')
    expect(stFlagOn.err()).not.toContain('后台服务未运行')

    const stFlagOnJson = makeIo({ userDataDir, env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' }, stopDeps })
    expect(await runHostCli(['status', '--json'], stFlagOnJson.io)).toBe(4)
    expect(JSON.parse(stFlagOnJson.out())).toMatchObject({
      daemon: { running: true, pid: 65432 },
      hostCliEnabled: false,
      error: 'host_admin_socket_unavailable',
      daemonLogPath: join(userDataDir, 'logs', 'daemon.log')
    })

    const { formatDeviceList, formatPendingList } = await import('./host-cli-format')
    const dirtyLabel = 'Phone\x1b[31mRed\u009b2J\r\nFake'
    const devText = formatDeviceList([{
      deviceId: '11111111-1111-4111-8111-111111111111',
      deviceLabel: dirtyLabel,
      confirmedAt: 1,
      expiresAt: 2,
      revoked: false,
      approvedVia: 'host_cli'
    }])
    expect(devText).not.toMatch(/[\u0000-\u001f\u007f-\u009f](?!$)/)
    expect(devText).not.toContain('\x1b')
    expect(devText).not.toContain('\u009b')
    expect(devText.trim().split('\n')).toHaveLength(1)

    const pendText = formatPendingList([{
      pairingId: '22222222-2222-4222-8222-222222222222',
      state: 'awaiting_local_confirmation',
      expiresAt: Date.now() + 60_000,
      deviceLabel: dirtyLabel,
      publicKeySHA256: 'a'.repeat(64)
    }], Date.now())
    expect(pendText).not.toContain('\x1b')
    expect(pendText).not.toContain('\u009b')
  })
})
