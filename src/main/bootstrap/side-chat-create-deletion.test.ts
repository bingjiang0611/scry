import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { ContextAdmission } from '../context-admission'
import { registerConversationHandlers } from './conversation'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const cwd = '/workspace'
const catalogRow = { sessionId: 'app-alias', externalSessionId: 'native-1', runId: 'run-1', providerId: 'claude', cwd, preview: 'p', ts: 1 }
const contextKey = JSON.stringify(['context', 'claude', cwd, undefined])
const sessionKey = (id: string) => JSON.stringify(['session', 'claude', cwd, id, undefined])

/**
 * A Provider session's delete reserves itself and counts its side chats under the provider
 * context admission. A side chat of that session published after the count would survive
 * the delete with no source panel left to open it from, so creation shares the admission
 * and refuses once the session is being deleted, under either of its aliases.
 */
function fixture() {
  const handlers = new Map<string, Handler>()
  const contextAdmission = new ContextAdmission()
  const deletingSessions = new Set<string>()
  const unexpected = (): never => { throw new Error('unexpected dependency') }
  const createSideChat = vi.fn(async () => ({ id: 'child' }))
  registerConversationHandlers({
    handleTrusted: (channel, listener) => { handlers.set(channel, listener as Handler) },
    resolveKnownProjectDirectory: value => value,
    providerContextKey: (...identity) => JSON.stringify(['context', ...identity]),
    contextAdmission,
    getStartupManagedRecovery: async () => {},
    appSessionStore: () => ({ load: () => [catalogRow] }) as never,
    conversationStore: unexpected,
    getRuns: unexpected,
    providerRegistry: { continuationKey: unexpected },
    providerSessionKey: (...identity) => JSON.stringify(['session', ...identity]),
    assertLegacyConversationWriteAllowed: unexpected,
    rememberProject: unexpected,
    deletingSessions,
    adoptingSessionKeys: new Set(),
    conversationService: () => ({
      createSideChat,
      trackSideChatCreate: (_commandId: string | undefined, run: () => Promise<unknown>) => run()
    }) as never,
    invalidateSessionHistoryLoad: unexpected,
    getWindow: () => null,
    deleteOneSession: unexpected,
    resolveSessionRunIds: unexpected,
    deleteConversationHistory: unexpected,
    appUserDataDir: '/unused-by-this-test',
    dockBadge: { adopt: () => {} }
  })
  const create = (nativeSessionId: string) => handlers.get('conversation:createSideChat')!({} as IpcMainInvokeEvent, {
    source: { kind: 'native-session', providerId: 'claude', cwd, nativeSessionId },
    expectedThroughOrdinal: 1, expectedThroughRunId: 'run-1', expectedPrefixFingerprint: 'a'.repeat(64),
    expectedManifestFingerprint: 'b'.repeat(64), commandId: 'command-1'
  }) as Promise<unknown>
  return { create, createSideChat, contextAdmission, deletingSessions }
}

describe('side-chat creation from a Provider session that is being deleted', () => {
  it('refuses while the delete is reserved under either alias of the session', async () => {
    for (const reserved of ['native-1', 'app-alias']) {
      const current = fixture()
      current.deletingSessions.add(sessionKey(reserved))
      await expect(current.create('native-1')).rejects.toThrow('侧聊来源会话正在删除')
      await expect(current.create('app-alias')).rejects.toThrow('侧聊来源会话正在删除')
      expect(current.createSideChat).not.toHaveBeenCalled()
    }
  })

  it('waits for a delete that holds the admission, and is refused once it has reserved', async () => {
    const current = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const holding = new Promise<void>((resolve) => { entered = resolve })
    const held = current.contextAdmission.run(contextKey, async () => { entered(); await gate })
    await holding
    const creating = current.create('native-1')
    // The delete reserves inside its admission; the create cannot publish in between.
    current.deletingSessions.add(sessionKey('native-1'))
    expect(current.createSideChat).not.toHaveBeenCalled()
    release()
    await held
    await expect(creating).rejects.toThrow('侧聊来源会话正在删除')
    expect(current.createSideChat).not.toHaveBeenCalled()
  })

  it('publishes normally when the session is not being deleted', async () => {
    const current = fixture()
    await expect(current.create('native-1')).resolves.toEqual({ id: 'child' })
    expect(current.createSideChat).toHaveBeenCalledTimes(1)
  })
})
