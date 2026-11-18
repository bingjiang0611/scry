import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateDaemonChannel, installDaemonChannelForwarder } from '../daemon-channel-gate'
import { installProjectDaemonWindow, installProviderContextWindowCwd } from './project-daemon'

// Daemon mode: the folder and launcher pickers, the Pi failure dialog and the window's
// workspace selection stay in this window. What the daemon is sent comes from the
// picker, never from the renderer: a renderer that names a path itself must not get
// that path remembered as a project (it is the daemon's authorization input).

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
type Call = { op: string; method: string; args: unknown[]; read: boolean }

function wire(options: { folder?: string | null; launcher?: string | null; cwd?: string }, reply: (call: Call) => unknown) {
  const undo: Array<() => void> = []
  let windowCwd: string | undefined = options.cwd
  const window = {
    pickFolder: vi.fn(async () => options.folder ?? null),
    pickPiLauncher: vi.fn(async () => options.launcher ?? null),
    notifyPiFailure: vi.fn(async (_message: string) => undefined),
    windowCwd: () => windowCwd,
    applyChosenFolder: vi.fn((dir: string) => { windowCwd = dir })
  }
  undo.push(installProjectDaemonWindow(window))
  undo.push(installProviderContextWindowCwd(() => windowCwd))
  const forwarder = vi.fn(async (call: Call) => reply(call))
  undo.push(installDaemonChannelForwarder(forwarder))
  const channel = (name: string) => gateDaemonChannel(name, vi.fn(), ON) as unknown as (event: unknown, ...args: unknown[]) => Promise<any>
  return { window, forwarder, channel, windowCwd: () => windowCwd, dispose: () => { for (const step of undo.splice(0)) step() } }
}

