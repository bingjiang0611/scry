import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createWindow, type WindowBootstrapDependencies } from './window'

const mocks = vi.hoisted(() => ({
  window: {
    setMenu: vi.fn(),
    on: vi.fn(),
    loadFile: vi.fn(),
    webContents: {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      session: {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() }
      }
    }
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function () { return mocks.window }),
  dialog: {},
  Menu: {},
  shell: {}
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('window menu', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('removes the menu only on Linux (%s)', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    vi.useFakeTimers()
    let window: BrowserWindow | null = null
    createWindow({
      __dirname: '/tmp/scry-window-test/main',
      rendererEntryUrl: 'file:///tmp/scry-window-test/renderer/index.html',
      useDevelopmentRenderer: false,
      isOwnedTestApp: true,
      getWindow: () => window,
      setWindow: (value) => { window = value },
      terminalOutput: {},
      traceOutput: {},
      dockBadge: {},
      isShuttingDown: () => false,
      rendererAutoReloadCooldownMs: 1000,
      rendererRestart: {}
    } as WindowBootstrapDependencies)
    if (platform === 'linux') {
      expect(mocks.window.setMenu).toHaveBeenCalledExactlyOnceWith(null)
    } else {
      expect(mocks.window.setMenu).not.toHaveBeenCalled()
    }
  })
})
