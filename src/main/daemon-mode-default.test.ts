import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAppStartupGuards, assertIsolatedTestUserData, isDefaultAppUserDataDir, retiredDaemonModeWarning } from './daemon-mode-default'
import { createLoginStartManager, resolveLoginStartOverrides } from '../daemon/login-start'

const electronMock = vi.hoisted(() => ({
  userData: '/tmp/scry-w15-isolated-userdata',
  appData: '/tmp/scry-w15-appdata',
  appName: 'scry',
  appPath: '/tmp/scry-w15-checkout',
  isPackaged: false
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'appData' ? electronMock.appData : electronMock.userData),
    getName: () => electronMock.appName,
    getVersion: () => '0.2.250',
    getAppPath: () => electronMock.appPath,
    get isPackaged() { return electronMock.isPackaged }
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { appDaemonModeDeps, createDaemonRunMode } = await import('./bootstrap/daemon-run-mode')
const { createAppLoginStartManager } = await import('./bootstrap/background-service')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the retired in-process switch (S3)', () => {
  it('needs no SCRY_HOST_DAEMON at all and says nothing when it is unset or 1', () => {
    for (const env of [{}, { SCRY_HOST_DAEMON: '1' }, { SCRY_TEST_APP: '1' }] as NodeJS.ProcessEnv[]) {
      const warn = vi.fn()
      applyAppStartupGuards(env, undefined, warn)
      expect(warn).not.toHaveBeenCalled()
      expect(retiredDaemonModeWarning(env)).toBeUndefined()
    }
  })

  it('ignores an explicit SCRY_HOST_DAEMON=0 with one warning line instead of crashing', () => {
    for (const env of [{ SCRY_HOST_DAEMON: '0' }, { SCRY_HOST_DAEMON: '0', SCRY_TEST_APP: '1' }, { SCRY_HOST_DAEMON: 'off' }] as NodeJS.ProcessEnv[]) {
      const before = { ...env }
      const warn = vi.fn()
      expect(() => applyAppStartupGuards(env, undefined, warn)).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
      const [line] = warn.mock.calls[0] as [string]
      expect(line).toContain('SCRY_HOST_DAEMON')
      expect(line).toContain('ignored')
      expect(line.includes('\n')).toBe(false)
      // Nothing reads the variable any more, so nothing is rewritten either.
      expect(env).toEqual(before)
    }
    expect(retiredDaemonModeWarning({ SCRY_HOST_DAEMON: 'x'.repeat(500) })!.length).toBeLessThan(200)
  })
})

