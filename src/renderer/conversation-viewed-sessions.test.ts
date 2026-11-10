import { describe, expect, it } from 'vitest'
import { sessionAttentionKey } from '@shared/session-attention'
import { conversationSessionKeys } from './conversation-viewed-sessions'

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
