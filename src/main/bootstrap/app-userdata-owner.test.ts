import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The App's real startup sequence (registerAppLifecycle) against a real temp userData and
// the real lock: Electron's app and dialog, and the userData writers, are spies. The question
// is the order: the switch-off App owns userData before any writer starts, writes nothing
// when it cannot, and gives the lock back when it quits.
const state = vi.hoisted(() => ({
  userDataDir: '',
  ready: { resolve: (): void => undefined },
  once: new Map<string, () => void>(),
  dialogResponses: [] as number[]
}))
const electron = vi.hoisted(() => ({
  exit: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: state.dialogResponses.shift() ?? 1, checkboxChecked: false }))
}))
vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>((resolve) => { state.ready.resolve = resolve }),
    getPath: () => state.userDataDir,
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/nonexistent/scry-test-app',
    isPackaged: false,
    on: vi.fn(),
    once: (event: string, listener: () => void) => { state.once.set(event, listener) },
    quit: vi.fn(),
    exit: electron.exit,
    getAppMetrics: () => []
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: electron.showMessageBox }
}))
const writers = vi.hoisted(() => ({
  initDb: vi.fn(),
  runStartupRecovery: vi.fn(async () => undefined),
  configureStorage: vi.fn(),
  startPerformanceRecording: vi.fn(async () => undefined),
  configureProviderEventLog: vi.fn(),
  configureRunStageTiming: vi.fn(),
  startRemoteHostIfEnabled: vi.fn(async () => undefined)
}))
vi.mock('../db', () => ({ initDb: writers.initDb, setBillingEnvProvider: vi.fn() }))
vi.mock('./startup-recovery', () => ({ runStartupRecovery: writers.runStartupRecovery }))
vi.mock('../storage-paths', () => ({ configureStorage: writers.configureStorage }))
vi.mock('../performance-recording', () => ({
  startPerformanceRecording: writers.startPerformanceRecording, stopPerformanceRecording: vi.fn(async () => undefined),
  recordResourcePerformance: vi.fn(), recordStartupPerformance: vi.fn(), performanceRecordingHealth: () => ({})
}))
vi.mock('../performance-resource-monitor', () => ({ startPerformanceResourceMonitor: () => ({ stop: vi.fn() }) }))
vi.mock('../provider-event-log', () => ({ configureProviderEventLog: writers.configureProviderEventLog }))
vi.mock('../run-stage-timing', () => ({ configureRunStageTiming: writers.configureRunStageTiming }))
vi.mock('../claude-locate', () => ({ packagedRecorderCliPath: () => undefined, warmShellEnv: vi.fn(async () => undefined), shellEnv: vi.fn() }))
vi.mock('./remote-host', () => ({ startRemoteHostIfEnabled: writers.startRemoteHostIfEnabled }))

const { registerAppLifecycle } = await import('./app-lifecycle')
const { DAEMON_MODE_ENV } = await import('../daemon-channel-gate')
const { USERDATA_LOCK_NAME } = await import('../../daemon/userdata-lock')
const { processIdentityKey, readProcessIdentitySync } = await import('../process-diagnostics')