describe('SCRY_TEST_APP=1 fail-closed isolation (W15 S3)', () => {
  it('refuses default appData/<name> userData at startup when SCRY_TEST_APP=1 (fail closed)', () => {
    const macAppData = '/Users/tester/Library/Application Support'
    expect(isDefaultAppUserDataDir({
      userDataDir: join(macAppData, 'Scry'),
      appDataDir: macAppData,
      appName: 'scry',
      platform: 'darwin'
    })).toBe(true)

    // Both unset and explicit SCRY_HOST_DAEMON=1 must refuse default userData under SCRY_TEST_APP=1.
    for (const env of [{ SCRY_TEST_APP: '1' }, { SCRY_TEST_APP: '1', SCRY_HOST_DAEMON: '1' }] as NodeJS.ProcessEnv[]) {
      expect(() => applyAppStartupGuards(env, {
        userDataDir: join(macAppData, 'scry'),
        appDataDir: macAppData,
        appName: 'scry',
        platform: 'darwin'
      })).toThrow(/test_app_requires_isolated_user_data/)
    }

    // Normal non-test builds are allowed to use default appData/<name>.
    const normalDev: NodeJS.ProcessEnv = {}
    expect(() => applyAppStartupGuards(normalDev, {
      userDataDir: join(macAppData, 'scry'),
      appDataDir: macAppData,
      appName: 'scry',
      platform: 'darwin'
    })).not.toThrow()

    // Isolated temp userData passes under SCRY_TEST_APP=1.
    expect(() => assertIsolatedTestUserData({ SCRY_TEST_APP: '1' }, {
      userDataDir: '/tmp/scry-isolated-123/userData',
      appDataDir: macAppData,
      appName: 'scry',
      platform: 'darwin'
    })).not.toThrow()
  })

  it('refuses createDaemonRunMode on default userData and wires isolated paths through appDaemonModeDeps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-w15-s3-'))
    dirs.push(root)
    const fakeAppData = join(root, 'Application Support')
    const defaultUserData = join(fakeAppData, 'scry')
    const isolatedUserData = join(root, 'isolated-userData')

    // 1. Default userData under SCRY_TEST_APP=1 -> createDaemonRunMode refuses before touching socket or launch.
    electronMock.appData = fakeAppData
    electronMock.appName = 'scry'
    electronMock.userData = defaultUserData
    const launch = vi.fn(async () => ({ status: 'started' as const }))
    const refusedDeps = appDaemonModeDeps({
      send: () => undefined,
      currentCwd: () => undefined,
      env: { SCRY_TEST_APP: '1', SCRY_HOST_DAEMON: '1' }
    })
    const refused = await createDaemonRunMode({ ...refusedDeps, launch })
    expect(refused).toEqual({ status: 'unavailable', reason: 'test_app_requires_isolated_user_data' })
    expect(launch).not.toHaveBeenCalled()

    // 2. Isolated userData under SCRY_TEST_APP=1 -> App assembly itself resolves isolated paths & disables daily login-start.
    electronMock.userData = isolatedUserData
    const isolatedDeps = appDaemonModeDeps({
      send: () => undefined,
      currentCwd: () => undefined,
      env: { SCRY_TEST_APP: '1', SCRY_HOST_DAEMON: '1' }
    })
    expect(isolatedDeps.userDataDir).toBe(isolatedUserData)
    expect(isolatedDeps.daemonStateDirectory).toBe(join(isolatedUserData, 'daemon'))
    expect(isolatedDeps.daemonStateDirectory).not.toBe(join(defaultUserData, 'daemon'))

    electronMock.isPackaged = false
    const devLoginStart = createAppLoginStartManager({ env: { SCRY_TEST_APP: '1' } })
    expect(devLoginStart.availability()).toEqual({ ok: false, reason: 'unpackaged_build' })
    expect(devLoginStart.canLaunchViaService()).toBe(false)

    electronMock.isPackaged = true
    const packagedLoginStart = createAppLoginStartManager({ env: { SCRY_TEST_APP: '1' } })
    expect(packagedLoginStart.availability()).toEqual({ ok: false, reason: 'test_instance' })
    expect(packagedLoginStart.canLaunchViaService()).toBe(false)
    electronMock.isPackaged = false

    // Attempting to point a test instance at the production label is refused; explicit test label stays isolated.
    expect(resolveLoginStartOverrides({
      SCRY_TEST_APP: '1',
      SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon',
      SCRY_TEST_LOGIN_START_DIR: '/tmp/scry-w15-launch-agents'
    }, 'darwin').testOverrideActive).toBe(false)

    const isolatedManager = createLoginStartManager({
      platform: 'darwin',
      uid: 501,
      homeDir: root,
      
      env: {
        SCRY_TEST_APP: '1',
        SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon.test.w15',
        SCRY_TEST_LOGIN_START_DIR: '/tmp/scry-w15-launch-agents'
      },
      target: {
        executable: '/Applications/Scry.app/Contents/MacOS/Scry',
        appPath: '/Applications/Scry.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/Scry.app/Contents/Resources',
        userDataDir: isolatedUserData,
        isPackaged: true
      }
    })
    expect(isolatedManager.label).toBe('com.scry.daemon.test.w15')
    expect(isolatedManager.filePath).toBe('/tmp/scry-w15-launch-agents/com.scry.daemon.test.w15.plist')
  })
})
