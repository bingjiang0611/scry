import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '@shared/conversation-api'
import { sideChatScope } from './side-chat-scope'
import { SIDE_CHAT_COPY } from './constants/side-chat-copy'

const controls = { permissionMode: 'auto_accept_edits' as const, model: { id: 'model-a', providerId: 'claude' }, effort: 'high' }

const conversation = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: '11111111-2222-4333-8444-555555555555', cwd: '/repo', title: '父会话', revision: 3, turnCount: 8, ...overrides
})

/** A child of another parent: its own frozen source, nothing of it to freeze again. */
const childConversation = (): ConversationSummary => conversation({
  sideChat: { source: { kind: 'conversation', conversationId: '99999999-2222-4333-8444-555555555555' },
    parentTitleAtCapture: '祖父', initialTarget: { providerId: 'claude', permissionMode: 'default' },
    throughOrdinal: 2, throughRunId: 'run-2', capturedAt: 1, prefixFingerprint: 'a'.repeat(64), messageCount: 4 }
})

/** A Provider session row: the chat view, with no logical conversation of its own. */
function chatScope(overrides: Partial<Parameters<typeof sideChatScope>[0]> = {}) {
  return sideChatScope({
    draftKey: 'draft-key', view: 'chat', providerId: 'claude', runControls: controls, cwd: '/repo',
    nativeSessionId: 'native-1', completedTurns: 8, apiAvailable: true, ...overrides
  })
}

/** The conversation view: its parent is the logical conversation. */
function conversationScope(overrides: Partial<Parameters<typeof sideChatScope>[0]> = {}) {
  return sideChatScope({
    draftKey: 'draft-key', view: 'conversation', providerId: 'claude', runControls: controls, cwd: '/repo',
    nativeSessionId: 'native-1', completedTurns: 8, apiAvailable: true, ...overrides
  })
}

describe('side-chat source scope', () => {
  it('addresses a managed parent by its own conversation id', () => {
    const scope = conversationScope({ conversation: conversation() })
    expect(scope.source).toEqual({ kind: 'conversation', conversationId: conversation().id })
    expect(scope.scopeKey).toBe('draft-key')
    expect(scope.unavailableReason).toBeUndefined()
  })

  it('pins the parent provider, profile, model, effort and permission as the first target', () => {
    const scope = conversationScope({ conversation: conversation(), agentProfileId: 'pi:0123456789abcdef', providerId: 'pi' })
    expect(scope.target).toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef',
      model: { id: 'model-a', providerId: 'claude' }, effort: 'high', permissionMode: 'auto_accept_edits' })
  })

  it('keeps the exact native session tuple instead of a bare session id', () => {
    const scope = chatScope({ agentProfileId: 'pi:0123456789abcdef', providerId: 'pi' })
    expect(scope.source).toEqual({ kind: 'native-session', providerId: 'pi',
      agentProfileId: 'pi:0123456789abcdef', cwd: '/repo', nativeSessionId: 'native-1' })
  })

  it('refuses a nested child and explains it instead of offering a no-op control', () => {
    const scope = conversationScope({ conversation: childConversation() })
    expect(scope.source).toBeUndefined()
    expect(scope.unavailableReason).toBe(SIDE_CHAT_COPY.entryUnavailableNested)
  })

  // Regression: opening a side chat as the main view and then selecting a Provider
  // session row left that child as the stale logical conversation. The chat scope then
  // reported "a side chat cannot create a side chat" and its history dialog asked the
  // host for no scope at all, so a parent with children looked childless afterwards.
  it('keeps the native source of a Provider session while another view holds a logical conversation', () => {
    const scope = chatScope({ conversation: childConversation() })
    expect(scope.source).toEqual({ kind: 'native-session', providerId: 'claude', cwd: '/repo', nativeSessionId: 'native-1' })
    expect(scope.unavailableReason).toBeUndefined()
  })

  it('never addresses a conversation that is not this view parent', () => {
    const scope = chatScope({ conversation: conversation() })
    expect(scope.source).toEqual({ kind: 'native-session', providerId: 'claude', cwd: '/repo', nativeSessionId: 'native-1' })
  })

  it('has no source in the conversation view before its conversation is known', () => {
    const scope = conversationScope({ conversation: undefined })
    expect(scope.source).toBeUndefined()
    expect(scope.unavailableReason).toBe(SIDE_CHAT_COPY.entryUnavailableNoSource)
  })

  it('reports a missing source and a missing build capability truthfully', () => {
    expect(chatScope({ cwd: null, nativeSessionId: null }).unavailableReason)
      .toBe(SIDE_CHAT_COPY.entryUnavailableNoSource)
    expect(chatScope({ apiAvailable: false }).unavailableReason).toBe(SIDE_CHAT_COPY.entryUnavailableApi)
  })

  it('never claims a snapshot from zero turns', () => {
    expect(conversationScope({ conversation: conversation(), completedTurns: 0 }).hasCompletedTurn).toBe(false)
    expect(conversationScope({ conversation: conversation(), completedTurns: 3 }).hasCompletedTurn).toBe(true)
  })
})
