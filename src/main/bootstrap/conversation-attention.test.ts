import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationAttentionKey } from '../../shared/session-attention'
import { ConversationStore } from '../conversation-store'
import { DockBadgeState } from '../dock-badge'
import { registerTrustedIpcHandler } from '../ipc-trust'
import { registerConversationAttention } from './conversation-attention'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'scry-attention-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

async function fixture() {
  const cwd = join(directory, 'workspace')
  await mkdir(cwd)
  const store = new ConversationStore(join(directory, 'userData'))
  const first = await store.create(cwd)
  const second = await store.create(cwd)
  const handlers = new Map<string, Handler>()
  const mainFrame = { url: 'file:///test/renderer/index.html' }
  const webContents = { mainFrame, isDestroyed: () => false }
  let focused = true
  const window = { webContents, isDestroyed: () => false, isFocused: () => focused } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const setCount = vi.fn()
  const badge = new DockBadgeState(setCount)
  const clearLegacyFocus = vi.fn()
  const historyController = new AbortController()
  const invalidateHistory = vi.fn((reason: string) => historyController.abort(new Error(reason)))
  const authorize = vi.fn((path: string) => {
    if (path !== first.cwd) throw new Error('unknown project')
    return path
  })
  const reset = registerConversationAttention({
    handleTrusted: (channel, listener) => registerTrustedIpcHandler(
      { handle: (name, handler) => { handlers.set(name, handler) } }, channel,
      () => window, mainFrame.url, listener
    ),
    conversationStore: () => store,
    resolveKnownProjectDirectory: authorize,
    getWindow: () => window,
    clearLegacyFocus,
    invalidateSessionHistoryLoad: invalidateHistory,
    dockBadge: badge
  })
  const invoke = async (id: unknown, sender = event) => handlers.get('conversation:setViewed')!(sender, id)
  const mark = (id: string) => badge.markAttention(conversationAttentionKey(id), {
    windowFocused: false, sessionViewed: false, needsAttention: true
  })
  return { store, first, second, badge, invoke, mark, event, mainFrame, authorize, clearLegacyFocus,
    reset, historyController, invalidateHistory,
    setFocused: (value: boolean) => { focused = value } }
}

describe('managed conversation attention IPC', () => {
  it('opening a persisted conversation clears only its own attention; background history reads do not', async () => {
    const f = await fixture()
    f.mark(f.first.id); f.mark(f.second.id)
    await f.store.read(f.first.id)
    expect(f.badge.count).toBe(2)
    await f.invoke(f.first.id)
    expect(f.badge.snapshot().unreadSessionKeys).toEqual([conversationAttentionKey(f.second.id)])
    expect(f.badge.isViewed(conversationAttentionKey(f.first.id))).toBe(true)
    expect(f.clearLegacyFocus).toHaveBeenCalledOnce()
    await f.invoke(null)
    expect(f.badge.isViewed(conversationAttentionKey(f.first.id))).toBe(false)
    expect(f.badge.count).toBe(1)
  })

  it('does not acknowledge a background window; focus reconciles the displayed conversation', async () => {
    const f = await fixture()
    f.mark(f.first.id)
    f.setFocused(false)
    await f.invoke(f.first.id)
    expect(f.badge.count).toBe(1)
    f.setFocused(true)
    f.badge.focusWindow()
    expect(f.badge.count).toBe(0)
  })

  it('ignores a late previous selection after switching or leaving', async () => {
    const f = await fixture()
    const read = f.store.read.bind(f.store)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.store, 'read').mockImplementation(async id => {
      if (id === f.first.id) await gate
      return read(id)
    })
    f.mark(f.first.id); f.mark(f.second.id)
    const previous = f.invoke(f.first.id)
    await f.invoke(f.second.id)
    release(); await previous
    expect(f.badge.snapshot().unreadSessionKeys).toEqual([conversationAttentionKey(f.first.id)])
    expect(f.badge.isViewed(conversationAttentionKey(f.second.id))).toBe(true)
    await f.invoke(null)
    expect(f.badge.isViewed(conversationAttentionKey(f.second.id))).toBe(false)
  })

  it('cancels an older native history load before it can replace the managed viewed identity', async () => {
    const f = await fixture()
    let finishNativeRead!: () => void
    const gate = new Promise<void>(resolve => { finishNativeRead = resolve })
    const nativeLoad = (async () => {
      await gate
      // The production history loader checks this signal before publishing its view.
      f.historyController.signal.throwIfAborted()
      f.badge.view('native-session', true)
    })()
    await f.invoke(f.first.id)
    const rejected = expect(nativeLoad).rejects.toThrow('managed conversation selected')
    finishNativeRead(); await rejected
    expect(f.badge.isViewed(conversationAttentionKey(f.first.id))).toBe(true)
  })

  it('renderer loss revokes the view and late requests without deleting unread keys', async () => {
    const f = await fixture()
    await f.invoke(f.first.id)
    f.mark(f.second.id)
    f.reset()
    expect(f.badge.isViewed(conversationAttentionKey(f.first.id))).toBe(false)
    expect(f.badge.snapshot().unreadSessionKeys).toEqual([conversationAttentionKey(f.second.id)])
    f.mark(f.first.id)
    expect(f.badge.count).toBe(2)

    const read = f.store.read.bind(f.store)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.store, 'read').mockImplementation(async id => { await gate; return read(id) })
    const pending = f.invoke(f.first.id)
    f.reset()
    release(); await pending
    expect(f.badge.isViewed(conversationAttentionKey(f.first.id))).toBe(false)
    expect(f.badge.count).toBe(2)
  })

  it('rejects untrusted senders, subframes and origins before reading the ledger', async () => {
    const f = await fixture()
    const read = vi.spyOn(f.store, 'read')
    const senders = [
      { ...f.event, sender: { mainFrame: f.mainFrame } },
      { ...f.event, senderFrame: { url: f.mainFrame.url } }
    ]
    for (const sender of senders) {
      await expect(f.invoke(f.first.id, sender as unknown as IpcMainInvokeEvent)).rejects.toThrow()
    }
    f.mainFrame.url = 'https://untrusted.invalid'
    await expect(f.invoke(f.first.id)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(f.clearLegacyFocus).not.toHaveBeenCalled()
  })

  it('rejects malformed, missing and unauthorized conversations without clearing reminders', async () => {
    const f = await fixture()
    f.mark(f.first.id)
    await expect(f.invoke({ id: f.first.id })).rejects.toThrow()
    await expect(f.invoke('../outside')).rejects.toThrow()
    await expect(f.invoke('00000000-0000-4000-8000-000000000000')).rejects.toThrow()
    f.authorize.mockImplementation(() => { throw new Error('unknown project') })
    await expect(f.invoke(f.first.id)).rejects.toThrow('unknown project')
    expect(f.badge.count).toBe(1)
    expect(f.clearLegacyFocus).not.toHaveBeenCalled()
  })
})
