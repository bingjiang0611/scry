import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import enforceHiddenWindows from './hidden-electron-windows.cjs'

function fixture(visible = false) {
  const app = new EventEmitter()
  app.exit = vi.fn(() => { throw new Error('app exited') })
  const window = new EventEmitter()
  window.isVisible = () => visible
  const nativeCall = vi.fn()
  for (const method of ['show', 'showInactive', 'focus', 'restore']) window[method] = nativeCall
  vi.spyOn(console, 'error').mockImplementation(() => {})
  enforceHiddenWindows(app)
  return { app, window, nativeCall }
}

afterEach(() => vi.restoreAllMocks())

describe('background Electron window guard', () => {
  it('allows a hidden window without terminating the fixture', () => {
    const { app, window } = fixture()
    app.emit('browser-window-created', {}, window)
    expect(app.exit).not.toHaveBeenCalled()
  })

  it.each(['show', 'showInactive', 'focus', 'restore'])('blocks %s before the native call', method => {
    const { app, window, nativeCall } = fixture()
    app.emit('browser-window-created', {}, window)
    expect(() => window[method]()).toThrow('app exited')
    expect(nativeCall).not.toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(`Background test attempted window ${method}`)
  })

  it.each(['show', 'focus'])('rejects a native %s event', event => {
    const { app, window } = fixture()
    app.emit('browser-window-created', {}, window)
    expect(() => window.emit(event)).toThrow('app exited')
    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('rejects creation of an already visible window', () => {
    const { app, window } = fixture(true)
    expect(() => app.emit('browser-window-created', {}, window)).toThrow('app exited')
    expect(app.exit).toHaveBeenCalledWith(1)
  })
})
