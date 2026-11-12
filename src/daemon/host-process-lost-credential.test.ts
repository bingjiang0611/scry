import 'reflect-metadata'
import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestDaemon, type TestDaemon } from './host-process.harness'
import { cleanupTempDirs } from './host-process.fixtures'
import { requestLocalEnrollment } from './local-enrollment-request'
import { createLazyDaemonRunSurface } from '../main/bootstrap/daemon-run-lazy'
import type { DaemonRunModeDeps } from '../main/bootstrap/daemon-run-mode'
import { connectionFromMode } from '../main/background-service-status'
import { reconnectBackgroundService, restartBackgroundService, type BackgroundServiceActionDeps } from '../main/background-service-actions'
import { DaemonClient, daemonClientPaths } from '../main/daemon-client'

// A6 against a real daemon: the App was connected, quit (the daemon stayed), and its
// stored credential `<userData>/daemon-client.json` was deleted. The daemon writes no
// enrollment secret while the grant it issued to that credential is live, so the App
// must not wait for a launch that cannot help (it reported daemon_ready_timeout): it is
// the reconnect state, and only the confirmed 「重新连接本机后台服务」 gets it back.

const encrypt = (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8')
const decrypt = (value: Buffer) => value.toString('utf8').split('').reverse().join('')

const daemons: TestDaemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.dispose()
  delete process.env.SCRY_HOST_DAEMON
  cleanupTempDirs()
})

async function connectedThenQuit(daemon: TestDaemon) {
  const stateDirectory = join(daemon.userDataDir, 'daemon')
  const paths = daemonClientPaths(stateDirectory, daemon.userDataDir)
  const app = new DaemonClient({ paths, appVersion: 'test', encrypt, decrypt })
  await expect(app.connect()).resolves.toMatchObject({ version: 'test', enrolled: true })
  app.close()
  return { stateDirectory, paths }
}

function lazyApp(daemon: TestDaemon, launch: NonNullable<DaemonRunModeDeps['launch']>) {
  return createLazyDaemonRunSurface({
    userDataDir: daemon.userDataDir,
    daemonStateDirectory: join(daemon.userDataDir, 'daemon'),
    appVersion: 'test',
    credentialCipher: () => ({ ok: true, encrypt, decrypt }),
    send: () => undefined,
    currentCwd: () => daemon.workspace,
    launch
  })
}

