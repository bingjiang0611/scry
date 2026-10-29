import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from '../ipc-trust'
import { registerConversationHandlers } from './conversation'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const conversationId = '11111111-2222-4333-8444-555555555555'

/**
 * Production wrapper plus the real handler bodies: an unauthorized source or an
 * untrusted renderer must be refused before the privileged service is reached.
 */
function fixture() {
  const handlers = new Map<string, Handler>()
  const mainFrame = { url: 'file:///test/renderer/index.html' }
  const webContents = { mainFrame, isDestroyed: () => false, send: vi.fn() }
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const unexpected = (): never => { throw new Error('unexpected dependency') }
  const conversations = {
    previewSideChat: vi.fn(async () => ({ throughOrdinal: 1 })),
    createSideChat: vi.fn(async () => ({ id: conversationId })),
    listSideChats: vi.fn(async () => ({ total: 0, items: [] })),
    findSideChatCommand: vi.fn(async (_source: unknown, commandId: string) => ({ commandId, status: 'not-found' })),
    readSideChatSnapshot: vi.fn(async () => ({ conversationId, items: [], byteLimit: 262144 }))
  }
  const conversationStore = { read: vi.fn(async (_id: string) => undefined as unknown) }
  registerConversationHandlers({
    handleTrusted: (channel, listener) => registerTrustedIpcHandler(
      { handle: (name, handler) => { handlers.set(name, handler) } },
      channel, () => window, mainFrame.url, listener
    ),
    resolveKnownProjectDirectory: cwd => {
      if (cwd !== '/workspace') throw new Error('未知项目目录')
      return cwd
    },
    providerContextKey: unexpected,
    contextAdmission: { run: unexpected, runMany: unexpected },
    getStartupManagedRecovery: async () => {},
    appSessionStore: unexpected,
    conversationStore: () => conversationStore as never,
    getRuns: unexpected,
    providerRegistry: { continuationKey: unexpected },
    providerSessionKey: unexpected,
    assertLegacyConversationWriteAllowed: unexpected,
    rememberProject: unexpected,
    deletingSessions: new Set(),
    adoptingSessionKeys: new Set(),
    conversationService: () => conversations as never,
    invalidateSessionHistoryLoad: unexpected,
    getWindow: () => window,
    deleteOneSession: unexpected,
    resolveSessionRunIds: unexpected,
    deleteConversationHistory: unexpected,
    appUserDataDir: '/unused-by-this-test'
  })
  const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(event, ...args)
  return { invoke, conversations, conversationStore, event, webContents, mainFrame, handlers }
}

const native = { kind: 'native-session', providerId: 'claude', cwd: '/workspace', nativeSessionId: 'native-1' }
const conversation = { kind: 'conversation', conversationId }

