import { describe, expect, it, vi } from 'vitest'
import { sessionAttentionKey } from '@shared/session-attention'
import { ViewedSessions, conversationSessionKeys, noticeSessionKey } from './conversation-viewed-sessions'

const binding = (id: string, extra: Record<string, unknown>) => ({ id, providerId: 'codex', continuationKey: 'k', ...extra })

describe('conversationSessionKeys', () => {
  it('keys each native session the conversation shows the way main keys its unread mark', () => {
    const page = {
      summary: { cwd: '/w' },
      bindings: [
        binding('old', { nativeSessionId: 'n-old', retiredReason: 'switched' }),
        binding('none', {}),
        binding('pi', { providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', nativeSessionId: 'n-pi' }),
        binding('dup', { providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', nativeSessionId: 'n-pi' })
      ]
    } as never
    expect(conversationSessionKeys(page)).toEqual([
      sessionAttentionKey({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', cwd: '/w', sessionId: 'n-pi' }),
      sessionAttentionKey({ providerId: 'codex', cwd: '/w', sessionId: 'n-old' })
    ])
    expect(conversationSessionKeys(undefined)).toEqual([])
  })

  it('stays within the sixteen keys main accepts, live bindings first', () => {
    const bindings = [
      binding('retired', { nativeSessionId: 'retired', retiredReason: 'x' }),
      ...Array.from({ length: 20 }, (_, index) => binding(`b${index}`, { nativeSessionId: `n${index}` }))
    ]
    const keys = conversationSessionKeys({ summary: { cwd: '/w' }, bindings } as never)
    expect(keys).toHaveLength(16)
    expect(keys.some((key) => key.endsWith('\0retired'))).toBe(false)
  })
})

// A5 (c0e009e, both modes): a side chat's first reply flashed the badge 1 -> 0 for 16 ms.
// The turn ended before the page was read again with the new binding's native session.
describe('noticeSessionKey', () => {
  const page = {
    summary: { cwd: '/w', activeRunId: 'run-2' },
    bindings: [binding('b1', { providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })],
    turns: [{ runId: 'run-1', bindingId: 'b1', providerId: 'pi' }]
  } as never

  it('keys a session this conversation\'s run just learned, before the page names it', () => {
    expect(noticeSessionKey(page, { runId: 'run-1', sessionId: 'n-1' })).toBe(
      sessionAttentionKey({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', cwd: '/w', sessionId: 'n-1' }))
    expect(noticeSessionKey(page, { runId: 'run-2', sessionId: 'n-2', providerId: 'codex' })).toBe(
      sessionAttentionKey({ providerId: 'codex', cwd: '/w', sessionId: 'n-2' }))
  })

  it('ignores other runs, pending ids, and a run whose Provider it cannot tell', () => {
    expect(noticeSessionKey(page, { runId: 'elsewhere', sessionId: 'n', providerId: 'codex' })).toBeUndefined()
    expect(noticeSessionKey(page, { runId: 'run-1', sessionId: 'n', pending: true })).toBeUndefined()
    expect(noticeSessionKey(page, { runId: 'run-2', sessionId: 'n' })).toBeUndefined()
    expect(noticeSessionKey(undefined, { runId: 'run-1', sessionId: 'n' })).toBeUndefined()
  })
})

describe('ViewedSessions', () => {
  const page = {
    summary: { cwd: '/w', activeRunId: 'run-1' },
    bindings: [binding('b1', {})],
    turns: [{ runId: 'run-1', bindingId: 'b1', providerId: 'codex' }]
  } as never
  const key = sessionAttentionKey({ providerId: 'codex', cwd: '/w', sessionId: 'n-1' })

  it('names a new binding\'s session as soon as its run announces it, once', () => {
    const view = vi.fn(async () => true)
    const viewed = new ViewedSessions(view, 'c1', false)
    viewed.setPage(page)
    expect(view).not.toHaveBeenCalled()
    viewed.notice({ runId: 'run-1', sessionId: 'n-1' })
    expect(view).toHaveBeenLastCalledWith({ viewId: 'side:c1', main: false, sessionKeys: [key] })
    // The page read afterwards names the same session: nothing new to say.
    viewed.setPage({ ...(page as object), bindings: [binding('b1', { nativeSessionId: 'n-1' })] } as never)
    viewed.notice({ runId: 'run-1', sessionId: 'n-1' })
    expect(view).toHaveBeenCalledTimes(1)
    viewed.dispose()
    expect(view).toHaveBeenLastCalledWith({ viewId: 'side:c1', main: false, sessionKeys: [] })
  })

  it('withdraws nothing it never said', () => {
    const view = vi.fn(async () => true)
    const viewed = new ViewedSessions(view, 'c1', true)
    viewed.setPage(undefined)
    viewed.dispose()
    expect(view).not.toHaveBeenCalled()
  })
})
