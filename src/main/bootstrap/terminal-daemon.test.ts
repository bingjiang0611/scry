import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateDaemonChannel, installDaemonChannelForwarder, installDaemonRequestForwarder } from '../daemon-channel-gate'
import { detachDaemonTerminalRenderer, installTerminalDaemonWindow, shutdownDaemonTerminals } from './terminal-daemon'

// P3-terminal, App side: the daemon runs main's terminal handlers without a window, so
// this window names its workspace on every call and refuses where main's handler did
// while it cannot receive output.

const ON = { SCRY_HOST_DAEMON: '1' } as NodeJS.ProcessEnv
type Call = { op: string; method: string; args: unknown[]; read: boolean }

function wire(state: { cwd?: string; canReceive?: boolean; shuttingDown?: boolean }, reply: (call: Call) => unknown = () => true) {
  const undo: Array<() => void> = []
  undo.push(installTerminalDaemonWindow({
    windowCwd: () => state.cwd,
    rendererCanReceive: () => state.canReceive ?? true,
    isShuttingDown: () => state.shuttingDown ?? false
  }))
  const forwarder = vi.fn(async (call: Call) => reply(call))
  undo.push(installDaemonChannelForwarder(forwarder))
  const requests = vi.fn(async (_request: Record<string, unknown>, _read: boolean) => ({ terminal: true }))
  undo.push(installDaemonRequestForwarder(requests))
  const channel = (name: string) => gateDaemonChannel(name, vi.fn(), ON) as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>
  return { forwarder, requests, channel, dispose: () => { for (const step of undo.splice(0)) step() } }
}

describe('terminal in daemon mode, window side', () => {
  let dispose: (() => void) | undefined
  afterEach(() => { dispose?.(); dispose = undefined })

  it('sends exactly the renderer arguments main took, then the window workspace', async () => {
    const w = wire({ cwd: '/w' })
    dispose = w.dispose
    await w.channel('terminal:write')({}, { id: 'terminal-1', ownershipEpoch: 1, data: 'ls' }, 'extra')
    expect(w.forwarder).toHaveBeenLastCalledWith({ op: 'terminal', method: 'write', args: [{ id: 'terminal-1', ownershipEpoch: 1, data: 'ls' }, '/w'], read: false })
    // `active` takes nothing from the renderer; a missing argument keeps its place.
    await w.channel('terminal:active')({})
    expect(w.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'active', args: ['/w'] }))
    await w.channel('terminal:recordingList')({})
    expect(w.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'recordingList', args: [undefined, '/w'] }))
  })

  it('names no workspace when the window has none, as main\'s handler saw it', async () => {
    const w = wire({})
    dispose = w.dispose
    await w.channel('terminal:start')({}, { cwd: null, cols: 80, rows: 24 })
    expect(w.forwarder).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'start', args: [{ cwd: null, cols: 80, rows: 24 }, null] }))
  })

  it('refuses before sending where main refused without a window, and only there', async () => {
    const state = { cwd: '/w', canReceive: false }
    const w = wire(state)
    dispose = w.dispose
    for (const name of ['terminal:start', 'terminal:attach', 'terminal:write', 'terminal:resize', 'terminal:close']) {
      await expect(w.channel(name)({}, { id: 'terminal-1', ownershipEpoch: 1 }), name).rejects.toThrow('终端窗口已关闭')
    }
    expect(w.forwarder).not.toHaveBeenCalled()
    // ready/ack/active/recordings never asked about the window in main either.
    await w.channel('terminal:ack')({}, { id: 'terminal-1', ownershipEpoch: 1, bytes: 10 })
    expect(w.forwarder).toHaveBeenCalledTimes(1)
  })

  it('gives up a terminal it started if the window went away meanwhile', async () => {
    const state = { cwd: '/w', canReceive: true }
    const w = wire(state, () => { state.canReceive = false; return { id: 'terminal-1', ownershipEpoch: 1 } })
    dispose = w.dispose
    await expect(w.channel('terminal:start')({}, { cwd: '/w', cols: 80, rows: 24 })).rejects.toThrow('终端窗口已关闭')
    expect(w.requests).toHaveBeenCalledWith({ op: 'terminalFeed', method: 'detachRenderer' }, true)
  })

  it('tells the daemon when the renderer detaches and when the App quits, only in daemon mode', async () => {
    await detachDaemonTerminalRenderer()
    await shutdownDaemonTerminals()
    const w = wire({ cwd: '/w' })
    dispose = w.dispose
    expect(w.requests).not.toHaveBeenCalled()
    await detachDaemonTerminalRenderer()
    await shutdownDaemonTerminals()
    expect(w.requests.mock.calls.map(([request]) => request)).toEqual([
      { op: 'terminalFeed', method: 'detachRenderer' }, { op: 'terminalFeed', method: 'shutdown' }
    ])
  })
})
