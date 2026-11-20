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
        activeRuns: 0,
        remoteConfig: {
          remoteHostEnabled: false,
          relayMode: 'disabled',
          permissionModeOverride: null,
          disabledProviders: [],
          runControlsEnabled: true,
          providerManifestUrl: null
        },
        ...(process.env.SCRY_ORCHESTRATION === 'on'
          ? { orchestration: { mode: 'on', h1FallbackUnavailable: false } }
          : {})
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

  it('self-reports launchedBy, supervisorPid, and effective non-secret remote policy', async () => {
    const keys = [
      'SCRY_REMOTE_HOST', 'SCRY_REMOTE_PERMISSION_MODE', 'SCRY_DISABLED_PROVIDERS',
      'SCRY_RUN_CONTROLS', 'SCRY_DAEMON_LAUNCHED_BY', 'SCRY_DAEMON_STARTED_BY'
    ] as const
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    process.env.SCRY_REMOTE_HOST = '1'
    process.env.SCRY_REMOTE_PERMISSION_MODE = 'auto_review'
    process.env.SCRY_DISABLED_PROVIDERS = 'pi, codex'
    process.env.SCRY_RUN_CONTROLS = '0'
    process.env.SCRY_DAEMON_LAUNCHED_BY = 'service'
    process.env.SCRY_DAEMON_STARTED_BY = 'supervisor:43210'
    const daemon = await startTestDaemon()
    try {
      const reply = await daemon.localOp('localBackgroundService', 'status', [])
      expect(reply.error).toBeUndefined()
      expect(reply.result).toMatchObject({
        launchedBy: 'service',
        supervisorPid: 43210,
        remoteConfig: {
          remoteHostEnabled: true,
          relayMode: 'disabled',
          permissionModeOverride: 'auto_review',
          disabledProviders: ['codex', 'pi'],
          runControlsEnabled: false,
          providerManifestUrl: null
        }
      })
    } finally {
      await daemon.dispose()
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }, 30_000)

  it('gates localHostAdmin:setCliApproval behind SCRY_EXPERIMENTAL_HOST_CLI=1 and persists 0600 host-admin.json (P5-5b)', async () => {
    const saved = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const offDaemon = await startTestDaemon()
    let onDaemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    try {
      // Flag off: status omits cliApproval, localHostAdmin refuses.
      const offStatus = await offDaemon.localOp('localBackgroundService', 'status', [])
      expect('cliApproval' in (offStatus.result as Record<string, unknown>)).toBe(false)
      expect((await offDaemon.localOp('localHostAdmin', 'setCliApproval', [true])).error).toBe('host_cli_experimental_disabled')
      await offDaemon.dispose()

      // Flag on: status includes cliApproval, setCliApproval persists to host-admin.json.
      process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
      onDaemon = await startTestDaemon({ root: offDaemon.root })
      expect((await onDaemon.localOp('localBackgroundService', 'status', [])).result).toMatchObject({
        cliApproval: { enabled: false, updatedAt: null }
      })
      expect((await onDaemon.localOp('localHostAdmin', 'setCliApproval', ['yes'])).error).toBe('invalid_request')
      const toggled = await onDaemon.localOp('localHostAdmin', 'setCliApproval', [true])
      expect(toggled.error).toBeUndefined()
      expect(toggled.result).toMatchObject({ enabled: true })
      expect(onDaemon.host.hostAdmin.isCliApprovalEnabled()).toBe(true)
      expect((await onDaemon.localOp('localBackgroundService', 'status', [])).result).toMatchObject({
        cliApproval: { enabled: true }
      })
    } finally {
      await offDaemon.dispose()
      await onDaemon?.dispose()
      if (saved === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = saved
    }
  }, 30_000)
})
