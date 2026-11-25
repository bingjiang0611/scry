import { describe, expect, it } from 'vitest'
import type { SideChatSource } from '../shared/conversation'
import type { SideChatConversation } from './orchestration-side-chat-lineage'
import { sideChatLineageInput } from './orchestration-side-chat-lineage'

const child = (source: SideChatSource): SideChatConversation => ({
  id: 'conv-child',
  cwd: '/w',
  title: '侧聊',
  bindings: [{ id: 'b1', providerId: 'pi', agentProfileId: 'p1', continuationKey: 'k1', nativeSessionId: 'native-child' }],
  sideChat: {
    source,
    parentTitleAtCapture: 'parent',
    initialTarget: { providerId: 'pi', agentProfileId: 'p1' },
    snapshot: {
      format: 4, id: 's1', prefixFingerprint: 'pf', throughOrdinal: 1, throughRunId: 'r1',
      capturedAt: 1, messageCount: 0, bodyBytes: 0,
      items: { root: { storage: 'recorder-content-v1', sha256: 'r', bytes: 0, encoding: 'json' }, from: 0, count: 0, bytes: 0, fanout: 8 }
    },
    commandId: 'c1',
    intentHash: 'h1'
  }
})

const noParents = { parentSessionKeyOf: () => undefined }

// D3: a side chat only has an identity after the Provider answers. Recording it then keeps the
// tree complete, and an unknown parent leaves the child unattached rather than wrong.

describe('side chat lineage', () => {
  it('records the native source as the parent', () => {
    const input = sideChatLineageInput(
      child({ kind: 'native-session', providerId: 'pi', cwd: '/w', nativeSessionId: 'native-parent' }),
      'native-child',
      noParents
    )
    expect(input).toMatchObject({
      sessionKey: 'native-child',
      parentSessionKey: 'native-parent',
      rootSessionKey: 'native-parent',
      conversationId: 'conv-child',
      provider: 'pi',
      profile: 'p1',
      lineage: { kind: 'side_chat', source: { sessionKey: 'native-parent' } }
    })
  })

  it('resolves a conversation source through the projected parent session', () => {
    const input = sideChatLineageInput(
      child({ kind: 'conversation', conversationId: 'conv-parent' }),
      'native-child',
      { parentSessionKeyOf: (id) => (id === 'conv-parent' ? 'native-parent' : undefined) }
    )
    expect(input?.parentSessionKey).toBe('native-parent')
  })

  it('records nothing before the child has a native session', () => {
    expect(sideChatLineageInput(
      child({ kind: 'native-session', providerId: 'pi', cwd: '/w', nativeSessionId: 'native-parent' }),
      undefined,
      noParents
    )).toBeUndefined()
  })

  it('records nothing when the source session is unknown', () => {
    expect(sideChatLineageInput(child({ kind: 'conversation', conversationId: 'conv-parent' }), 'native-child', noParents)).toBeUndefined()
    expect(sideChatLineageInput({ ...child({ kind: 'conversation', conversationId: 'c' }), sideChat: undefined }, 'n', noParents)).toBeUndefined()
  })

  it('refuses a source that is the child itself', () => {
    expect(sideChatLineageInput(
      child({ kind: 'native-session', providerId: 'pi', cwd: '/w', nativeSessionId: 'native-child' }),
      'native-child',
      noParents
    )).toBeUndefined()
  })
})
