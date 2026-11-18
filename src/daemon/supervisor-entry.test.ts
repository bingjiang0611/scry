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
      const plan = prepareSupervisorLaunch(env, { pid: 42, platform })
      expect(env.SHELL).toBe(shell)
      expect(plan.daemonEnv.SHELL).toBe(shell)
    }
  })

  it('keeps the SHELL it was given', () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/usr/bin/fish', ...required }
    const plan = prepareSupervisorLaunch(env, { pid: 42, platform: 'linux' })
    expect(plan.daemonEnv.SHELL).toBe('/usr/bin/fish')
  })

  it('marks the daemon as started by this supervisor', () => {
    const plan = prepareSupervisorLaunch({ ...required }, { pid: 42, platform: 'linux' })
    expect(plan.daemonEnv.SCRY_DAEMON_STARTED_BY).toBe('supervisor:42')
    expect(plan.config.stateDirectory).toBe('/tmp/scry-entry/state')
  })
})
