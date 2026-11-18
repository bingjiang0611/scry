import { describe, expect, it } from 'vitest'
import { applyDaemonModeDefault } from './daemon-mode-default'
import { daemonModeEnabled } from './daemon-channel-gate'

describe('daemon mode default', () => {
  it('turns daemon mode on for a packaged App when nothing chose otherwise', () => {
    const env: NodeJS.ProcessEnv = {}
    applyDaemonModeDefault(env, { isPackaged: true })
    expect(daemonModeEnabled(env)).toBe(true)
  })

  it('keeps an explicit SCRY_HOST_DAEMON=0 as the way back to the in-process path', () => {
    const env: NodeJS.ProcessEnv = { SCRY_HOST_DAEMON: '0' }
    applyDaemonModeDefault(env, { isPackaged: true })
    expect(daemonModeEnabled(env)).toBe(false)
  })

  it('leaves development builds and owned test instances on their explicit choice', () => {
    const dev: NodeJS.ProcessEnv = {}
    applyDaemonModeDefault(dev, { isPackaged: false })
    expect(daemonModeEnabled(dev)).toBe(false)
    const testApp: NodeJS.ProcessEnv = { SCRY_TEST_APP: '1' }
    applyDaemonModeDefault(testApp, { isPackaged: true })
    expect(daemonModeEnabled(testApp)).toBe(false)
  })
})