describe('project and workspace selection in daemon mode', () => {
  let dispose: (() => void) | undefined
  afterEach(() => { dispose?.(); dispose = undefined })

  it('sends the folder the picker chose, never one the renderer named, and selects it after the daemon answers', async () => {
    const chose = wire({ folder: '/picked/link', cwd: '/before' }, () => '/picked/real')
    dispose = chose.dispose
    await expect(chose.channel('agent:chooseFolder')({}, '/etc')).resolves.toBe('/picked/real')
    expect(chose.forwarder).toHaveBeenCalledWith({ op: 'workspaceSelection', method: 'chooseFolder', args: ['/picked/link'], read: false })
    // The window selects what the daemon validated and remembered, not the picker's spelling.
    expect(chose.window.applyChosenFolder).toHaveBeenCalledWith('/picked/real')
    expect(chose.windowCwd()).toBe('/picked/real')
  })

  it('asks the daemon nothing when the picker is cancelled', async () => {
    const cancelled = wire({ folder: null, cwd: '/before' }, () => '/never')
    dispose = cancelled.dispose
    await expect(cancelled.channel('agent:chooseFolder')({}, '/etc')).resolves.toBeNull()
    expect(cancelled.forwarder).not.toHaveBeenCalled()
    expect(cancelled.windowCwd()).toBe('/before')
  })

  it('keeps the window selection when the daemon refuses or answers nonsense', async () => {
    const refused = wire({ folder: '/picked', cwd: '/before' }, () => { throw new Error('工作目录不存在或不是文件夹') })
    dispose = refused.dispose
    await expect(refused.channel('agent:chooseFolder')({})).rejects.toThrow('工作目录不存在或不是文件夹')
    expect(refused.windowCwd()).toBe('/before')
    refused.dispose()

    const odd = wire({ folder: '/picked', cwd: '/before' }, () => 'relative')
    dispose = odd.dispose
    await expect(odd.channel('agent:chooseFolder')({})).rejects.toThrow('invalid_daemon_response')
    expect(odd.window.applyChosenFolder).not.toHaveBeenCalled()
  })

  it('adds a Pi profile from the launcher the picker chose, probed in the window workspace', async () => {
    const agent = { id: 'pi:0123456789abcdef', name: 'Pi', bin: 'pi', path: '/bin/pi' }
    const added = wire({ launcher: '/bin/pi', cwd: '/w' }, () => ({ status: 'added', agent }))
    dispose = added.dispose
    await expect(added.channel('agent:addPiProfile')({}, '/renderer/pi')).resolves.toEqual(agent)
    expect(added.forwarder).toHaveBeenCalledWith({ op: 'piProfile', method: 'addPiProfile', args: ['/bin/pi', '/w'], read: false })
    expect(added.window.notifyPiFailure).not.toHaveBeenCalled()
    added.dispose()

    // No workspace selected: the daemon probes in the home directory, as main did.
    const homeless = wire({ launcher: '/bin/pi' }, () => ({ status: 'added', agent }))
    dispose = homeless.dispose
    await homeless.channel('agent:addPiProfile')({})
    expect(homeless.forwarder).toHaveBeenCalledWith(expect.objectContaining({ args: ['/bin/pi', null] }))
  })

  it('shows the handshake failure in this window and answers null', async () => {
    const failed = wire({ launcher: '/bin/not-pi', cwd: '/w' }, () => ({ status: 'failed', message: 'Pi RPC 握手失败' }))
    dispose = failed.dispose
    await expect(failed.channel('agent:addPiProfile')({})).resolves.toBeNull()
    expect(failed.window.notifyPiFailure).toHaveBeenCalledWith('Pi RPC 握手失败')
    failed.dispose()

    const cancelled = wire({ launcher: null }, () => ({ status: 'added' }))
    dispose = cancelled.dispose
    await expect(cancelled.channel('agent:addPiProfile')({})).resolves.toBeNull()
    expect(cancelled.forwarder).not.toHaveBeenCalled()
    cancelled.dispose()

    const odd = wire({ launcher: '/bin/pi' }, () => ({ status: 'maybe' }))
    dispose = odd.dispose
    await expect(odd.channel('agent:addPiProfile')({})).rejects.toThrow('invalid_daemon_response')
  })

  it('invalidates the window workspace context when the renderer names no cwd, as main did', async () => {
    const filled = wire({ cwd: '/w' }, () => true)
    dispose = filled.dispose
    await expect(filled.channel('agent:invalidateProviderContext')({}, { providerId: 'codex' })).resolves.toBe(true)
    expect(filled.forwarder).toHaveBeenLastCalledWith({ op: 'providerContext', method: 'invalidateProviderContext', args: [{ providerId: 'codex', cwd: '/w' }], read: false })
    await filled.channel('agent:invalidateProviderContext')({}, { providerId: 'codex', cwd: '/other' })
    expect(filled.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ args: [{ providerId: 'codex', cwd: '/other' }] }))
    // A new session without a cwd resets the window's context in main too
    // (resetProviderSession falls back to currentCwd); the daemon has no selection.
    await filled.channel('agent:newSession')({}, { providerId: 'codex' })
    expect(filled.forwarder).toHaveBeenLastCalledWith({ op: 'providerContext', method: 'newSession', args: [{ providerId: 'codex', cwd: '/w' }], read: false })
  })

  it('forwards project store writes with the renderer arguments and never replays them', async () => {
    const writes = wire({}, () => true)
    dispose = writes.dispose
    await writes.channel('agent:renameProject')({}, '/w', 'Name')
    expect(writes.forwarder).toHaveBeenLastCalledWith({ op: 'projectStore', method: 'renameProject', args: ['/w', 'Name'], read: false })
    for (const channel of ['agent:setProjectPinned', 'agent:removeProject', 'agent:removeRecentFolder', 'agent:removePiProfile', 'workspaceSelection:inspectStart']) {
      await writes.channel(channel)({}, 'x')
      expect(writes.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ read: false }))
    }
    for (const channel of ['workspaceSelection:read', 'workspaceSelection:validateBranch']) {
      await writes.channel(channel)({}, {})
      expect(writes.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'workspaceSelection', read: true }))
    }
  })
})
