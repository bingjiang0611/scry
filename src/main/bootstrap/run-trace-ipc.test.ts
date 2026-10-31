import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from '../ipc-trust'
import { registerRunTraceHandlers } from './run-trace-ipc'
import type { RunTraceRouter } from '../run-trace-router'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/**
 * 生产 wrapper + 真实 handler：不受信的 sender / frame / origin 或畸形 payload 必须在
 * 触达 router 之前被拒绝。断言特权 listener **没有**执行，而不只是「返回了错误」。
 */
function fixture() {
  const handlers = new Map<string, Handler>()
  const mainFrame = { url: 'file:///test/renderer/index.html' }
  const webContents = { mainFrame, isDestroyed: () => false, send: vi.fn() }
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const router = {
    subscribe: vi.fn(() => ({ status: 'unavailable' as const })),
    unsubscribe: vi.fn(() => true),
    ack: vi.fn(() => true),
    resync: vi.fn(() => ({ status: 'missing' as const })),
    confirmResync: vi.fn(() => true),
    setLegacyDemand: vi.fn(() => true)
  }
  registerRunTraceHandlers(
    (channel, listener) => registerTrustedIpcHandler(
      { handle: (name, handler) => { handlers.set(name, handler) } },
      channel, () => window, mainFrame.url, listener
    ),
    router as unknown as RunTraceRouter,
    runId => runId === 'run-1'
  )
  const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(event, ...args)
  return { handlers, router, invoke, webContents, mainFrame }
}

const trustedChannels = ['runTraces:setLegacyDemand', 'runTraces:subscribe', 'runTraces:unsubscribe', 'runTraces:ack', 'runTraces:resync', 'runTraces:confirm']

describe('run trace IPC trust gate', () => {
  it('registers every channel through the production wrapper', () => {
    const { handlers } = fixture()
    for (const channel of trustedChannels) expect(handlers.has(channel)).toBe(true)
  })

  it('only admits a focused legacy demand, validates both arguments and accepts stale-release checks without refocusing', () => {
    const { invoke, router } = fixture()
    expect(invoke('runTraces:setLegacyDemand', 'run-1', true)).toBe(true)
    expect(router.setLegacyDemand).toHaveBeenCalledWith('run-1', true)
    router.setLegacyDemand.mockClear()
    for (const [id, demanded] of [[null, true], ['', true], ['x'.repeat(129), true], ['run-1', 1], ['run-1', null], ['other-run', true]]) {
      expect(invoke('runTraces:setLegacyDemand', id, demanded)).toBe(false)
    }
    expect(router.setLegacyDemand).not.toHaveBeenCalled()
    expect(invoke('runTraces:setLegacyDemand', 'other-run', false)).toBe(true)
    expect(router.setLegacyDemand).toHaveBeenCalledWith('other-run', false)
  })

  it('forwards validated payloads to the router', () => {
    const { invoke, router } = fixture()
    expect(invoke('runTraces:subscribe', { runId: 'run-1', subscriptionId: 'sub-run-1' })).toEqual({ status: 'unavailable' })
    expect(router.subscribe).toHaveBeenCalledWith({ runId: 'run-1', subscriptionId: 'sub-run-1' })
    expect(invoke('runTraces:unsubscribe', 'sub-run-1')).toBe(true)
    expect(router.unsubscribe).toHaveBeenCalledWith('sub-run-1')
    expect(invoke('runTraces:ack', { subscriptionId: 'sub-run-1', receipt: { generation: 0, batchId: 3, bytes: 64 } })).toBe(true)
    expect(router.ack).toHaveBeenCalledWith('sub-run-1', { generation: 0, batchId: 3, bytes: 64 })
    expect(invoke('runTraces:resync', 'sub-run-1')).toEqual({ status: 'missing' })
    expect(router.resync).toHaveBeenCalledWith('sub-run-1')
    expect(invoke('runTraces:confirm', { subscriptionId: 'sub-run-1', resyncId: 2 })).toBe(true)
    expect(router.confirmResync).toHaveBeenCalledWith('sub-run-1', 2)
  })

  it('rejects a malformed re-alignment confirmation instead of clearing degradation', () => {
    const { invoke, router } = fixture()
    const invalid = [
      undefined,
      { subscriptionId: 'sub-run-1' },
      { subscriptionId: 'sub-run-1', resyncId: 0 },
      { subscriptionId: 'sub-run-1', resyncId: -1 },
      { subscriptionId: 'sub-run-1', resyncId: 1.5 },
      { subscriptionId: 'sub-run-1', resyncId: '1' },
      { resyncId: 1 }
    ]
    for (const payload of invalid) expect(() => invoke('runTraces:confirm', payload)).toThrow('run trace 确认无效')
    expect(router.confirmResync).not.toHaveBeenCalled()
  })

  it('refuses a foreign sender before the privileged listener runs', () => {
    const { handlers, router, mainFrame } = fixture()
    const foreignFrame = { url: 'https://evil.example/index.html' }
    // 非本窗口的 sender，以及被篡改的 frame，都必须先被拦住。
    for (const event of [
      { sender: { id: 2, mainFrame, isDestroyed: () => false }, senderFrame: mainFrame },
      { sender: { id: 1, mainFrame: foreignFrame, isDestroyed: () => false }, senderFrame: foreignFrame }
    ]) {
      for (const channel of trustedChannels) {
        expect(() => handlers.get(channel)!(event as unknown as IpcMainInvokeEvent, 'sub-run-1'))
          .toThrow('拒绝来自非可信 renderer 的 IPC 调用')
      }
    }
    expect(router.subscribe).not.toHaveBeenCalled()
    expect(router.unsubscribe).not.toHaveBeenCalled()
    expect(router.ack).not.toHaveBeenCalled()
    expect(router.resync).not.toHaveBeenCalled()
    expect(router.confirmResync).not.toHaveBeenCalled()
    expect(router.setLegacyDemand).not.toHaveBeenCalled()
  })

  it('rejects a malformed acknowledgement instead of releasing credit', () => {
    const { invoke, router } = fixture()
    const invalid = [
      undefined,
      { subscriptionId: 'sub-run-1' },
      { subscriptionId: 'sub-run-1', receipt: { generation: -1, batchId: 0, bytes: 0 } },
      { subscriptionId: 'sub-run-1', receipt: { generation: 0, batchId: 1.5, bytes: 0 } },
      { subscriptionId: 'sub-run-1', receipt: { generation: 0, batchId: 0, bytes: 'big' } }
    ]
    for (const payload of invalid) expect(() => invoke('runTraces:ack', payload)).toThrow('run trace 回执无效')
    expect(router.ack).not.toHaveBeenCalled()
  })

  it('refuses an untrusted renderer origin even when the sender object matches', () => {
    const handlers = new Map<string, Handler>()
    const mainFrame = { url: 'https://evil.example/index.html' }
    const webContents = { mainFrame, isDestroyed: () => false, send: vi.fn() }
    const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
    const router = { subscribe: vi.fn(), unsubscribe: vi.fn(), ack: vi.fn(), resync: vi.fn(), confirmResync: vi.fn() }
    registerRunTraceHandlers(
      (channel, listener) => registerTrustedIpcHandler(
        { handle: (name, handler) => { handlers.set(name, handler) } },
        channel, () => window, 'file:///test/renderer/index.html', listener
      ),
      router as unknown as RunTraceRouter,
      () => false
    )
    const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
    for (const channel of trustedChannels) expect(() => handlers.get(channel)!(event, 'sub-run-1')).toThrow()
    expect(router.subscribe).not.toHaveBeenCalled()
  })
})
