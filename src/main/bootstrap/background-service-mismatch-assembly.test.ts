import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_LOCK_NAME } from '../../daemon/ledger-lock'
import { processIdentityKey, type ProcessRow } from '../process-diagnostics'


const electron = vi.hoisted(() => ({
  userData: '',
  appPath: '/tmp/scry-checkout-b',
  isPackaged: false,
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 1 })),
  quit: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electron.userData,
    getVersion: () => '2.0.0',
    getAppPath: () => electron.appPath,
    get isPackaged() { return electron.isPackaged },
    quit: electron.quit
  },
  dialog: { showMessageBox: electron.showMessageBox }
}))

const { registerTrustedIpcHandler } = await import('../ipc-trust')
const { registerBackgroundServiceHandlers } = await import('./background-service')
type Lazy = Parameters<typeof registerBackgroundServiceHandlers>[0]['daemon']

const roots: string[] = []
afterEach(() => {
  delete process.env.SCRY_HOST_DAEMON
  electron.isPackaged = false
  electron.appPath = '/tmp/scry-checkout-b'
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeDaemon() {
  const listeners: Array<(result: unknown) => void> = []
  return {
    ready: vi.fn(async () => ({ status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon' })),
    restart: vi.fn(async () => ({ status: 'ready' })),
    holdLaunches: vi.fn(() => () => undefined),
    onOutcome: vi.fn((listener: (result: unknown) => void) => { listeners.push(listener); return () => undefined }),
    emit: (result: Record<string, unknown>) => { for (const listener of listeners) listener(result) }
  }
}

function seedLock(userDataDir: string, row: ProcessRow) {
  const stateDir = join(userDataDir, 'daemon')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, DAEMON_LOCK_NAME), JSON.stringify({
    pid: row.pid,
    startedAt: row.startedAt,
    identityKey: processIdentityKey(row),
    startedBy: 'supervisor'
  }))
}

function setupAssembly(options: { isPackaged: boolean; appPath?: string; holderRow?: ProcessRow }) {
  electron.userData = mkdtempSync(join(tmpdir(), 'scry-bg-asm-'))
  roots.push(electron.userData)
  electron.isPackaged = options.isPackaged
  electron.appPath = options.appPath ?? '/tmp/scry-checkout-b'
  process.env.SCRY_HOST_DAEMON = '1'
  let alive = Boolean(options.holderRow)
  const signals: Array<{ pid: number; signal: string }> = []
  if (options.holderRow) seedLock(electron.userData, options.holderRow)
  const readIdentity = vi.fn(async (pid: number) =>
    alive && options.holderRow && pid === options.holderRow.pid ? options.holderRow : undefined
  )
  const signal = vi.fn((pid: number, sig: 'SIGTERM') => {
    signals.push({ pid, signal: sig })
    alive = false
  })
  const daemon = fakeDaemon()
  const frame = { url: 'file:///app/renderer/index.html' }
  const contents = { mainFrame: frame, send: vi.fn() }
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  registerBackgroundServiceHandlers({
    handleTrusted: (channel, listener) => registerTrustedIpcHandler(
      { handle: (name, registered) => { handlers.set(name, registered as never) } }, channel, () => win, frame.url, listener),
    daemon: daemon as unknown as Lazy,
    getWindow: () => win,
    readProcessIdentity: readIdentity,
    stopDepsOverride: { signal, pollMs: 1, sleep: async () => undefined }
  })
  return { daemon, signals, signal, readIdentity }
}

const DEV_ROW: ProcessRow = {
  pid: 4242, ppid: 1, status: 'S', startedAt: 'Sat Nov 21 10:00:00 2026',
  command: '/path/Electron /tmp/scry-checkout-b/out/main/daemon.js'
}
const PACKAGED_ROW: ProcessRow = {
  pid: 5151, ppid: 1, status: 'S', startedAt: 'Sat Nov 21 10:00:00 2026',
  command: '/Applications/Scry.app/Contents/MacOS/Scry /Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon.js'
}

describe('background-service mismatch auto-restart assembly (W15 R2)', () => {
  it('never auto-restarts in packaged builds even when daemon reports isPackaged:false and activeRuns:0', async () => {
    const { daemon, signals } = setupAssembly({ isPackaged: true, holderRow: DEV_ROW })
    const probeActiveRuns = vi.fn(async () => 0)
    daemon.emit({
      status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon',
      runningActiveRuns: 0, runningIsPackaged: false, probeActiveRuns
    })
    await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledTimes(1))
    expect(signals).toEqual([])
    expect(daemon.restart).not.toHaveBeenCalled()
    expect(probeActiveRuns).not.toHaveBeenCalled()
  })

  it('S2: dev build refuses auto-restart when daemon reports isPackaged:true (daily packaged daemon)', async () => {
    const { daemon, signals } = setupAssembly({ isPackaged: false, holderRow: PACKAGED_ROW })
    const probeActiveRuns = vi.fn(async () => 0)
    daemon.emit({
      status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon',
      runningActiveRuns: 0, runningIsPackaged: true, probeActiveRuns
    })
    await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledTimes(1))
    expect(signals).toEqual([])
    expect(daemon.restart).not.toHaveBeenCalled()
    expect(probeActiveRuns).not.toHaveBeenCalled()
  })

  it('S2: dev build checks lock-holder command when isPackaged is omitted — refuses packaged, allows own checkout', async () => {
    // Older packaged daemon without isPackaged field -> lock holder command is /Applications/Scry.app -> prompt!
    const foreign = setupAssembly({ isPackaged: false, holderRow: PACKAGED_ROW })
    foreign.daemon.emit({
      status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon',
      runningActiveRuns: 0, probeActiveRuns: vi.fn(async () => 0)
    })
    await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledTimes(1))
    expect(foreign.signals).toEqual([])
    expect(foreign.daemon.restart).not.toHaveBeenCalled()

    // Older dev daemon from this checkout without isPackaged field -> lock holder matches appPath -> auto-restarts!
    electron.showMessageBox.mockClear()
    const own = setupAssembly({ isPackaged: false, holderRow: DEV_ROW })
    own.daemon.emit({
      status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon',
      runningActiveRuns: 0, probeActiveRuns: vi.fn(async () => 0)
    })
    await vi.waitFor(() => expect(own.daemon.restart).toHaveBeenCalledTimes(1))
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    expect(own.signals).toEqual([{ pid: DEV_ROW.pid, signal: 'SIGTERM' }])
  })

  it('S1: falls back to confirmation dialog without signalling when activeRuns becomes non-zero right before SIGTERM', async () => {
    const { daemon, signals } = setupAssembly({ isPackaged: false, holderRow: DEV_ROW })
    // 1st probe (mismatch prompt check) sees 0; 2nd probe (inside restartBackgroundService right before SIGTERM) sees 1!
    const probeActiveRuns = vi.fn<() => Promise<number | undefined>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
    daemon.emit({
      status: 'version-mismatch', running: '1.0.0', expected: '2.0.0', action: 'restart_daemon',
      runningActiveRuns: 0, runningIsPackaged: false, probeActiveRuns
    })
    await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledTimes(1))
    expect(probeActiveRuns).toHaveBeenCalledTimes(2)
    expect(signals).toEqual([])
    expect(daemon.restart).not.toHaveBeenCalled()
  })
})
