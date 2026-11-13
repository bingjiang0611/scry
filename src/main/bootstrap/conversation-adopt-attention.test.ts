import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextAdmission } from '../context-admission'
import { DockBadgeState } from '../dock-badge'
import { modelEvent, sideChatFixture, type SideChatFixture } from '../conversation-side-chat.fixture'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import { conversationAttentionKey, sessionAttentionKey } from '../../shared/session-attention'
import { registerConversationHandlers } from './conversation'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const fixtures: SideChatFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup())) })

/**
 * Adoption hides the native session's sidebar row. Attention keyed by that session — an
 * unread result from before, or a side chat of it that is still running — must move to the
 * adopting conversation's row, or it leaves a Dock badge no row can show or clear.
 */
describe('adopting a native session moves its attention to the conversation row', () => {
  it('hands unread state and later attention under either alias to the adopting conversation', async () => {
    const current = await sideChatFixture()
    fixtures.push(current)
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId: 'native-parent', providerId: 'codex',
      turn: { runId: 'native-run', userText: 'native question', items: [modelEvent('native-run', 'native answer')],
        done: true, status: 'completed', ts: Date.now() } })
    const catalogRow = { sessionId: 'app-alias', externalSessionId: 'native-parent', providerId: 'codex', cwd: current.cwd,
      preview: 'native question', ts: 1 }
    const badge = new DockBadgeState(() => {})
    const handlers = new Map<string, Handler>()
    const unexpected = (): never => { throw new Error('unexpected dependency') }
    registerConversationHandlers({
      handleTrusted: (channel, listener) => { handlers.set(channel, listener as Handler) },
      resolveKnownProjectDirectory: cwd => cwd,
      providerContextKey: (...identity) => JSON.stringify(identity),
      contextAdmission: new ContextAdmission(),
      getStartupManagedRecovery: async () => {},
      appSessionStore: () => ({ load: () => [catalogRow] }) as never,
      conversationStore: () => current.store,
      getRuns: () => ({ unsettledStates: () => [] }),
      providerRegistry: { continuationKey: unexpected },
      providerSessionKey: (...identity) => JSON.stringify(identity),
      assertLegacyConversationWriteAllowed: async () => {},
      rememberProject: unexpected,
      deletingSessions: new Set(),
      adoptingSessionKeys: new Set(),
      conversationService: () => current.service,
      invalidateSessionHistoryLoad: () => {},
      getWindow: () => null,
      deleteOneSession: unexpected,
      resolveSessionRunIds: unexpected,
      deleteConversationHistory: unexpected,
      appUserDataDir: current.userData,
      dockBadge: badge
    })
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
    const nativeKey = sessionAttentionKey({ providerId: 'codex', cwd: current.cwd, sessionId: 'native-parent' })
    const aliasKey = sessionAttentionKey({ providerId: 'codex', cwd: current.cwd, sessionId: 'app-alias' })
    const background = { windowFocused: false, sessionViewed: false, needsAttention: true }
    badge.markAttention(nativeKey, background)

    const source = { providerId: 'codex', cwd: current.cwd, externalSessionId: 'native-parent' }
    const preview = await invoke('conversation:previewAdoption', source) as { fingerprint: string }
    // A preview reads; only the committed adoption hands the row over.
    expect(badge.snapshot().unreadSessionKeys).toEqual([nativeKey])
    const adopted = await invoke('conversation:adopt', source, preview.fingerprint) as { id: string }
    const conversationKey = conversationAttentionKey(adopted.id)
    expect(badge.snapshot().unreadSessionKeys).toEqual([conversationKey])

    // Viewing the conversation reads it, and a run that still reports either native alias
    // lands on that row too.
    badge.view(conversationKey, true)
    expect(badge.count).toBe(0)
    badge.view(null, false)
    badge.markAttention(aliasKey, background)
    expect(badge.snapshot().unreadSessionKeys).toEqual([conversationKey])
  })
})
