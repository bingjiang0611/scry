import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => undefined)
}))

vi.mock('electron', () => ({ ipcRenderer: { invoke: electron.invoke } }))

const { conversationsApi } = await import('./conversations')

beforeEach(() => {
  electron.invoke.mockReset()
  electron.invoke.mockResolvedValue({ data: null })
})

describe('conversation preload boundary', () => {
  it('exposes only fixed conversation operations with their scoped arguments', async () => {
    expect(Object.keys(conversationsApi).sort()).toEqual(['adopt', 'create', 'createSideChat', 'delete', 'findSideChatCommand', 'fork',
      'list', 'listSideChats', 'preview', 'previewAdoption', 'previewDeletion', 'previewSideChat', 'read', 'readItem', 'readSideChatSnapshot',
      'send', 'update'])
    await conversationsApi.create('/workspace')
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:create', '/workspace')
    const fork = { conversationId: 'conversation-id', expectedRevision: 2, sourceRunId: 'run-1', commandId: 'fork-1' }
    await conversationsApi.fork(fork)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:fork', fork)
    await conversationsApi.list('/workspace')
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:list', '/workspace')
    await conversationsApi.read('conversation-id', 40)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:read', 'conversation-id', 40)
    const ref = { runId: 'run-id', itemId: 'assistant', contentHash: 'a'.repeat(64) }
    await conversationsApi.readItem('conversation-id', ref)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:readItem', 'conversation-id', ref)
    await conversationsApi.preview('conversation-id', { providerId: 'codex' })
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:preview', 'conversation-id', { providerId: 'codex' })
    const request = { conversationId: 'conversation-id', providerId: 'codex' as const, expectedRevision: 0,
      expectedContinuationKey: 'frozen-identity', commandId: 'command-id', prompt: 'hello', selectedItems: [], confirmFresh: true }
    await conversationsApi.send(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:send', request)
    const source = { providerId: 'claude' as const, cwd: '/workspace', externalSessionId: 'source-session' }
    await conversationsApi.previewAdoption(source)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:previewAdoption', source)
    const target = { providerId: 'pi' as const, agentProfileId: 'pi:0123456789abcdef' }
    await conversationsApi.previewAdoption(source, target)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:previewAdoption', source, target)
    await conversationsApi.adopt(source, 'fingerprint')
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:adopt', source, 'fingerprint')
    await conversationsApi.update('conversation-id', 2, { kind: 'pin', pinned: true })
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:update', 'conversation-id', 2, { kind: 'pin', pinned: true })
    await conversationsApi.previewDeletion('conversation-id')
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:previewDeletion', 'conversation-id')
    await conversationsApi.delete('conversation-id', 'fingerprint')
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:delete', 'conversation-id', 'fingerprint')
    expect(electron.invoke).toHaveBeenCalledTimes(13)
  })

  it('forwards side-chat source reads and local-only creation with their scoped arguments', async () => {
    const conversationSource = { kind: 'conversation' as const, conversationId: 'conversation-id' }
    await conversationsApi.previewSideChat(conversationSource)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:previewSideChat', conversationSource)
    // A preview forwards an explicit typed boundary and the requested first-send target.
    const options = { completedThroughOrdinal: 3, initialTarget: { providerId: 'pi' as const, agentProfileId: 'pi:0123456789abcdef', permissionMode: 'default' as const } }
    await conversationsApi.previewSideChat(conversationSource, options)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:previewSideChat', conversationSource, options)
    await conversationsApi.listSideChats({ source: conversationSource, limit: 40 })
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:listSideChats', { source: conversationSource, limit: 40 })
    await conversationsApi.listSideChats({ source: conversationSource, cursor: '1700000000000:conversation-id', limit: 1 })
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:listSideChats', { source: conversationSource, cursor: '1700000000000:conversation-id', limit: 1 })
    const nativeSource = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: '/workspace', nativeSessionId: 'native-session' }
    await conversationsApi.previewSideChat(nativeSource)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:previewSideChat', nativeSource)
    const create = { source: nativeSource, expectedThroughOrdinal: 8, expectedThroughRunId: 'run-8',
      expectedPrefixFingerprint: 'a'.repeat(64), expectedManifestFingerprint: 'b'.repeat(64), commandId: 'side-chat-1',
      initialTarget: { providerId: 'codex' as const, model: { id: 'gpt-5' }, effort: 'high', permissionMode: 'default' as const } }
    await conversationsApi.createSideChat(create)
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:createSideChat', create)
    // Creation recovery is a read-only lookup of one command inside one source scope.
    await conversationsApi.findSideChatCommand(nativeSource, 'side-chat-1')
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:findSideChatCommand', nativeSource, 'side-chat-1')
    await conversationsApi.readSideChatSnapshot('conversation-id', '3:120')
    expect(electron.invoke).toHaveBeenLastCalledWith('conversation:readSideChatSnapshot', 'conversation-id', '3:120')
    expect(electron.invoke).toHaveBeenCalledTimes(8)
  })
})
