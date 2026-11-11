import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, shell: {}, dialog: {} }))

const { gateDaemonChannel, installDaemonChannelForwarder } = await import('../daemon-channel-gate')
const { registerWorkspaceHandlers } = await import('./workspace')

// Daemon mode keeps workspace:openExternal and workspace:trash in the App: the daemon has
// no shell. They stay bound to the window's selection exactly as in process, and read
// nothing the daemon owns: the cross-project fallback asks the daemon for its projects.

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
type Listener = (event: unknown, ...args: unknown[]) => Promise<unknown>
const dirs: string[] = []
const tempDir = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scry-workspace-daemon-'))); dirs.push(dir); return dir }

describe('workspace shell channels in daemon mode', () => {
  const undo: Array<() => void> = []
  let saved: string | undefined
  beforeEach(() => { saved = process.env.SCRY_HOST_DAEMON; process.env.SCRY_HOST_DAEMON = '1' })
  afterEach(() => {
    for (const step of undo.splice(0)) step()
    if (saved === undefined) delete process.env.SCRY_HOST_DAEMON
    else process.env.SCRY_HOST_DAEMON = saved
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function register(window: string, daemon: Record<string, unknown> | undefined) {
    const handlers = new Map<string, Listener>()
    // Every reader of the App's own userData stores: none may run in daemon mode.
    const knownProjectDirectories = vi.fn(() => { throw new Error('read the userData the daemon owns') })
    const resolveKnownProjectDirectory = vi.fn((_cwd: string): string => { throw new Error('read the userData the daemon owns') })
    const openLocalPath = vi.fn(async (_path: string) => undefined)
    const trashItem = vi.fn(async (_path: string) => undefined)
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const forwarded = vi.fn(async ({ method }: { method: string }) => {
      if (!daemon || !(method in daemon)) throw new Error(`unexpected daemon call ${method}`)
      return daemon[method]
    })
    if (daemon) undo.push(installDaemonChannelForwarder(forwarded))
    registerWorkspaceHandlers({
      handleTrusted: ((channel: string, listener: Listener) => { handlers.set(channel, gateDaemonChannel(channel, listener, ON)) }) as never,
      getCurrentCwd: () => window, setCurrentCwd: vi.fn(), invalidateSessionHistoryLoad: vi.fn(),
      resolveKnownProjectDirectory, homeFileAccess: {} as never, knownProjectDirectories, openLocalPath,
      shell: { trashItem } as never, dialog: { showMessageBox } as never, getWindow: () => null,
      getTerminalManager: vi.fn(), isShuttingDown: () => false, rendererCanReceive: () => true, assertTrustedIpcEvent: vi.fn(),
      terminalOutput: {} as never, providerRegistry: { invalidateContext: vi.fn() }, providerContextKey: () => 'k',
      resetSessionContext: vi.fn(), dockBadge: { view: vi.fn() }
    })
    return { handlers, knownProjectDirectories, resolveKnownProjectDirectory, openLocalPath, trashItem, showMessageBox, forwarded }
  }

  it('runs both channels in process, not refused and not sent to the daemon', async () => {
    const window = tempDir()
    writeFileSync(join(window, 'a.txt'), 'a')
    writeFileSync(join(window, 'b.txt'), 'b')
    const app = register(window, {})
    await expect(app.handlers.get('workspace:openExternal')!({}, { cwd: window, path: 'a.txt' })).resolves.toBe(true)
    expect(app.openLocalPath).toHaveBeenCalledExactlyOnceWith(join(window, 'a.txt'))
    await expect(app.handlers.get('workspace:trash')!({}, { cwd: window, path: 'b.txt' })).resolves.toBe(true)
    expect(app.trashItem).toHaveBeenCalledExactlyOnceWith(join(window, 'b.txt'))
    expect(app.forwarded).not.toHaveBeenCalled()
    expect(app.knownProjectDirectories).not.toHaveBeenCalled()
    expect(app.resolveKnownProjectDirectory).not.toHaveBeenCalled()
  })

  it('stays bound to the window selection', async () => {
    const window = tempDir(), other = tempDir()
    writeFileSync(join(other, 'a.txt'), 'a')
    const app = register(window, {})
    // ipcMain.handle turns the handler's synchronous refusal into a rejected invoke.
    const invoke = async (channel: string, request: unknown) => await app.handlers.get(channel)!({}, request)
    await expect(invoke('workspace:openExternal', { cwd: other, path: 'a.txt' })).rejects.toThrow('工作区请求与当前授权目录不一致')
    await expect(invoke('workspace:trash', { cwd: other, path: 'a.txt' })).rejects.toThrow('工作区请求与当前授权目录不一致')
    expect(app.openLocalPath).not.toHaveBeenCalled()
    expect(app.trashItem).not.toHaveBeenCalled()
    expect(existsSync(join(other, 'a.txt'))).toBe(true)
    expect(app.forwarded).not.toHaveBeenCalled()
  })

  it('offers files of the daemon known projects when the window workspace lacks one', async () => {
    const window = tempDir(), project = tempDir(), recent = tempDir()
    mkdirSync(join(project, 'docs'))
    writeFileSync(join(project, 'docs', 'a.md'), 'a')
    const app = register(window, { listProjects: [{ cwd: project, name: 'p', sessions: [] }, { cwd: '', sessions: [] }], recentFolders: [recent] })
    await expect(app.handlers.get('workspace:openExternal')!({}, { cwd: window, path: 'docs/a.md' })).resolves.toBe(true)
    expect(app.showMessageBox).toHaveBeenCalledOnce()
    expect(app.openLocalPath).toHaveBeenCalledExactlyOnceWith(join(project, 'docs', 'a.md'))
    expect(app.forwarded.mock.calls.map(([call]) => call.method).sort()).toEqual(['listProjects', 'recentFolders'])
    expect(app.knownProjectDirectories).not.toHaveBeenCalled()
    expect(app.resolveKnownProjectDirectory).not.toHaveBeenCalled()
  })

  it('refuses the fallback when the daemon cannot say which projects it knows', async () => {
    const window = tempDir()
    const app = register(window, undefined)
    await expect(app.handlers.get('workspace:openExternal')!({}, { cwd: window, path: 'docs/a.md' })).rejects.toThrow('daemon_capability_unavailable:agent:listProjects')
    expect(app.showMessageBox).not.toHaveBeenCalled()
    expect(app.openLocalPath).not.toHaveBeenCalled()
    expect(app.knownProjectDirectories).not.toHaveBeenCalled()
  })
})
