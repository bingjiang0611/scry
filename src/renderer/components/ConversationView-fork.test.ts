import { describe, expect, it } from 'vitest'
import type { ConversationPage, ConversationSummary } from '@shared/conversation-api'
import { forkableRunIdsOf } from './ConversationView'

const page = (): ConversationPage => ({
  summary: { id: 'c1', cwd: '/repo', title: 't', revision: 2, turnCount: 1 },
  bindings: [{ id: 'b1', providerId: 'codex', continuationKey: 'identity:codex:default', nativeSessionId: 'native-1' } as ConversationPage['bindings'][number]],
  turns: [{
    ordinal: 1, runId: 'run-1', bindingId: 'b1', providerId: 'codex',
    delivery: { status: 'accepted', nativeSessionId: 'native-1', outcome: 'completed', nativeItems: [] }
  }]
})

const conversation = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c1', cwd: '/repo', title: 't', revision: 2, turnCount: 1, ...overrides
})

describe('native fork availability', () => {
  it('offers fork on a settled turn of an ordinary conversation', () => {
    expect([...forkableRunIdsOf(conversation(), page())]).toEqual(['run-1'])
  })

  it('never offers fork for a side chat, even with a settled native turn', () => {
    const sideChat = conversation({
      sideChat: {
        source: { kind: 'native-session', providerId: 'codex', cwd: '/repo', nativeSessionId: 'native-0' },
        parentTitleAtCapture: '主会话标题',
        initialTarget: { providerId: 'codex' },
        throughOrdinal: 3,
        throughRunId: 'run-0',
        capturedAt: 1,
        prefixFingerprint: 'fingerprint',
        messageCount: 4
      }
    })
    // Main rejects this fork as well; the button must not be offered at all.
    expect(forkableRunIdsOf(sideChat, page()).size).toBe(0)
  })
})
