import { describe, expect, it } from 'vitest'
import { conversationSourceKey, nativeSourceKey, parentKeyOf } from './side-chat-index'

describe('side-chat source identity', () => {
  it('keys a managed parent by its own id', () => {
    expect(parentKeyOf({ kind: 'conversation', conversationId: 'parent-1' })).toBe(conversationSourceKey('parent-1'))
  })

  it('keys a native parent by the exact provider, profile, workspace and session', () => {
    const source = { kind: 'native-session' as const, providerId: 'claude' as const, cwd: '/repo', nativeSessionId: 'native-1' }
    expect(parentKeyOf(source)).toBe(nativeSourceKey({ providerId: 'claude', cwd: '/repo', nativeSessionId: 'native-1' }))
    // A missing profile and an explicit null are the same identity; another profile,
    // workspace or session is not.
    const key = nativeSourceKey({ providerId: 'claude', agentProfileId: null, cwd: '/repo', nativeSessionId: 'native-1' })
    expect(parentKeyOf(source)).toBe(key)
    expect(parentKeyOf({ ...source, agentProfileId: 'work' })).not.toBe(key)
    expect(parentKeyOf({ ...source, cwd: '/other' })).not.toBe(key)
    expect(parentKeyOf({ ...source, nativeSessionId: 'native-2' })).not.toBe(key)
  })
})
