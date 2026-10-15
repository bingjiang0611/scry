import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from './ipc-trust'
import { setPerformanceRecordingSink, type PerformanceSample } from './performance-timing'

afterEach(() => setPerformanceRecordingSink(null))

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

describe('trusted main IPC registration', () => {
  it('records real handler settlement and rejections, never payloads or rejected senders', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    const mainFrame = { url: 'file:///app/renderer/index.html' }
    const sender = { mainFrame }
    const win = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
    const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
    let handler: Handler = () => { throw new Error('unregistered') }
    let reject: (reason: Error) => void = () => {}
    const pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise })
    const privileged = vi.fn(() => pending)
    registerTrustedIpcHandler({ handle: (_channel, listener) => { handler = listener } }, 'workspace:read', () => win, mainFrame.url, privileged)
    expect(() => handler({ ...event, sender: {} } as IpcMainInvokeEvent)).toThrow('非可信 renderer')
    expect(privileged).not.toHaveBeenCalled()
    expect(samples).toEqual([])
    const result = handler(event, { path: '/secret/path', prompt: 'SECRET' })
    expect(samples).toEqual([])
    const error = new Error('SECRET backend error')
    reject(error)
    await expect(result).rejects.toBe(error)
    expect(samples).toMatchObject([{ name: 'ipc.workspace:read', outcome: 'error' }])
    expect(JSON.stringify(samples)).not.toContain('SECRET')
    expect(JSON.stringify(samples)).not.toContain('/secret/path')

    registerTrustedIpcHandler({ handle: (_channel, listener) => { handler = listener } }, 'workspace:write', () => win, mainFrame.url, () => ({ ok: false }))
    expect(handler(event)).toEqual({ ok: false })
    expect(samples[1].outcome).toBe('completed') // handler settled, not business success
    registerTrustedIpcHandler({ handle: (_channel, listener) => { handler = listener } }, 'workspace:write', () => win, mainFrame.url, () => { throw error })
    expect(() => handler(event)).toThrow(error)
    expect(samples[2].outcome).toBe('error')
  })
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
