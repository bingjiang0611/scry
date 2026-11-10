import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The App's real startup sequence (registerAppLifecycle) with Electron and every writer
// replaced by a spy: the question is which userData writers main starts, not what they do.
const ready = { resolve: (): void => undefined }
vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>((resolve) => { ready.resolve = resolve }),
    getPath: () => '/nonexistent/scry-test-userdata',
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/nonexistent/scry-test-app',
    isPackaged: false,
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
    getAppMetrics: () => []
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
const writers = vi.hoisted(() => ({
  initDb: vi.fn(),
  runStartupRecovery: vi.fn(async () => undefined),
  configureStorage: vi.fn()
}))
vi.mock('../db', () => ({ initDb: writers.initDb, setBillingEnvProvider: vi.fn() }))
vi.mock('./startup-recovery', () => ({ runStartupRecovery: writers.runStartupRecovery }))
vi.mock('../storage-paths', () => ({ configureStorage: writers.configureStorage }))
vi.mock('../performance-recording', () => ({
  startPerformanceRecording: vi.fn(async () => undefined), stopPerformanceRecording: vi.fn(async () => undefined),
  recordResourcePerformance: vi.fn(), recordStartupPerformance: vi.fn(), performanceRecordingHealth: () => ({})
}))
vi.mock('../performance-resource-monitor', () => ({ startPerformanceResourceMonitor: () => ({ stop: vi.fn() }) }))
vi.mock('../provider-event-log', () => ({ configureProviderEventLog: vi.fn() }))
vi.mock('../run-stage-timing', () => ({ configureRunStageTiming: vi.fn() }))
vi.mock('../claude-locate', () => ({ packagedRecorderCliPath: () => undefined, warmShellEnv: vi.fn(async () => undefined), shellEnv: vi.fn() }))
vi.mock('./remote-host', () => ({ startRemoteHostIfEnabled: vi.fn(async () => undefined) }))

const { registerAppLifecycle } = await import('./app-lifecycle')
const { DAEMON_MODE_ENV } = await import('../daemon-channel-gate')

const original = process.env[DAEMON_MODE_ENV]
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  if (original === undefined) delete process.env[DAEMON_MODE_ENV]
  else process.env[DAEMON_MODE_ENV] = original
})

async function startApp(): Promise<{ recovery: Promise<void> | undefined }> {
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
  ready.resolve()
  await vi.waitFor(() => { expect(recovery).toBeDefined() })
  expect(createWindow).toHaveBeenCalledTimes(1)
  return { recovery }
}

describe('App startup writers of daemon-owned userData', () => {
  it('with the switch on, main neither opens scry.db nor runs startup recovery: the daemon does both', async () => {
    process.env[DAEMON_MODE_ENV] = '1'
    const { recovery } = await startApp()
    expect(writers.initDb).not.toHaveBeenCalled()
    expect(writers.runStartupRecovery).not.toHaveBeenCalled()
    // Handlers that wait on recovery must not hang on a recovery main never runs.
    await expect(recovery).resolves.toBeUndefined()
    // Path configuration writes nothing and other App-owned readers still need it.
    expect(writers.configureStorage).toHaveBeenCalledTimes(1)
  })

  it('with the switch off, startup is unchanged: main opens scry.db and runs recovery', async () => {
    delete process.env[DAEMON_MODE_ENV]
    await startApp()
    expect(writers.initDb).toHaveBeenCalledTimes(1)
    expect(writers.runStartupRecovery).toHaveBeenCalledTimes(1)
  })
})
