import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteAPI } from '../../shared/desktop-remote'
import { registerTrustedIpcHandler } from '../ipc-trust'
import { registerDesktopClientIpc } from './desktop-client-ipc'

describe('desktop client IPC production trust wrapper', () => {
  it('rejects foreign sender/frame/origin before resolving the privileged client', async () => {
    const listeners = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const ipc = { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { listeners.set(channel, listener) } }
    const origin = 'file:///app/renderer/index.html'
    const mainFrame = { url: origin }
    const sender = { mainFrame, isDestroyed: () => false }
    const window = { webContents: sender, isDestroyed: () => false }
    const list = vi.fn(async () => [])
    const updateSsh = vi.fn(async () => {})
    const client = vi.fn(() => ({ list, updateSsh }) as unknown as DesktopRemoteAPI)
    registerDesktopClientIpc<IpcMainInvokeEvent>(
      (channel, listener) => registerTrustedIpcHandler(ipc, channel, () => window as unknown as BrowserWindow, origin, listener), client
    )
    expect(listeners.size).toBe(21)
    expect(listeners.has('desktopRemote:workbench')).toBe(true)
    expect(listeners.has('desktopRemote:raw')).toBe(false)
    const invoke = async (channel: string, event: unknown, ...args: unknown[]) => listeners.get(channel)!(event as IpcMainInvokeEvent, ...args)
    for (const channel of listeners.keys()) {
      await expect(invoke(channel, { sender: {}, senderFrame: mainFrame })).rejects.toThrow('非可信 renderer')
      await expect(invoke(channel, { sender, senderFrame: { url: origin } })).rejects.toThrow('非可信 renderer')
      mainFrame.url = 'https://untrusted.invalid/'
      await expect(invoke(channel, { sender, senderFrame: mainFrame })).rejects.toThrow('非可信 renderer')
      mainFrame.url = origin
    }
    expect(client).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    await expect(invoke('desktopRemote:list', { sender, senderFrame: mainFrame })).resolves.toEqual([])
    expect(client).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    expect(updateSsh).not.toHaveBeenCalled()
    const ssh = { hostname: 'desktop.example', username: 'scry', port: 22 }
    await expect(invoke('desktopRemote:updateSsh', { sender, senderFrame: mainFrame }, 'saved-id', ssh)).resolves.toBeUndefined()
    expect(updateSsh).toHaveBeenCalledExactlyOnceWith('saved-id', ssh)
  })
})
