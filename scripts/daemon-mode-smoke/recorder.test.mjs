import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRecorderArguments, recorderDaemonLaunch } from './recorder.mjs'

const target = {
  ok: true, packaged: true, version: '0.9.1',
  executable: '/dist/linux-unpacked/scry',
  resources: '/dist/linux-unpacked/resources',
  appArchive: '/dist/linux-unpacked/resources/app.asar',
  entryDirectory: '/dist/linux-unpacked/resources/app.asar/out/main'
}

describe('packaged recorder smoke launch', () => {
  it('runs the daemon entry inside the packaged archive, never the checkout build', () => {
    const launch = recorderDaemonLaunch(target, { state: '/t/state', userData: '/t/user', resources: target.resources, fakeBin: '/t/bin' })
    expect(launch.executable).toBe(target.executable)
    expect(launch.args).toEqual([join(target.entryDirectory, 'daemon.js')])
    expect(launch.args[0]).not.toBe(resolve('out/main/daemon.js'))
    expect(launch.args[0].startsWith(`${target.appArchive}/`)).toBe(true)
  })

  it('names the artifact version and archive, and hides any `scry` on PATH', () => {
    const { env } = recorderDaemonLaunch(target, { state: '/t/state', userData: '/t/user', resources: '/t/empty', fakeBin: '/t/bin' })
    expect(env).toMatchObject({
      PATH: '/t/bin', ELECTRON_RUN_AS_NODE: '1', SCRY_DAEMON_PACKAGED: '1',
      SCRY_DAEMON_APP_VERSION: '0.9.1', SCRY_DAEMON_APP_PATH: target.appArchive,
      SCRY_DAEMON_RESOURCES_PATH: '/t/empty', SCRY_DAEMON_STATE_DIR: '/t/state', SCRY_DAEMON_USER_DATA_DIR: '/t/user'
    })
  })

  it('refuses a target that is not a resolved packaged layout', () => {
    expect(() => recorderDaemonLaunch({ ...target, packaged: false }, { state: 's', userData: 'u', resources: 'r', fakeBin: 'b' })).toThrow(/packaged/)
    expect(() => recorderDaemonLaunch({ ok: false, reason: 'app_artifact_stale' }, { state: 's', userData: 'u', resources: 'r', fakeBin: 'b' })).toThrow(/app_artifact_stale/)
  })

  it('takes --app or the platform default, nothing else', () => {
    expect(parseRecorderArguments([], { platform: 'linux', arch: 'x64' })).toEqual({ ok: true, app: join('dist', 'linux-unpacked', 'scry') })
    expect(parseRecorderArguments([], { platform: 'darwin', arch: 'arm64' })).toEqual({ ok: true, app: join('dist', 'mac-arm64', 'Scry.app', 'Contents', 'MacOS', 'Scry') })
    expect(parseRecorderArguments(['--app', '/x/scry'], { platform: 'linux', arch: 'x64' })).toEqual({ ok: true, app: '/x/scry' })
    expect(parseRecorderArguments(['--app'], { platform: 'linux', arch: 'x64' })).toMatchObject({ ok: false })
    expect(parseRecorderArguments(['--dev'], { platform: 'linux', arch: 'x64' })).toMatchObject({ ok: false })
  })
})
