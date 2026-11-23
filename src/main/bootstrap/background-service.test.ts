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
const { CONFIRM_BUTTON, MISMATCH_RESTART_BUTTON, versionMismatchPrompt } = await import('../background-service-copy')
type Lazy = Parameters<typeof registerBackgroundServiceHandlers>[0]['daemon']
type RegisterExtra = Partial<Parameters<typeof registerBackgroundServiceHandlers>[0]>

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

function register(daemon: ReturnType<typeof fakeDaemon> | undefined, daemonMode: boolean, extra: RegisterExtra = {}) {
  electron.userData = mkdtempSync(join(tmpdir(), 'scry-bg-service-'))
  roots.push(electron.userData)
  if (daemonMode) process.env.SCRY_HOST_DAEMON = '1'
  const frame = { url: 'file:///app/renderer/index.html' }
  const contents = { mainFrame: frame, send: vi.fn() }
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  registerBackgroundServiceHandlers({
    handleTrusted: (channel, listener) => registerTrustedIpcHandler(
      { handle: (name, registered) => { handlers.set(name, registered as never) } }, channel, () => win, frame.url, listener),
    daemon: daemon as unknown as Lazy,
    getWindow: () => win,
    ...extra
  })
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return { handlers, invoke, event, win, contents }
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

  it('setLoginStart enforces trusted sender, strict single boolean arg, native confirm on enable, no confirm on disable', async () => {
    const daemon = fakeDaemon({ status: 'ready' })
    const { handlers, invoke, event } = register(daemon, true)
    await expect(Promise.resolve().then(() =>
      handlers.get('remote:backgroundService:setLoginStart')!({ ...event, sender: {} } as unknown as IpcMainInvokeEvent, true)
    )).rejects.toThrow('非可信 renderer')
    for (const bad of [[], ['true'], [1], [{ enabled: true }], [true, 'extra']]) {
      await expect(invoke('remote:backgroundService:setLoginStart', ...bad)).rejects.toThrow('invalid_request')
    }
    // Unpackaged mock app refuses before showing confirmation dialog.
    await expect(invoke('remote:backgroundService:setLoginStart', true)).resolves.toMatchObject({
      status: 'failed', reason: 'unpackaged_build'
    })
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    await expect(invoke('remote:backgroundService:setLoginStart', false)).resolves.toMatchObject({
      status: 'failed', reason: 'unpackaged_build'
    })
    expect(electron.showMessageBox).not.toHaveBeenCalled()
  })

  it('setLoginStart confirms natively before enabling, skips dialog on disable, and runtimeNotice reads without launching daemon (W2 S4/S8)', async () => {
    const daemon = fakeDaemon({ status: 'ready' })
    const loginStart = {
      filePath: '/tmp/com.scry.daemon.plist',
      label: 'com.scry.daemon',
      unitName: 'scry-daemon.service',
      availability: vi.fn(() => ({ ok: true as const })),
      precheckEnable: vi.fn(() => ({ ok: true as const, policyEnvKeys: ['SCRY_REMOTE_HOST'] })),
      status: vi.fn(async () => ({ state: 'disabled' as const })),
      reconcileMovedApp: vi.fn(() => ({ rewritten: false as const })),
      enable: vi.fn(async () => ({ ok: true as const })),
      disable: vi.fn(async () => ({ ok: true as const })),
      canLaunchViaService: vi.fn(() => false),
      startViaService: vi.fn(async () => ({ ok: true as const }))
    }
    const fallback = { reason: 'login_start_service_launch_failed', exitCode: 125 }
    const { invoke, handlers, event } = register(daemon, true, {
      loginStart,
      serviceLaunchFallback: () => fallback
    })

    // S4: runtimeNotice reads current notice from memory without touching daemon.ready().
    await expect(invoke('remote:backgroundService:runtimeNotice')).resolves.toEqual({ serviceLaunchFallback: fallback })
    expect(daemon.ready).not.toHaveBeenCalled()
    await expect(invoke('remote:backgroundService:runtimeNotice', 'extra')).rejects.toThrow('invalid_request')
    await expect(Promise.resolve().then(() =>
      handlers.get('remote:backgroundService:runtimeNotice')!({ ...event, sender: {} } as unknown as IpcMainInvokeEvent)
    )).rejects.toThrow('非可信 renderer')

    // S8: confirmed enable calls native dialog then loginStart.enable; cancel skips enable; disable skips dialog.
    electron.showMessageBox.mockResolvedValueOnce({ response: CONFIRM_BUTTON })
    await expect(invoke('remote:backgroundService:setLoginStart', true)).resolves.toEqual({ status: 'done' })
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
    expect(loginStart.enable).toHaveBeenCalledWith({ daemonRunning: false })

    electron.showMessageBox.mockClear()
    loginStart.enable.mockClear()
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(invoke('remote:backgroundService:setLoginStart', true)).resolves.toEqual({ status: 'cancelled' })
    expect(loginStart.enable).not.toHaveBeenCalled()

    electron.showMessageBox.mockClear()
    await expect(invoke('remote:backgroundService:setLoginStart', false)).resolves.toEqual({ status: 'done' })
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    expect(loginStart.disable).toHaveBeenCalledWith({ daemonRunning: false })
  })

  it('setCliApproval enforces sender/boolean args, hides & refuses when SCRY_EXPERIMENTAL_HOST_CLI is off, and confirms natively when on (P5-5b)', async () => {
    const daemon = fakeDaemon({ status: 'ready' })
    const report = { version: '2.0.0', pid: 4242, startedAt: 5, devices: { state: 'remote-disabled' }, activeRuns: 0 }
    const forwarded = vi.fn(async (call: { op: string; method: string; args: unknown[] }) =>
      call.op === 'localBackgroundService' ? report : { enabled: call.args[0], updatedAt: 100 }
    )
    const uninstall = installDaemonChannelForwarder(forwarded)
    try {
      // 1. Default OFF: status omits cliApproval, setCliApproval fails without dialog or daemon call.
      const off = register(daemon, true, { env: { SCRY_EXPERIMENTAL_HOST_CLI: '0' } })
      await expect(Promise.resolve().then(() =>
        off.handlers.get('remote:hostAdmin:setCliApproval')!({ ...off.event, sender: {} } as unknown as IpcMainInvokeEvent, true)
      )).rejects.toThrow('非可信 renderer')
      for (const bad of [[], ['true'], [1], [true, false]]) {
        await expect(off.invoke('remote:hostAdmin:setCliApproval', ...bad)).rejects.toThrow('invalid_request')
      }
      const offStatus = await off.invoke('remote:backgroundService:status') as Record<string, unknown>
      expect('cliApproval' in offStatus).toBe(false)
      await expect(off.invoke('remote:hostAdmin:setCliApproval', true)).resolves.toMatchObject({
        status: 'failed', reason: 'host_cli_experimental_disabled'
      })
      expect(electron.showMessageBox).not.toHaveBeenCalled()
      expect(forwarded).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'localHostAdmin' }))

      // 2. Experimental ON: status exposes cliApproval, enable confirms natively, cancel skips daemon, disable skips dialog.
      forwarded.mockClear()
      const reportWithCli = { ...report, cliApproval: { enabled: false, updatedAt: null } }
      forwarded.mockImplementation(async (call: { op: string; method: string; args: unknown[] }) =>
        call.op === 'localBackgroundService' ? reportWithCli : { enabled: call.args[0], updatedAt: 200 }
      )
      const on = register(daemon, true, { env: { SCRY_EXPERIMENTAL_HOST_CLI: '1' } })
      const onStatus = await on.invoke('remote:backgroundService:status') as Record<string, unknown>
      expect(onStatus.cliApproval).toMatchObject({ state: 'disabled', updatedAt: null })

      electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
      await expect(on.invoke('remote:hostAdmin:setCliApproval', true)).resolves.toEqual({ status: 'cancelled' })
      expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
      expect(forwarded).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'localHostAdmin' }))

      electron.showMessageBox.mockClear()
      electron.showMessageBox.mockResolvedValueOnce({ response: CONFIRM_BUTTON })
      await expect(on.invoke('remote:hostAdmin:setCliApproval', true)).resolves.toEqual({ status: 'done' })
      expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
      expect(forwarded).toHaveBeenCalledWith({ op: 'localHostAdmin', method: 'setCliApproval', args: [true], read: false })

      electron.showMessageBox.mockClear()
      forwarded.mockClear()
      await expect(on.invoke('remote:hostAdmin:setCliApproval', false)).resolves.toEqual({ status: 'done' })
      expect(electron.showMessageBox).not.toHaveBeenCalled()
      expect(forwarded).toHaveBeenCalledWith({ op: 'localHostAdmin', method: 'setCliApproval', args: [false], read: false })

      // 3. Mixed state (W11 N1): daemon reports cliApproval (enabled), App launched WITHOUT SCRY_EXPERIMENTAL_HOST_CLI.
      // Settings must still show cliApproval and allow turning it OFF, while turning it ON remains refused.
      electron.showMessageBox.mockClear()
      forwarded.mockClear()
      const reportEnabled = { ...report, cliApproval: { enabled: true, updatedAt: 300 } }
      forwarded.mockImplementation(async (call: { op: string; method: string; args: unknown[] }) =>
        call.op === 'localBackgroundService' ? reportEnabled : { enabled: call.args[0], updatedAt: 400 }
      )
      const mixed = register(daemon, true, { env: { SCRY_EXPERIMENTAL_HOST_CLI: '0' } })
      const mixedStatus = await mixed.invoke('remote:backgroundService:status') as Record<string, unknown>
      expect(mixedStatus.cliApproval).toMatchObject({ state: 'enabled', updatedAt: 300 })

      await expect(mixed.invoke('remote:hostAdmin:setCliApproval', true)).resolves.toMatchObject({
        status: 'failed', reason: 'host_cli_experimental_disabled'
      })
      expect(electron.showMessageBox).not.toHaveBeenCalled()
      expect(forwarded).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'localHostAdmin' }))

      await expect(mixed.invoke('remote:hostAdmin:setCliApproval', false)).resolves.toEqual({ status: 'done' })
      expect(electron.showMessageBox).not.toHaveBeenCalled()
      expect(forwarded).toHaveBeenCalledWith({ op: 'localHostAdmin', method: 'setCliApproval', args: [false], read: false })
    } finally {
      uninstall()
    }
  })
})
