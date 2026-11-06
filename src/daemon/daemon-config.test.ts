import { describe, expect, it } from 'vitest'
import { daemonPrivateCliPath, readDaemonProcessConfig } from './daemon-config'

const complete = {
  SCRY_DAEMON_STATE_DIR: '/tmp/state',
  SCRY_DAEMON_USER_DATA_DIR: '/tmp/user',
  SCRY_DAEMON_APP_PATH: '/opt/Scry/resources/app.asar',
  SCRY_DAEMON_RESOURCES_PATH: '/opt/Scry/resources',
  SCRY_DAEMON_APP_VERSION: '9.8.7',
  SCRY_DAEMON_PACKAGED: '1'
}

describe('daemon process configuration', () => {
  it.each(Object.keys(complete))('fails closed when %s is missing', (missing) => {
    const env = { ...complete }
    delete env[missing as keyof typeof env]
    expect(() => readDaemonProcessConfig(env)).toThrow(`daemon_config_missing_${missing.toLowerCase()}`)
  })

  it('uses the injected package paths and version without cwd defaults', () => {
    expect(readDaemonProcessConfig(complete)).toEqual({
      stateDirectory: '/tmp/state', userDataDir: '/tmp/user',
      appPath: '/opt/Scry/resources/app.asar', resourcesPath: '/opt/Scry/resources',
      appVersion: '9.8.7', isPackaged: true
    })
  })

  it('always selects the App private recorder CLI even when PATH names another scry', () => {
    process.env.PATH = '/tmp/fake-global-scry'
    expect(daemonPrivateCliPath('/opt/Scry/resources')).toBe('/opt/Scry/resources/bin/scry')
  })
})
