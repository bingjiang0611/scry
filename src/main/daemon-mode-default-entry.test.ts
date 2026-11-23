import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The entry is the only production caller of applyAppStartupGuards in Electron main.
// It must hand the real userData/appData paths to the S3 isolation guard, otherwise a
// SCRY_TEST_APP=1 instance on the default userData would start instead of exiting.
const electron = vi.hoisted(() => ({
  userData: '/home/u/.config/scry',
  appData: '/home/u/.config',
  exit: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => (name === 'userData' ? electron.userData : electron.appData),
    getName: () => 'scry',
    exit: electron.exit
  }
}))

describe('daemon-mode-default-entry', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    vi.resetModules()
    electron.exit.mockReset()
    delete process.env.SCRY_HOST_DAEMON
    delete process.env.SCRY_TEST_APP
  })
  afterEach(() => {
    process.env = { ...saved }
    vi.spyOn(console, 'error').mockRestore()
  })

  it('exits when a test instance runs on the default userData', async () => {
    process.env.SCRY_TEST_APP = '1'
    electron.userData = '/home/u/.config/scry'
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(import('./daemon-mode-default-entry')).rejects.toThrow('test_app_requires_isolated_user_data')
    expect(electron.exit).toHaveBeenCalledWith(1)
  })

  it('starts a test instance with an isolated userData', async () => {
    process.env.SCRY_TEST_APP = '1'
    electron.userData = '/tmp/scry-test-instance'
    await import('./daemon-mode-default-entry')
    expect(electron.exit).not.toHaveBeenCalled()
  })

  it('starts with an explicit SCRY_HOST_DAEMON=0, warning once that it is ignored', async () => {
    process.env.SCRY_HOST_DAEMON = '0'
    electron.userData = '/tmp/scry-test-instance'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await import('./daemon-mode-default-entry')
      expect(electron.exit).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('SCRY_HOST_DAEMON')
    } finally {
      warn.mockRestore()
    }
  })
})
