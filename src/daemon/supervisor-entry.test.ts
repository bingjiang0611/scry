import { describe, expect, it } from 'vitest'
import { prepareSupervisorLaunch } from './supervisor-entry'

const required = {
  SCRY_DAEMON_STATE_DIR: '/tmp/scry-entry/state',
  SCRY_DAEMON_USER_DATA_DIR: '/tmp/scry-entry/user',
  SCRY_DAEMON_APP_PATH: '/opt/Scry/resources/app.asar',
  SCRY_DAEMON_RESOURCES_PATH: '/opt/Scry/resources',
  SCRY_DAEMON_APP_VERSION: '9.8.7',
  SCRY_DAEMON_PACKAGED: '1'
}

describe('supervisor entry', () => {
  it('fills a missing SHELL with the platform default and hands it to the daemon', () => {
    for (const [platform, shell] of [['linux', '/bin/bash'], ['darwin', '/bin/zsh']] as const) {
      const env: NodeJS.ProcessEnv = { HOME: '/tmp/scry-entry/home', PATH: '/usr/bin:/bin', ...required }
      const plan = prepareSupervisorLaunch(env, { pid: 42, bundleVersion: undefined, platform })
      expect(env.SHELL).toBe(shell)
      expect(plan.daemonEnv.SHELL).toBe(shell)
    }
  })

  it('keeps the SHELL it was given', () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/usr/bin/fish', ...required }
    const plan = prepareSupervisorLaunch(env, { pid: 42, bundleVersion: undefined, platform: 'linux' })
    expect(plan.daemonEnv.SHELL).toBe('/usr/bin/fish')
  })

  it('marks the daemon as started by this supervisor', () => {
    const plan = prepareSupervisorLaunch({ ...required }, { pid: 42, bundleVersion: undefined, platform: 'linux' })
    expect(plan.daemonEnv.SCRY_DAEMON_STARTED_BY).toBe('supervisor:42')
    expect(plan.config.stateDirectory).toBe('/tmp/scry-entry/state')
  })

  it('gives the daemon its own bundle version when the environment names none', () => {
    const { SCRY_DAEMON_APP_VERSION: _omitted, ...withoutVersion } = required
    const plan = prepareSupervisorLaunch({ ...withoutVersion }, { pid: 42, bundleVersion: '1.2.3', platform: 'linux' })
    expect(plan.config.appVersion).toBe('1.2.3')
    expect(plan.daemonEnv.SCRY_DAEMON_APP_VERSION).toBe('1.2.3')
  })

  it('keeps the App-launched path: an equal version passes through unchanged', () => {
    const plan = prepareSupervisorLaunch({ ...required }, { pid: 42, bundleVersion: '9.8.7', platform: 'linux' })
    expect(plan.daemonEnv.SCRY_DAEMON_APP_VERSION).toBe('9.8.7')
  })

  it('passes launchedBy to the daemon explicitly and leaves STARTED_BY to the supervisor', () => {
    for (const launchedBy of ['app', 'service'] as const) {
      const plan = prepareSupervisorLaunch({ ...required, SCRY_DAEMON_LAUNCHED_BY: launchedBy, SCRY_DAEMON_STARTED_BY: 'app:7' }, { pid: 42, bundleVersion: undefined, platform: 'linux' })
      expect(plan.config.launchedBy).toBe(launchedBy)
      expect(plan.daemonEnv.SCRY_DAEMON_LAUNCHED_BY).toBe(launchedBy)
      expect(plan.daemonEnv.SCRY_DAEMON_STARTED_BY).toBe('supervisor:42')
    }
    const unnamed = prepareSupervisorLaunch({ ...required }, { pid: 42, bundleVersion: undefined, platform: 'linux' })
    expect(unnamed.config.launchedBy).toBeUndefined()
    expect('SCRY_DAEMON_LAUNCHED_BY' in unnamed.daemonEnv).toBe(false)
  })

  it('refuses a launchedBy other than app or service', () => {
    expect(() => prepareSupervisorLaunch({ ...required, SCRY_DAEMON_LAUNCHED_BY: 'cron' }, { pid: 42, bundleVersion: undefined, platform: 'linux' }))
      .toThrow('daemon_config_invalid_scry_daemon_launched_by')
  })

  it('refuses a version that is not this bundle\'s', () => {
    expect(() => prepareSupervisorLaunch({ ...required }, { pid: 42, bundleVersion: '1.2.3', platform: 'linux' }))
      .toThrow('daemon_config_version_conflict')
  })
})