describe('an App that lost its stored grant, facing a live daemon (A6)', () => {
  it('shows the reconnect state without launching or waiting, and the stored grant is the control', async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    process.env.SCRY_HOST_DAEMON = '1'
    const { paths } = await connectedThenQuit(daemon)
    const launch = vi.fn(async () => ({ status: 'started' as const }))

    // Control: with its credential the App adopts the daemon as before.
    const kept = lazyApp(daemon, launch)
    try {
      await expect(kept.activeRuns()).resolves.toEqual([])
    } finally { kept.dispose() }

    await rm(paths.statePath)
    const lost = lazyApp(daemon, launch)
    try {
      const started = Date.now()
      const result = await lost.ready()
      expect(result).toMatchObject({ status: 'device-not-authorized', reason: 'daemon_enrollment_unavailable' })
      expect(connectionFromMode(result, 'test')).toEqual({ state: 'device-not-authorized' })
      // Well inside the 10 s ready timeout it used to run out.
      expect(Date.now() - started).toBeLessThan(5_000)
      await expect(lost.activeRuns()).rejects.toThrow('daemon_device_not_authorized')
      expect(launch).not.toHaveBeenCalled()
    } finally { lost.dispose() }
  }, 60_000)

  it('reconnects only through the confirmed chain: stop, request a secret, start, enroll', async () => {
    const first = await startTestDaemon()
    daemons.push(first)
    process.env.SCRY_HOST_DAEMON = '1'
    const { stateDirectory, paths } = await connectedThenQuit(first)
    await rm(paths.statePath)
    let second: TestDaemon | undefined
    // Stands in for the supervisor: a new daemon on the same userData, as a restart is.
    const launch = vi.fn(async () => {
      second = await startTestDaemon({ root: first.root })
      daemons.push(second)
      return { status: 'started' as const }
    })
    const app = lazyApp(first, launch)
    const holder = { pid: 4242, startedAt: 's', identityKey: '4242:s', startedBy: 'test' }
    const confirmations: string[] = []
    const deps: BackgroundServiceActionDeps = {
      daemonMode: true,
      connection: async () => connectionFromMode(await app.ready(), 'test'),
      activeRuns: async () => undefined,
      // The in-process daemon holds no daemon.lock; the identity checks before the one
      // SIGTERM are background-service-stop.test.ts's. Here the stop is the dispose.
      prepareStop: async () => ({ status: 'running', holder }),
      stop: async () => { await first.dispose(); return { status: 'stopped', holder, leftovers: [] } },
      confirm: async (action) => { confirmations.push(action); return true },
      holdLaunches: () => app.holdLaunches(),
      reconnect: async () => connectionFromMode(await app.restart(), 'test'),
      discardLocalCredential: () => rm(paths.statePath, { force: true }),
      requestLocalEnrollment: () => requestLocalEnrollment(stateDirectory),
      hasLocalCredential: () => access(paths.statePath).then(() => true, () => false),
      reportLeftovers: async () => undefined,
      quitApp: () => undefined
    }
    try {
      await expect(app.ready()).resolves.toMatchObject({ status: 'device-not-authorized' })
      expect(launch).not.toHaveBeenCalled()
      await expect(reconnectBackgroundService(deps)).resolves.toEqual({ status: 'done' })
      expect(confirmations).toEqual(['reconnect'])
      expect(launch).toHaveBeenCalledTimes(1)
      await expect(app.activeRuns()).resolves.toEqual([])
      // One local grant stays active: the new enrollment revoked the one the lost
      // credential held (and the fixture's own).
      const local = second!.host.service.controller.authority.inspectLocal().grants.filter((grant) => grant.scope === 'local' && grant.revokedAt === null)
      expect(local).toHaveLength(1)
    } finally { app.dispose() }
  }, 60_000)

  it('recovers with 「重启后台服务」 alone when the App holds no credential (maintainer 2026-11-12)', async () => {
    const first = await startTestDaemon()
    daemons.push(first)
    process.env.SCRY_HOST_DAEMON = '1'
    const { stateDirectory, paths } = await connectedThenQuit(first)
    await rm(paths.statePath)
    let second: TestDaemon | undefined
    const launch = vi.fn(async () => {
      second = await startTestDaemon({ root: first.root })
      daemons.push(second)
      return { status: 'started' as const }
    })
    const app = lazyApp(first, launch)
    const holder = { pid: 4242, startedAt: 's', identityKey: '4242:s', startedBy: 'test' }
    const confirmations: string[] = []
    const deps: BackgroundServiceActionDeps = {
      daemonMode: true,
      connection: async () => connectionFromMode(await app.ready(), 'test'),
      activeRuns: async () => undefined,
      prepareStop: async () => ({ status: 'running', holder }),
      stop: async () => { await first.dispose(); return { status: 'stopped', holder, leftovers: [] } },
      confirm: async (action) => { confirmations.push(action); return true },
      holdLaunches: () => app.holdLaunches(),
      reconnect: async () => connectionFromMode(await app.restart(), 'test'),
      discardLocalCredential: () => rm(paths.statePath, { force: true }),
      requestLocalEnrollment: () => requestLocalEnrollment(stateDirectory),
      hasLocalCredential: () => access(paths.statePath).then(() => true, () => false),
      reportLeftovers: async () => undefined,
      quitApp: () => undefined
    }
    try {
      await expect(app.ready()).resolves.toMatchObject({ status: 'device-not-authorized' })
      // Runs unknown without a grant: the restart is confirmed, then one step recovers.
      await expect(restartBackgroundService(deps)).resolves.toEqual({ status: 'done' })
      expect(confirmations).toEqual(['restart'])
      expect(launch).toHaveBeenCalledTimes(1)
      await expect(app.activeRuns()).resolves.toEqual([])
      const local = second!.host.service.controller.authority.inspectLocal().grants.filter((grant) => grant.scope === 'local' && grant.revokedAt === null)
      expect(local).toHaveLength(1)
    } finally { app.dispose() }
  }, 60_000)

  it('does not issue a secret on restart without the request (control)', async () => {
    const first = await startTestDaemon()
    daemons.push(first)
    const { paths } = await connectedThenQuit(first)
    await rm(paths.statePath)
    await first.dispose()
    const second = await startTestDaemon({ root: first.root })
    daemons.push(second)
    const app = new DaemonClient({ paths, appVersion: 'test', encrypt, decrypt })
    await expect(app.connect()).rejects.toMatchObject({ reason: 'daemon_enrollment_unavailable' })
  }, 60_000)
})
