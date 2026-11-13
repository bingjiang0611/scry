import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, shell: {}, dialog: {} }))

const { gateDaemonChannel, installDaemonChannelForwarder } = await import('../daemon-channel-gate')
const { registerWorkspaceHandlers } = await import('./workspace')
const { HomeFileAccess } = await import('../home-file-access')

// Daemon mode: the known projects (recent folders, project records, session cwds) are the
// daemon's userData. The window selection and the known-project file channels still run
// in the App, but each asks the daemon whether a directory is one of its projects
// (workspaceSelection:setCwd) instead of reading the App's own copy of those stores.

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
const OFF = {} as NodeJS.ProcessEnv
type Listener = (event: unknown, ...args: unknown[]) => unknown
type Forwarded = { op: string; method: string; args: unknown[]; read: boolean }
const dirs: string[] = []
const tempDir = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scry-known-daemon-'))); dirs.push(dir); return dir }
const FILE_CHANNELS = ['workspace:resolveFile', 'workspace:readKnown', 'workspace:readPageKnown', 'workspace:openKnownExternal']

describe('known-project channels', () => {
  const undo: Array<() => void> = []
  let saved: string | undefined
  beforeEach(() => { saved = process.env.SCRY_HOST_DAEMON })
  afterEach(() => {
    for (const step of undo.splice(0)) step()
    if (saved === undefined) delete process.env.SCRY_HOST_DAEMON
    else process.env.SCRY_HOST_DAEMON = saved
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function register(env: NodeJS.ProcessEnv, options: {
    daemon?: (call: Forwarded) => Promise<unknown>
    appResolve?: (cwd: string) => string
    window?: string
  } = {}) {
    if (env === ON) process.env.SCRY_HOST_DAEMON = '1'
    else delete process.env.SCRY_HOST_DAEMON
    const handlers = new Map<string, Listener>()
    let selection = options.window
    // Reads the App's own recent folders, projects and session catalog. In daemon mode the
    // daemon owns them, so any call here is a second reader.
    const resolveKnownProjectDirectory = vi.fn(options.appResolve ?? ((_cwd: string): string => { throw new Error('read the userData the daemon owns') }))
    const knownProjectDirectories = vi.fn((): Set<string> => { throw new Error('read the userData the daemon owns') })
    const setCurrentCwd = vi.fn((cwd: string | undefined) => { selection = cwd })
    const invalidateSessionHistoryLoad = vi.fn()
    const openLocalPath = vi.fn(async (_path: string) => undefined)
    const forwarded = vi.fn(options.daemon ?? (async (call: Forwarded) => { throw new Error(`unexpected daemon call ${call.method}`) }))
    if (options.daemon) undo.push(installDaemonChannelForwarder(forwarded))
    registerWorkspaceHandlers({
      handleTrusted: ((channel: string, listener: Listener) => { handlers.set(channel, gateDaemonChannel(channel, listener as never, env)) }) as never,
      getCurrentCwd: () => selection, setCurrentCwd, invalidateSessionHistoryLoad,
      resolveKnownProjectDirectory, homeFileAccess: new HomeFileAccess(tempDir()), knownProjectDirectories, openLocalPath,
      shell: {} as never, dialog: {} as never, getWindow: () => null,
      getTerminalManager: vi.fn(), isShuttingDown: () => false, rendererCanReceive: () => true, assertTrustedIpcEvent: vi.fn(),
      terminalOutput: {} as never, providerRegistry: { invalidateContext: vi.fn() }, providerContextKey: () => 'k',
      resetSessionContext: vi.fn(), dockBadge: { view: vi.fn() }
    })
    const invoke = async (channel: string, ...args: unknown[]) => await handlers.get(channel)!({}, ...args)
    return { handlers, invoke, selection: () => selection, resolveKnownProjectDirectory, knownProjectDirectories, setCurrentCwd, invalidateSessionHistoryLoad, openLocalPath, forwarded }
  }

  // The daemon's answer for a project it knows: its canonical path, as resolveKnownProjectDirectory returns.
  const daemonKnowing = (known: Record<string, string>) => async (call: Forwarded) => {
    if (call.op !== 'workspaceSelection' || call.method !== 'setCwd') throw new Error(`unexpected daemon call ${call.op}:${call.method}`)
    const answer = known[call.args[0] as string]
    if (!answer) throw new Error('工作目录尚未通过 Scry 目录选择器授权')
    return answer
  }

  it('selects the directory the daemon validated, by its canonical path, without reading App stores', async () => {
    const project = tempDir()
    const link = join(tempDir(), 'link')
    symlinkSync(project, link)
    const app = register(ON, { daemon: daemonKnowing({ [link]: project }) })
    await expect(app.invoke('agent:setCwd', link)).resolves.toBe(project)
    expect(app.selection()).toBe(project)
    expect(app.invalidateSessionHistoryLoad).toHaveBeenCalledExactlyOnceWith('workspace changed')
    expect(app.forwarded).toHaveBeenCalledExactlyOnceWith({ op: 'workspaceSelection', method: 'setCwd', args: [link], read: true })
    // Selecting it again changes nothing to invalidate.
    await expect(app.invoke('agent:setCwd', link)).resolves.toBe(project)
    expect(app.invalidateSessionHistoryLoad).toHaveBeenCalledOnce()
    expect(app.resolveKnownProjectDirectory).not.toHaveBeenCalled()
    expect(app.knownProjectDirectories).not.toHaveBeenCalled()
  })

  it('keeps the selection when the daemon refuses, is unavailable or answers out of shape', async () => {
    const window = tempDir(), stranger = tempDir()
    const refusing = register(ON, { window, daemon: daemonKnowing({}) })
    await expect(refusing.invoke('agent:setCwd', stranger)).rejects.toThrow('工作目录尚未通过 Scry 目录选择器授权')
    expect(refusing.selection()).toBe(window)
    for (const step of undo.splice(0)) step()

    // No daemon client: refused by name, never answered from the App's own stores.
    const absent = register(ON, { window })
    await expect(absent.invoke('agent:setCwd', stranger)).rejects.toThrow('daemon_capability_unavailable:agent:setCwd')
    expect(absent.selection()).toBe(window)
    expect(absent.resolveKnownProjectDirectory).not.toHaveBeenCalled()
    for (const step of undo.splice(0)) step()

    for (const answer of [null, 'relative/dir', 42, { cwd: stranger }]) {
      const odd = register(ON, { window, daemon: async () => answer })
      await expect(odd.invoke('agent:setCwd', stranger)).rejects.toThrow('invalid_daemon_response')
      expect(odd.selection()).toBe(window)
      for (const step of undo.splice(0)) step()
    }
  })

  it('clears the selection for an empty or missing directory without asking the daemon', async () => {
    for (const dir of [null, '', '   ', undefined, 42]) {
      const app = register(ON, { window: tempDir(), daemon: daemonKnowing({}) })
      await expect(app.invoke('agent:setCwd', dir)).resolves.toBeNull()
      expect(app.selection()).toBeUndefined()
      expect(app.invalidateSessionHistoryLoad).toHaveBeenCalledOnce()
      expect(app.forwarded).not.toHaveBeenCalled()
      for (const step of undo.splice(0)) step()
    }
  })

  it('applies selections in the order the window sent them, however the daemon replies interleave', async () => {
    const first = tempDir(), second = tempDir()
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
    const app = register(ON, {
      daemon: async (call) => {
        if (call.args[0] === first) await firstHeld
        return call.args[0]
      }
    })
    const a = app.invoke('agent:setCwd', first)
    const b = app.invoke('agent:setCwd', second)
    const c = app.invoke('agent:setCwd', null)
    const d = app.invoke('agent:setCwd', second)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The later calls wait for the first, as main's synchronous handler made them.
    expect(app.setCurrentCwd).not.toHaveBeenCalled()
    releaseFirst()
    await expect(Promise.all([a, b, c, d])).resolves.toEqual([first, second, null, second])
    expect(app.setCurrentCwd.mock.calls).toEqual([[first], [second], [undefined], [second]])
    expect(app.selection()).toBe(second)
  })

  it('goes on with later selections after one is refused', async () => {
    const known = tempDir(), stranger = tempDir()
    const app = register(ON, { daemon: daemonKnowing({ [known]: known }) })
    const refused = app.invoke('agent:setCwd', stranger)
    const accepted = app.invoke('agent:setCwd', known)
    await expect(refused).rejects.toThrow('工作目录尚未通过 Scry 目录选择器授权')
    await expect(accepted).resolves.toBe(known)
    expect(app.selection()).toBe(known)
  })

  it('reads, pages, resolves and opens files of a project the daemon knows, from its canonical path', async () => {
    const project = tempDir()
    writeFileSync(join(project, 'a.txt'), 'hello')
    const link = join(tempDir(), 'link')
    symlinkSync(project, link)
    const app = register(ON, { daemon: daemonKnowing({ [link]: project }) })
    await expect(app.invoke('workspace:readKnown', { cwd: link, path: 'a.txt' })).resolves.toMatchObject({ path: 'a.txt', content: 'hello' })
    await expect(app.invoke('workspace:readPageKnown', { cwd: link, path: 'a.txt' })).resolves.toMatchObject({ path: 'a.txt', content: 'hello', hasMore: false })
    await expect(app.invoke('workspace:resolveFile', { cwd: link, path: 'a.txt' })).resolves.toEqual({ cwd: project, path: 'a.txt', mode: 'text' })
    await expect(app.invoke('workspace:openKnownExternal', { cwd: link, path: 'a.txt' })).resolves.toBe(true)
    expect(app.openLocalPath).toHaveBeenCalledExactlyOnceWith(join(project, 'a.txt'))
    expect(app.forwarded.mock.calls.map(([call]) => call)).toEqual(FILE_CHANNELS.map(() => ({ op: 'workspaceSelection', method: 'setCwd', args: [link], read: true })))
    expect(app.resolveKnownProjectDirectory).not.toHaveBeenCalled()
    expect(app.knownProjectDirectories).not.toHaveBeenCalled()
  })

  it('refuses files outside the daemon known projects, and every file when the daemon cannot answer', async () => {
    const stranger = tempDir()
    writeFileSync(join(stranger, 'a.txt'), 'secret')
    const refusing = register(ON, { daemon: daemonKnowing({}) })
    for (const channel of FILE_CHANNELS) {
      await expect(refusing.invoke(channel, { cwd: stranger, path: 'a.txt' }), channel).rejects.toThrow('工作目录尚未通过 Scry 目录选择器授权')
    }
    expect(refusing.openLocalPath).not.toHaveBeenCalled()
    for (const step of undo.splice(0)) step()

    const absent = register(ON)
    for (const channel of FILE_CHANNELS) {
      await expect(absent.invoke(channel, { cwd: stranger, path: 'a.txt' }), channel).rejects.toThrow('daemon_capability_unavailable:agent:setCwd')
    }
    expect(absent.resolveKnownProjectDirectory).not.toHaveBeenCalled()
    expect(absent.openLocalPath).not.toHaveBeenCalled()
    for (const step of undo.splice(0)) step()

    const odd = register(ON, { daemon: async () => 'relative/dir' })
    for (const channel of FILE_CHANNELS) {
      await expect(odd.invoke(channel, { cwd: stranger, path: 'a.txt' }), channel).rejects.toThrow('invalid_daemon_response')
    }
    // A request that names no directory is refused before the daemon is asked.
    for (const channel of FILE_CHANNELS) {
      await expect(odd.invoke(channel, { cwd: '', path: 'a.txt' }), channel).rejects.toThrow('无效的工作目录')
    }
    expect(odd.forwarded).toHaveBeenCalledTimes(FILE_CHANNELS.length)
  })

  it('answers home read-only targets from the App reference table without asking the daemon', async () => {
    const app = register(ON, { daemon: daemonKnowing({}) })
    await expect(app.invoke('workspace:readKnown', { cwd: 'scry-file:unknown', path: 'a.txt' })).rejects.toThrow()
    expect(app.forwarded).not.toHaveBeenCalled()
  })

  it('keeps the in-process handlers on the App stores while the switch is off', async () => {
    const project = tempDir()
    writeFileSync(join(project, 'a.txt'), 'hello')
    const app = register(OFF, { appResolve: (cwd) => cwd, daemon: daemonKnowing({}) })
    // main's handler answers synchronously, as before: no daemon round trip, no queue.
    const selected = app.handlers.get('agent:setCwd')!({}, project)
    expect(selected).toBe(project)
    expect(app.selection()).toBe(project)
    await expect(app.invoke('workspace:readKnown', { cwd: project, path: 'a.txt' })).resolves.toMatchObject({ content: 'hello' })
    await expect(app.invoke('workspace:readPageKnown', { cwd: project, path: 'a.txt' })).resolves.toMatchObject({ content: 'hello' })
    await expect(app.invoke('workspace:resolveFile', { cwd: project, path: 'a.txt' })).resolves.toEqual({ cwd: project, path: 'a.txt', mode: 'text' })
    await expect(app.invoke('workspace:openKnownExternal', { cwd: project, path: 'a.txt' })).resolves.toBe(true)
    expect(app.resolveKnownProjectDirectory.mock.calls).toEqual([[project], [project], [project], [project], [project]])
    expect(app.forwarded).not.toHaveBeenCalled()

    const refusing = register(OFF, { appResolve: () => { throw new Error('工作目录尚未通过 Scry 目录选择器授权') } })
    expect(() => refusing.handlers.get('agent:setCwd')!({}, project)).toThrow('工作目录尚未通过 Scry 目录选择器授权')
    expect(refusing.handlers.get('agent:setCwd')!({}, null)).toBeNull()
  })
})
