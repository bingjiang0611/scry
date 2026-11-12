import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The «后台服务» channels as production registers them: the trust wrapper, the daemon
// gate, then this App's handler. A renderer can neither name an argument nor answer a
// confirmation, and a refused call never reaches the daemon, a dialog or a signal.

const electron = vi.hoisted(() => ({
  userData: '',
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 1 })),
  quit: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getVersion: () => '2.0.0', quit: electron.quit },
  dialog: { showMessageBox: electron.showMessageBox }
}))

const { registerTrustedIpcHandler } = await import('../ipc-trust')
const { installDaemonChannelForwarder } = await import('../daemon-channel-gate')
const { registerBackgroundServiceHandlers } = await import('./background-service')
const { MISMATCH_RESTART_BUTTON, versionMismatchPrompt } = await import('../background-service-copy')
type Lazy = Parameters<typeof registerBackgroundServiceHandlers>[0]['daemon']

const roots: string[] = []
afterEach(() => {
  delete process.env.SCRY_HOST_DAEMON
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeDaemon(ready: Record<string, unknown>) {
  const listeners: Array<(result: unknown) => void> = []
  return {
    ready: vi.fn(async () => ready),
    restart: vi.fn(async () => ({ status: 'ready' })),
    holdLaunches: vi.fn(() => () => undefined),
    onOutcome: vi.fn((listener: (result: unknown) => void) => { listeners.push(listener); return () => undefined }),
    /** What the lazy surface reports after connecting on its own. */
    emit: (result: Record<string, unknown>) => { for (const listener of listeners) listener(result) }
  }
}

function register(daemon: ReturnType<typeof fakeDaemon> | undefined, daemonMode: boolean) {
  electron.userData = mkdtempSync(join(tmpdir(), 'scry-bg-service-'))
  roots.push(electron.userData)
  if (daemonMode) process.env.SCRY_HOST_DAEMON = '1'
  const frame = { url: 'file:///app/renderer/index.html' }
  const contents = { mainFrame: frame }
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  registerBackgroundServiceHandlers({
    handleTrusted: (channel, listener) => registerTrustedIpcHandler(
      { handle: (name, registered) => { handlers.set(name, registered as never) } }, channel, () => win, frame.url, listener),
    daemon: daemon as unknown as Lazy,
    getWindow: () => win
  })
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return { handlers, invoke, event, win }
}

describe('background service channels', () => {
  it('refuses an untrusted sender and any argument before touching the daemon or a dialog', async () => {
    const daemon = fakeDaemon({ status: 'device-not-authorized' })
    const { handlers, invoke, event } = register(daemon, true)
    const forwarded = vi.fn(async () => ({}))
    const uninstall = installDaemonChannelForwarder(forwarded)
    try {
      for (const channel of ['remote:backgroundService:status', 'remote:backgroundService:restart', 'remote:backgroundService:quit', 'remote:backgroundService:reconnect']) {
        await expect(Promise.resolve().then(() => handlers.get(channel)!({ ...event, sender: {} } as unknown as IpcMainInvokeEvent))).rejects.toThrow('非可信 renderer')
        await expect(invoke(channel, 4242)).rejects.toThrow('invalid_request')
        await expect(invoke(channel, { confirmed: true })).rejects.toThrow('invalid_request')
      }
      expect(daemon.ready).not.toHaveBeenCalled()
      expect(daemon.holdLaunches).not.toHaveBeenCalled()
      expect(daemon.restart).not.toHaveBeenCalled()
      expect(forwarded).not.toHaveBeenCalled()
      expect(electron.showMessageBox).not.toHaveBeenCalled()
      expect(electron.quit).not.toHaveBeenCalled()
    } finally {
      uninstall()
    }
  })

  it('answers status for a refused daemon from the App alone, with unknowns', async () => {
    const daemon = fakeDaemon({ status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon' })
    const { invoke } = register(daemon, true)
    const forwarded = vi.fn(async () => ({}))
    const uninstall = installDaemonChannelForwarder(forwarded)
    try {
      await expect(invoke('remote:backgroundService:status')).resolves.toMatchObject({
        mode: 'daemon', userDataDir: electron.userData,
        connection: { state: 'version-mismatch', running: '1.0.0', expected: '2.0.0' },
        version: '1.0.0', pid: null, startedAt: null, devices: null, activeRuns: null
      })
      // A mismatched daemon is never asked anything.
      expect(forwarded).not.toHaveBeenCalled()
    } finally {
      uninstall()
    }
  })

  it('asks the daemon for its own report while connected', async () => {
    const daemon = fakeDaemon({ status: 'ready' })
    const { invoke } = register(daemon, true)
    const report = { version: '2.0.0', pid: 4242, startedAt: 5, devices: { state: 'remote-disabled' }, activeRuns: 0 }
    const forwarded = vi.fn(async (_call: unknown) => report)
    const uninstall = installDaemonChannelForwarder(forwarded)
    try {
      await expect(invoke('remote:backgroundService:status')).resolves.toMatchObject({ connection: { state: 'ready' }, ...report })
      expect(forwarded).toHaveBeenCalledExactlyOnceWith({ op: 'localBackgroundService', method: 'status', args: [], read: true })
    } finally {
      uninstall()
    }
  })

  it('says there is no background service with the switch off, and offers no action', async () => {
    const { invoke } = register(undefined, false)
    await expect(invoke('remote:backgroundService:status')).resolves.toEqual({ mode: 'in-process', userDataDir: electron.userData })
    await expect(invoke('remote:backgroundService:quit')).resolves.toMatchObject({ status: 'failed', reason: 'daemon_mode_disabled' })
    expect(electron.quit).not.toHaveBeenCalled()
  })

  it('never reconnects on a valid grant, and restarts a stopped service without a dialog', async () => {
    const daemon = fakeDaemon({ status: 'ready' })
    const { invoke } = register(daemon, true)
    await expect(invoke('remote:backgroundService:reconnect')).resolves.toMatchObject({ status: 'failed', reason: 'daemon_device_authorized' })
    expect(daemon.restart).not.toHaveBeenCalled()
    // No daemon.lock in this userData: nothing to signal, so nothing to confirm.
    await expect(invoke('remote:backgroundService:restart')).resolves.toEqual({ status: 'done' })
    expect(daemon.restart).toHaveBeenCalledTimes(1)
    expect(electron.showMessageBox).not.toHaveBeenCalled()
  })

  it('shows one startup prompt on the main window for a detected mismatch, and 重启后台服务 runs the restart action', async () => {
    const daemon = fakeDaemon({ status: 'ready' })
    const { win } = register(daemon, true)
    electron.showMessageBox.mockResolvedValueOnce({ response: MISMATCH_RESTART_BUTTON })
    daemon.emit({ status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon' })
    // No daemon.lock in this userData: the action has nothing to signal and reconnects.
    await vi.waitFor(() => expect(daemon.restart).toHaveBeenCalledTimes(1))
    expect(electron.showMessageBox).toHaveBeenCalledExactlyOnceWith(win, versionMismatchPrompt('1.0.0', '2.0.0'))
    daemon.emit({ status: 'version-mismatch', running: 'unknown', expected: '2.0.0', action: 'restart_daemon' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
    expect(daemon.restart).toHaveBeenCalledTimes(1)
  })

  it('does nothing for 稍后, and shows nothing for a daemon of the same version', async () => {
    const daemon = fakeDaemon({ status: 'ready' })
    register(daemon, true)
    daemon.emit({ status: 'ready' })
    daemon.emit({ status: 'device-not-authorized', reason: 'daemon_device_not_authorized' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    // The default mock answers 稍后 (index 1).
    daemon.emit({ status: 'version-mismatch', running: 'unknown', expected: '2.0.0', action: 'restart_daemon' })
    await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledTimes(1))
    expect(electron.showMessageBox.mock.calls[0][1]).toEqual(versionMismatchPrompt(null, '2.0.0'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(daemon.restart).not.toHaveBeenCalled()
    expect(daemon.holdLaunches).not.toHaveBeenCalled()
  })
})
