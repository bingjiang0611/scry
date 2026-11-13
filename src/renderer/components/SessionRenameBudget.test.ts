import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../../../scripts/fixtures/session-rename-main.cjs', import.meta.url), 'utf8')

function runMain(remainingMs: number) {
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => ready,
    setActivationPolicy: vi.fn(),
    setPath: vi.fn(),
    exit: vi.fn()
  })
  const contents = Object.assign(new EventEmitter(), { isOffscreen: () => true })
  const launches: unknown[] = []
  class BrowserWindow {
    webContents = contents
    loadFile = vi.fn()
    constructor(options: unknown) { launches.push(options) }
  }
  const errors = vi.fn()
  runInNewContext(source, {
    require: () => ({ app, BrowserWindow }),
    process: { platform: 'linux', argv: ['electron', 'fixture', 'index.html', 'userData', String(Date.now() + remainingMs)] },
    console: { log: vi.fn(), error: errors },
    Date, setTimeout, clearTimeout
  })
  return { app, contents, launches, errors, ready: async () => { resolveReady(); await ready } }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('still rejects startup that never becomes ready after fifteen seconds', () => {
  const { app, errors } = runMain(30000)
  vi.advanceTimersByTime(14999)
  expect(app.exit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(app.exit).toHaveBeenCalledWith(3)
  expect(errors.mock.calls[0][1]).toContain('"phase":"startup"')
})

it('allows the unchanged interaction after slow startup and clears its watchdog on success', async () => {
  const { app, contents, ready } = runMain(30000)
  vi.advanceTimersByTime(13500)
  await ready()
  contents.emit('did-finish-load')
  vi.advanceTimersByTime(3000)
  contents.emit('console-message', { message: 'SCRY_RENAME_TEST_OK' })
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0)
  vi.advanceTimersByTime(30000)
  expect(app.exit).toHaveBeenCalledTimes(1)
})

it('still bounds interaction by fifteen seconds after load', async () => {
  const { app, contents, errors, ready } = runMain(30000)
  vi.advanceTimersByTime(13500)
  await ready()
  contents.emit('did-finish-load')
  vi.advanceTimersByTime(14999)
  expect(app.exit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(app.exit).toHaveBeenCalledWith(3)
  expect(errors.mock.calls[0][1]).toContain('"phase":"interaction"')
})

it('caps the second phase by the original total budget, including time spent building', async () => {
  const { app, contents, ready } = runMain(16000) // fourteen seconds already spent before launch
  vi.advanceTimersByTime(13500)
  await ready()
  contents.emit('did-finish-load')
  vi.advanceTimersByTime(2499)
  expect(app.exit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(app.exit).toHaveBeenCalledWith(3)
})

it('cannot revive an expired startup with a late load event before its timer is dispatched', async () => {
  const { app, contents, ready } = runMain(30000)
  await ready()
  vi.setSystemTime(16000)
  contents.emit('did-finish-load')
  expect(app.exit).toHaveBeenCalledWith(3)
})

it('does not create a window after a late ready event', async () => {
  const { app, launches, ready } = runMain(30000)
  vi.setSystemTime(16000)
  await ready()
  expect(launches).toHaveLength(0)
  expect(app.exit).toHaveBeenCalledWith(3)
})

it('does not accept a success message delivered after its deadline', async () => {
  const { app, contents, ready } = runMain(30000)
  await ready()
  contents.emit('did-finish-load')
  vi.setSystemTime(16000)
  contents.emit('console-message', { message: 'SCRY_RENAME_TEST_OK' })
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(3)
})

it.each(['render-process-gone', 'did-fail-load'])('preserves immediate %s failure', async event => {
  const { app, contents, ready } = runMain(30000)
  await ready()
  contents.emit(event, {}, { reason: 'crashed' })
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(2)
  vi.advanceTimersByTime(30000)
  expect(app.exit).toHaveBeenCalledTimes(1)
})

it('preserves business failures and the hidden sandboxed window', async () => {
  const { app, contents, launches, ready } = runMain(30000)
  await ready()
  expect(launches).toEqual([{ show: false, webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } }])
  contents.emit('console-message', { message: 'SCRY_RENAME_TEST_FAILED Error: UI condition timed out' })
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
})