const originalSwitch = process.env[DAEMON_MODE_ENV]
const dirs: string[] = []
const children: ChildProcess[] = []
beforeEach(() => {
  vi.clearAllMocks()
  state.once.clear()
  state.dialogResponses = []
  state.userDataDir = mkdtempSync(join(tmpdir(), 'scry-app-owner-ud-'))
  dirs.push(state.userDataDir)
  delete process.env[DAEMON_MODE_ENV]
})
afterEach(() => {
  if (originalSwitch === undefined) delete process.env[DAEMON_MODE_ENV]
  else process.env[DAEMON_MODE_ENV] = originalSwitch
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const lockPath = (): string => join(state.userDataDir, USERDATA_LOCK_NAME)

// A daemon stand-in: a real child that, like the daemon's dispose, drops its record on SIGTERM.
async function liveDaemonHolder(): Promise<{ child: ChildProcess; record: string }> {
  const script = `process.on('SIGTERM', () => { require('node:fs').rmSync(process.argv[1], { force: true }); process.exit(0) }); setInterval(() => {}, 1000); process.stdout.write('ready\\n')`
  const child = spawn(process.execPath, ['-e', script, lockPath()], { stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout?.once('data', () => resolve()) })
  const row = readProcessIdentitySync(child.pid!)
  if (!row) throw new Error('no identity for the holder')
  const record = `${JSON.stringify({ pid: child.pid, startedAt: row.startedAt, identityKey: processIdentityKey(row), startedBy: 'supervisor:1', role: 'daemon' })}\n`
  writeFileSync(lockPath(), record, { mode: 0o600 })
  return { child, record }
}

function startApp(): { createWindow: ReturnType<typeof vi.fn>; recovery: () => Promise<void> | undefined } {
  const createWindow = vi.fn()
  let recovery: Promise<void> | undefined
  registerAppLifecycle({
    primaryInstance: true,
    useDevelopmentRenderer: false,
    dockBadge: { sync: vi.fn() },
    createWindow,
    traceOutput: { snapshot: () => ({}) },
    runs: { activeStates: () => [] },
    remoteHostRuntime: {},
    requireDesktopRemoteClient: () => ({ restoreConnections: async () => undefined }),
    setStartupManagedRecovery: (next: Promise<void>) => { recovery = next },
    conversationStore: () => ({}),
    beginShutdown: vi.fn(),
    getRemoteHostService: () => null,
    getDesktopRemoteClient: () => null
  } as unknown as Parameters<typeof registerAppLifecycle>[0])
  state.ready.resolve()
  return { createWindow, recovery: () => recovery }
}

describe('switch-off App owns its userData for its whole life', () => {
  it('takes the role-app lock before opening scry.db and gives it back on quit', async () => {
    const lockWhenDbOpened: unknown[] = []
    writers.initDb.mockImplementation(() => {
      lockWhenDbOpened.push(existsSync(lockPath()) ? JSON.parse(readFileSync(lockPath(), 'utf8')) : undefined)
    })
    const app = startApp()
    await vi.waitFor(() => { expect(app.recovery()).toBeDefined() })
    expect(lockWhenDbOpened).toEqual([expect.objectContaining({ pid: process.pid, role: 'app' })])
    expect(electron.showMessageBox).not.toHaveBeenCalled()
    expect(electron.exit).not.toHaveBeenCalled()
    // Electron emits `quit` after before-quit cleanup has finished.
    state.once.get('quit')?.()
    expect(existsSync(lockPath())).toBe(false)
  })

  it('with a live daemon and 退出, quits before any writer and leaves userData as it was', async () => {
    const { child, record } = await liveDaemonHolder()
    const listing = readdirSync(state.userDataDir)
    state.dialogResponses = [1]
    const app = startApp()
    await vi.waitFor(() => { expect(electron.exit).toHaveBeenCalledTimes(1) })
    expect(electron.exit).toHaveBeenCalledWith(0)
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1)
    expect(electron.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['停止后台服务', '退出'] }))
    for (const writer of Object.values(writers)) expect(writer).not.toHaveBeenCalled()
    expect(app.createWindow).not.toHaveBeenCalled()
    expect(readdirSync(state.userDataDir)).toEqual(listing)
    expect(readFileSync(lockPath(), 'utf8')).toBe(record)
    expect(child.exitCode).toBeNull()
  })

  it('with a live daemon and 停止后台服务, stops it and then starts normally under its own lock', async () => {
    const { child } = await liveDaemonHolder()
    const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)) })
    state.dialogResponses = [0]
    const app = startApp()
    await vi.waitFor(() => { expect(app.recovery()).toBeDefined() })
    expect(await exited).toBe(0)
    expect(electron.exit).not.toHaveBeenCalled()
    expect(writers.initDb).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(lockPath(), 'utf8'))).toMatchObject({ pid: process.pid, role: 'app' })
    state.once.get('quit')?.()
  })

  it('with the switch on, takes no userData lock: the daemon owns it', async () => {
    process.env[DAEMON_MODE_ENV] = '1'
    const app = startApp()
    await vi.waitFor(() => { expect(app.recovery()).toBeDefined() })
    expect(existsSync(lockPath())).toBe(false)
    expect(electron.showMessageBox).not.toHaveBeenCalled()
  })
})