describe('side-chat IPC trust and source authorization', () => {
  it.each(['conversation:previewSideChat', 'conversation:createSideChat', 'conversation:listSideChats',
    'conversation:findSideChatCommand', 'conversation:readSideChatSnapshot'])(
    'rejects untrusted senders, subframes and origins before %s runs',
    (channel) => {
      const current = fixture()
      const untrusted = { ...current.event, sender: { mainFrame: current.mainFrame } } as unknown as IpcMainInvokeEvent
      const subframe = { ...current.event, senderFrame: { url: current.mainFrame.url } } as unknown as IpcMainInvokeEvent
      expect(() => current.handlers.get(channel)!(untrusted, { source: native })).toThrow('非可信 renderer')
      expect(() => current.handlers.get(channel)!(subframe, { source: native })).toThrow('非可信 renderer')
      current.mainFrame.url = 'https://evil.invalid/renderer.html'
      expect(() => current.handlers.get(channel)!(current.event, { source: native })).toThrow('非可信 renderer')
      expect(current.conversations.previewSideChat).not.toHaveBeenCalled()
      expect(current.conversations.createSideChat).not.toHaveBeenCalled()
      expect(current.conversations.listSideChats).not.toHaveBeenCalled()
      expect(current.conversations.findSideChatCommand).not.toHaveBeenCalled()
      expect(current.conversations.readSideChatSnapshot).not.toHaveBeenCalled()
    }
  )

  it('authorizes the lookup source and forwards only its typed command id', async () => {
    const current = fixture()
    await current.invoke('conversation:findSideChatCommand', native, 'side-chat-1')
    expect(current.conversations.findSideChatCommand).toHaveBeenCalledWith(native, 'side-chat-1')
    await expect(current.invoke('conversation:findSideChatCommand', { ...native, cwd: '/private/elsewhere' }, 'side-chat-1'))
      .rejects.toThrow('未知项目目录')
    await expect(current.invoke('conversation:findSideChatCommand', native, { commandId: 'side-chat-1' }))
      .rejects.toThrow('侧聊创建命令无效')
    await expect(current.invoke('conversation:findSideChatCommand', { kind: 'rollout', conversationId }, 'side-chat-1'))
      .rejects.toThrow('侧聊来源')
    expect(current.conversations.findSideChatCommand).toHaveBeenCalledTimes(1)
  })

  it('forwards only a typed snapshot body read and rejects other shapes', async () => {
    const current = fixture()
    await current.invoke('conversation:readSideChatSnapshot', conversationId)
    expect(current.conversations.readSideChatSnapshot).toHaveBeenCalledWith(conversationId, undefined)
    await current.invoke('conversation:readSideChatSnapshot', conversationId, '3:120')
    expect(current.conversations.readSideChatSnapshot).toHaveBeenCalledWith(conversationId, '3:120')
    // Shape errors are refused synchronously by the trusted handler wrapper.
    expect(() => current.invoke('conversation:readSideChatSnapshot', { id: conversationId }))
      .toThrow('统一对话 ID 无效')
    expect(() => current.invoke('conversation:readSideChatSnapshot', conversationId, { offset: 1 }))
      .toThrow('侧聊正文游标无效')
    expect(current.conversations.readSideChatSnapshot).toHaveBeenCalledTimes(2)
  })

  it('refuses native sources outside an authorized project before the service runs', async () => {
    const current = fixture()
    await expect(current.invoke('conversation:previewSideChat', { ...native, cwd: '/private/elsewhere' }))
      .rejects.toThrow('未知项目目录')
    await expect(current.invoke('conversation:createSideChat', { source: { ...native, cwd: '/private/elsewhere' },
      expectedThroughOrdinal: 1, expectedThroughRunId: 'run-1', expectedPrefixFingerprint: 'a'.repeat(64),
      expectedManifestFingerprint: 'b'.repeat(64), commandId: 'side-chat-1' })).rejects.toThrow('未知项目目录')
    expect(current.conversations.previewSideChat).not.toHaveBeenCalled()
    expect(current.conversations.createSideChat).not.toHaveBeenCalled()
  })

  it('refuses a managed source whose workspace is no longer authorized', async () => {
    const current = fixture()
    current.conversationStore.read.mockResolvedValueOnce({ id: conversationId, cwd: '/private/elsewhere' })
    await expect(current.invoke('conversation:previewSideChat', conversation)).rejects.toThrow('未知项目目录')
    expect(current.conversations.previewSideChat).not.toHaveBeenCalled()
  })

  it('requires an existing managed source for capture but not for history paging', async () => {
    const current = fixture()
    await expect(current.invoke('conversation:previewSideChat', conversation)).rejects.toThrow('侧聊来源对话不存在')
    await expect(current.invoke('conversation:createSideChat', { source: conversation, expectedThroughOrdinal: 1,
      expectedThroughRunId: 'run-1', expectedPrefixFingerprint: 'a'.repeat(64),
      expectedManifestFingerprint: 'b'.repeat(64), commandId: 'side-chat-1' })).rejects.toThrow('侧聊来源对话不存在')
    expect(current.conversations.previewSideChat).not.toHaveBeenCalled()
    await current.invoke('conversation:listSideChats', { source: conversation, limit: 40 })
    expect(current.conversations.listSideChats).toHaveBeenCalledWith({ source: conversation, limit: 40 })
  })

  it('canonicalizes the native source and forwards only typed options', async () => {
    const current = fixture()
    await current.invoke('conversation:previewSideChat', native, { completedThroughOrdinal: 2,
      initialTarget: { providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' } })
    expect(current.conversations.previewSideChat).toHaveBeenCalledWith(native, { completedThroughOrdinal: 2,
      initialTarget: { providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' } })
    await expect(current.invoke('conversation:previewSideChat', {
      ...native, path: '/tmp/transcript.jsonl'
    })).rejects.toThrow('侧聊来源字段不受支持')
  })

  it.each([
    ['a foreign source field', { kind: 'conversation', conversationId, cwd: '/workspace' }],
    ['an unknown source kind', { kind: 'rollout', conversationId }],
    ['an unparseable conversation id', { kind: 'conversation', conversationId: 'not-a-uuid' }],
    ['a relative native cwd', { ...native, cwd: 'relative/path' }]
  ])('rejects %s before any service call', async (_label, source) => {
    const current = fixture()
    await expect(current.invoke('conversation:previewSideChat', source)).rejects.toThrow('侧聊来源')
    expect(current.conversations.previewSideChat).not.toHaveBeenCalled()
  })

  it('rejects untyped paging requests before any service call', async () => {
    const current = fixture()
    await expect(current.invoke('conversation:listSideChats', { source: conversation, limit: 1000 }))
      .rejects.toThrow('分页大小')
    await expect(current.invoke('conversation:listSideChats', { source: conversation, extra: true }))
      .rejects.toThrow('字段不受支持')
    // A selected-id summary lookup stays bounded and typed before the service runs.
    await expect(current.invoke('conversation:listSideChats', { source: conversation,
      ids: Array.from({ length: 9 }, (_, index) => `child-${index}`) })).rejects.toThrow('8 个 ID')
    await expect(current.invoke('conversation:listSideChats', { source: conversation, ids: [42] }))
      .rejects.toThrow('8 个 ID')
    await expect(current.invoke('conversation:createSideChat', { source: conversation })).rejects.toThrow('侧聊创建参数无效')
    expect(current.conversations.listSideChats).not.toHaveBeenCalled()
    expect(current.conversations.createSideChat).not.toHaveBeenCalled()
  })
})
