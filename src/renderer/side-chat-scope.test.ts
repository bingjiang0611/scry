import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '@shared/conversation-api'
import { sideChatScope, terminalTurnCount } from './side-chat-scope'
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
    nativeSessionId: 'native-1', terminalTurns: 8, apiAvailable: true, ...overrides
  })
}

/** The conversation view: its parent is the logical conversation. */
function conversationScope(overrides: Partial<Parameters<typeof sideChatScope>[0]> = {}) {
  return sideChatScope({
    draftKey: 'draft-key', view: 'conversation', providerId: 'claude', runControls: controls, cwd: '/repo',
    nativeSessionId: 'native-1', terminalTurns: 8, apiAvailable: true, ...overrides
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
    const scope = conversationScope({ conversation: conversation(), agentProfileId: 'pi:0123456789abcdef',
      targetAgentProfileId: 'pi:0123456789abcdef', providerId: 'pi' })
    expect(scope.target).toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef',
      model: { id: 'model-a', providerId: 'claude' }, effort: 'high', permissionMode: 'auto_accept_edits' })
  })

  // 回归：历史 Pi id（Pi · Rotom）只能作为原生来源身份；新子会话的首次发送目标必须是已登记 Profile。
  it('keeps a historical Pi id as the native source but never as the first target', () => {
    const scope = chatScope({ agentProfileId: 'pi:rotom', targetAgentProfileId: 'pi:0123456789abcdef', providerId: 'pi' })
    expect(scope.source).toEqual({ kind: 'native-session', providerId: 'pi',
      agentProfileId: 'pi:rotom', cwd: '/repo', nativeSessionId: 'native-1' })
    expect(scope.target).toMatchObject({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })
    // 没有已登记 Profile 时不伪造目标身份，也不会把历史 id 当成 Agent Profile。
    expect(chatScope({ agentProfileId: 'pi:rotom', providerId: 'pi' }).target).not.toHaveProperty('agentProfileId')
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
    expect(conversationScope({ conversation: conversation(), terminalTurns: 0 }).hasTerminalTurn).toBe(false)
    expect(conversationScope({ conversation: conversation(), terminalTurns: 3 }).hasTerminalTurn).toBe(true)
  })

  it('counts only actual terminal turn evidence, not a live placeholder', () => {
    expect(terminalTurnCount([])).toBe(0)
    // A running turn, a pending-start placeholder and a finalizing turn are all unproven.
    expect(terminalTurnCount([{ done: false }, { done: false }])).toBe(0)
    expect(terminalTurnCount([{ done: true }])).toBe(1)
    // `error` is terminal even when the settled flag never arrived.
    expect(terminalTurnCount([{ done: false, error: 'spawn failed' }])).toBe(1)
    expect(terminalTurnCount([{ done: true }, { done: false }, { done: false, error: 'x' }])).toBe(2)
  })

  // Regression: the shell counted every displayed turn, so a parent whose only turn was
  // still running offered a side chat of a prefix main would refuse to freeze.
  it('keeps a child disabled while the only displayed turn is still running', () => {
    const running = conversationScope({ conversation: conversation(), terminalTurns: terminalTurnCount([{ done: false }]) })
    expect(running.hasTerminalTurn).toBe(false)
    expect(conversationScope({ conversation: conversation(),
      terminalTurns: terminalTurnCount([{ done: true }]) }).hasTerminalTurn).toBe(true)
    expect(conversationScope({ conversation: conversation(),
      terminalTurns: terminalTurnCount([{ done: false, error: 'Provider 启动失败' }]) }).hasTerminalTurn).toBe(true)
  })
})
