import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from './ipc-trust'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

describe('trusted main IPC registration', () => {
  it.each(['workspace:list', 'workspace:resolveFile', 'agent:llmPerformanceSummary', 'agent:llmPerformanceHistory', 'agent:steer', 'app:copyText'])('rejects wrong sender, subframe, and origin before %s runs', async (channel) => {
    let registered: Handler | undefined
    const ipcMain = {
      handle: (_channel: string, listener: Handler) => { registered = listener }
    }
    const trustedOrigin = 'file:///app/renderer/index.html'
    const mainFrame = { url: trustedOrigin }
    const trustedWebContents = {
      mainFrame,
      isDestroyed: () => false
    }
    const trustedWindow = {
      webContents: trustedWebContents,
      isDestroyed: () => false
    }
    const listener = vi.fn(() => 'privileged result')

    registerTrustedIpcHandler(
      ipcMain,
      channel,
      () => trustedWindow as unknown as BrowserWindow,
      trustedOrigin,
      listener
    )
    expect(registered).toBeDefined()

    const invoke = async (event: Record<string, unknown>): Promise<unknown> => registered!(event as unknown as IpcMainInvokeEvent)
    const wrongSender = { mainFrame, isDestroyed: () => false }
    const subframe = { url: trustedOrigin }
    await expect(invoke({ sender: trustedWebContents, senderFrame: mainFrame })).resolves.toBe('privileged result')
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()
    await expect(invoke({ sender: wrongSender, senderFrame: mainFrame })).rejects.toThrow('非可信 renderer')
    await expect(invoke({ sender: trustedWebContents, senderFrame: subframe })).rejects.toThrow('非可信 renderer')
    mainFrame.url = 'https://evil.invalid/renderer.html'
    await expect(invoke({ sender: trustedWebContents, senderFrame: mainFrame })).rejects.toThrow('非可信 renderer')
    expect(listener).not.toHaveBeenCalled()
  })
})
