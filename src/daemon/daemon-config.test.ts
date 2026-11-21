import { describe, expect, it } from 'vitest'
import { readDaemonProcessConfig, readSupervisorProcessConfig } from './daemon-config'

const complete = {
  SCRY_DAEMON_STATE_DIR: '/tmp/state',
  SCRY_DAEMON_USER_DATA_DIR: '/tmp/user',
  SCRY_DAEMON_APP_PATH: '/opt/Scry/resources/app.asar',
  SCRY_DAEMON_RESOURCES_PATH: '/opt/Scry/resources',
  SCRY_DAEMON_APP_VERSION: '9.8.7',
  SCRY_DAEMON_PACKAGED: '1'
}
const expected = {
  stateDirectory: '/tmp/state', userDataDir: '/tmp/user',
  appPath: '/opt/Scry/resources/app.asar', resourcesPath: '/opt/Scry/resources',
  appVersion: '9.8.7', isPackaged: true
}
const without = (key: keyof typeof complete): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...complete }
  delete env[key]
  return env
}

describe('daemon process configuration', () => {
  it.each(Object.keys(complete))('fails closed when %s is missing', (missing) => {
    expect(() => readDaemonProcessConfig(without(missing as keyof typeof complete))).toThrow(`daemon_config_missing_${missing.toLowerCase()}`)
  })

  it('uses the injected package paths and version without cwd defaults', () => {
    expect(readDaemonProcessConfig(complete)).toEqual(expected)
  })

  it('rejects a packaged flag other than 0 or 1', () => {
    expect(() => readDaemonProcessConfig({ ...complete, SCRY_DAEMON_PACKAGED: 'yes' })).toThrow('daemon_config_invalid_scry_daemon_packaged')
  })
})

describe('supervisor process configuration', () => {
  it.each(Object.keys(complete).filter((key) => key !== 'SCRY_DAEMON_APP_VERSION'))('fails closed when %s is missing', (missing) => {
    expect(() => readSupervisorProcessConfig(without(missing as keyof typeof complete), '9.8.7')).toThrow(`daemon_config_missing_${missing.toLowerCase()}`)
  })

  it('takes the version from its bundle, so a service file needs none', () => {
    expect(readSupervisorProcessConfig(without('SCRY_DAEMON_APP_VERSION'), '9.8.7')).toEqual(expected)
    expect(readSupervisorProcessConfig({ ...complete, SCRY_DAEMON_APP_VERSION: '  ' }, '9.8.7')).toEqual(expected)
  })

  it('accepts the same version from the App and refuses a different one', () => {
    expect(readSupervisorProcessConfig(complete, '9.8.7')).toEqual(expected)
    expect(() => readSupervisorProcessConfig(complete, '9.8.8')).toThrow('daemon_config_version_conflict')
  })

  it('still requires a version when the code is not bundled', () => {
    expect(readSupervisorProcessConfig(complete, undefined)).toEqual(expected)
    expect(() => readSupervisorProcessConfig(without('SCRY_DAEMON_APP_VERSION'), undefined)).toThrow('daemon_config_missing_scry_daemon_app_version')
  })
})
