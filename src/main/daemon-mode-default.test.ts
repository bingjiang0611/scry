import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyDaemonModeDefault } from './daemon-mode-default'
import { daemonModeEnabled } from './daemon-channel-gate'
import { daemonClientPaths } from './daemon-client'
import { createLoginStartManager, resolveLoginStartOverrides } from '../daemon/login-start'

describe('daemon mode default (W15 S3 step 1)', () => {
  it('turns daemon mode on by default for packaged, dev, and SCRY_TEST_APP=1 when unset', () => {
    const packaged: NodeJS.ProcessEnv = {}
    applyDaemonModeDefault(packaged, { isPackaged: true })
    expect(daemonModeEnabled(packaged)).toBe(true)

    const dev: NodeJS.ProcessEnv = {}
    applyDaemonModeDefault(dev, { isPackaged: false })
    expect(daemonModeEnabled(dev)).toBe(true)

    const testPackaged: NodeJS.ProcessEnv = { SCRY_TEST_APP: '1' }
    applyDaemonModeDefault(testPackaged, { isPackaged: true })
    expect(daemonModeEnabled(testPackaged)).toBe(true)

    const testDev: NodeJS.ProcessEnv = { SCRY_TEST_APP: '1' }
    applyDaemonModeDefault(testDev, { isPackaged: false })
    expect(daemonModeEnabled(testDev)).toBe(true)
  })

  it('keeps explicit SCRY_HOST_DAEMON=0 as the in-process escape hatch across all build kinds', () => {
    for (const [env, isPackaged] of [
      [{ SCRY_HOST_DAEMON: '0' }, true],
      [{ SCRY_HOST_DAEMON: '0' }, false],
      [{ SCRY_HOST_DAEMON: '0', SCRY_TEST_APP: '1' }, false],
      [{ SCRY_HOST_DAEMON: '0', SCRY_TEST_APP: '1' }, true]
    ] as Array<[NodeJS.ProcessEnv, boolean]>) {
      applyDaemonModeDefault(env, { isPackaged })
      expect(daemonModeEnabled(env)).toBe(false)
    }
  })
})

describe('SCRY_TEST_APP=1 daemon isolation (W15)', () => {
  it('uses isolated test userData/socket and never connects to or launches daily com.scry.daemon', () => {
    const tempHome = '/tmp/scry-w15-test-home'
    const testUserData = '/tmp/scry-w15-test-userdata'
    const dailyMacUserData = join(tempHome, 'Library', 'Application Support', 'Scry')
    const dailyMacPlist = join(tempHome, 'Library', 'LaunchAgents', 'com.scry.daemon.plist')

    const testPaths = daemonClientPaths(join(testUserData, 'daemon'), testUserData)
    const dailyPaths = daemonClientPaths(join(dailyMacUserData, 'daemon'), dailyMacUserData)
    expect(testPaths.socketPath).toBe(join(testUserData, 'daemon', 'local.sock'))
    expect(testPaths.enrollSocketPath).toBe(join(testUserData, 'daemon', 'enroll.sock'))
    expect(testPaths.socketPath).not.toBe(dailyPaths.socketPath)
    expect(testPaths.enrollSocketPath).not.toBe(dailyPaths.enrollSocketPath)

    // Without explicit test label + dir overrides, a test instance cannot touch daily com.scry.daemon.
    const defaultTestEnv: NodeJS.ProcessEnv = { SCRY_TEST_APP: '1' }
    applyDaemonModeDefault(defaultTestEnv, { isPackaged: false })
    expect(daemonModeEnabled(defaultTestEnv)).toBe(true)
    const defaultManager = createLoginStartManager({
      platform: 'darwin',
      uid: 501,
      homeDir: tempHome,
      daemonMode: true,
      env: defaultTestEnv,
      target: {
        executable: '/Applications/Scry.app/Contents/MacOS/Scry',
        appPath: '/Applications/Scry.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/Scry.app/Contents/Resources',
        userDataDir: testUserData,
        isPackaged: true
      }
    })
    expect(defaultManager.availability()).toEqual({ ok: false, reason: 'test_instance' })
    expect(defaultManager.canLaunchViaService()).toBe(false)

    // Attempting to point a test instance at the production label is refused.
    expect(resolveLoginStartOverrides({
      SCRY_TEST_APP: '1',
      SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon',
      SCRY_TEST_LOGIN_START_DIR: '/tmp/scry-w15-launch-agents'
    }, 'darwin').testOverrideActive).toBe(false)

    // With explicit test label + dir overrides, label and plist stay strictly isolated from daily com.scry.daemon.
    const isolatedEnv: NodeJS.ProcessEnv = {
      SCRY_TEST_APP: '1',
      SCRY_TEST_LOGIN_START_LABEL: 'com.scry.daemon.test.w15',
      SCRY_TEST_LOGIN_START_DIR: '/tmp/scry-w15-launch-agents'
    }
    const isolatedManager = createLoginStartManager({
      platform: 'darwin',
      uid: 501,
      homeDir: tempHome,
      daemonMode: true,
      env: isolatedEnv,
      target: {
        executable: '/Applications/Scry.app/Contents/MacOS/Scry',
        appPath: '/Applications/Scry.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/Scry.app/Contents/Resources',
        userDataDir: testUserData,
        isPackaged: true
      }
    })
    expect(isolatedManager.label).toBe('com.scry.daemon.test.w15')
    expect(isolatedManager.label).not.toBe('com.scry.daemon')
    expect(isolatedManager.filePath).toBe('/tmp/scry-w15-launch-agents/com.scry.daemon.test.w15.plist')
    expect(isolatedManager.filePath).not.toBe(dailyMacPlist)
  })
})
