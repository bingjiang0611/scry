import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '@shared/conversation-api'
import type { SideChatSource } from '@shared/conversation'
import { conversationSourceKey, indexSideChatCatalog, nativeSourceKey, sideChatCountLabel } from './side-chat-index'
import { SIDE_CHAT_COPY } from './constants/side-chat-copy'

const parentId = '11111111-2222-4333-8444-555555555555'

function child(id: string, source: SideChatSource, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, cwd: '/repo', title: `child ${id}`, revision: 1, turnCount: 0,
    sideChat: { source, parentTitleAtCapture: '原主会话', initialTarget: { providerId: 'claude', permissionMode: 'default' },
      throughOrdinal: 4, throughRunId: 'run-4', capturedAt: 1, prefixFingerprint: 'a'.repeat(64), messageCount: 8 },
    ...overrides
  }
}

const project = {
  cwd: '/repo',
  sessions: [{ providerId: 'claude' as const, sessionId: 'native-1', externalSessionId: 'native-1' }],
  conversations: [] as ConversationSummary[]
}

describe('one-pass side-chat catalog', () => {
  it('counts children per managed parent and per native session', () => {
    const catalog = indexSideChatCatalog({
      projects: [{ ...project, conversations: [
        { id: parentId, cwd: '/repo', title: '父', revision: 1, turnCount: 8 },
        child('c1', { kind: 'conversation', conversationId: parentId }, { activeRunId: 'run-a' }),
        child('c2', { kind: 'conversation', conversationId: parentId }, { activeRunId: 'run-b' }),
        child('c3', { kind: 'conversation', conversationId: parentId }),
        child('n1', { kind: 'native-session', providerId: 'claude', cwd: '/repo', nativeSessionId: 'native-1' })
      ] }],
      runningRunIds: new Set(['run-a']),
      waitingQuestionRunIds: new Set(['run-b']),
      questionKindsByRun: new Map([['run-b', 'clarification' as const]])
    })
    expect(catalog.counts.get(conversationSourceKey(parentId))).toEqual({ total: 3, running: 1, permission: 0, attention: 1 })
    expect(catalog.counts.get(nativeSourceKey({ providerId: 'claude', cwd: '/repo', nativeSessionId: 'native-1' })))
      .toEqual({ total: 1, running: 0, permission: 0, attention: 0 })
    // A clarification is attention, never an approval request.
    expect(sideChatCountLabel(catalog.counts.get(conversationSourceKey(parentId))))
      .toBe(`${SIDE_CHAT_COPY.parentCount(3)} · ${SIDE_CHAT_COPY.parentRunning(1)} · ${SIDE_CHAT_COPY.parentNeedsAttention(1)}`)
  })

  it('counts only a real permission request as an approval need', () => {
    const catalog = indexSideChatCatalog({
      projects: [{ ...project, conversations: [
        { id: parentId, cwd: '/repo', title: '父', revision: 1, turnCount: 8 },
        child('c1', { kind: 'conversation', conversationId: parentId }, { activeRunId: 'run-p' })
      ] }],
      runningRunIds: new Set(),
      waitingQuestionRunIds: new Set(['run-p']),
      questionKindsByRun: new Map([['run-p', 'permission' as const]])
    })
    expect(catalog.counts.get(conversationSourceKey(parentId))?.permission).toBe(1)
    expect(catalog.counts.get(conversationSourceKey(parentId))?.attention).toBe(0)
  })

  it('keeps children of a vanished source in their own group keyed by that source', () => {
    const catalog = indexSideChatCatalog({
      projects: [{ ...project, conversations: [
        child('orphan', { kind: 'conversation', conversationId: '99999999-2222-4333-8444-555555555555' })
      ] }],
      runningRunIds: new Set(),
      waitingQuestionRunIds: new Set(),
      questionKindsByRun: new Map()
    })
    expect(catalog.counts.size).toBe(0)
    expect(catalog.orphans).toEqual([
      { key: 'conversation:99999999-2222-4333-8444-555555555555', parentTitleAtCapture: '原主会话',
        items: [expect.objectContaining({ id: 'orphan' })], total: 1 }
    ])
    // Never flattened into the main root list: nothing is counted for any parent row.
    expect(sideChatCountLabel(undefined)).toBeUndefined()
  })

  it('keeps two unrelated sources with the same captured title apart', () => {
    // A title is what a row prints, not identity: two deleted parents can be called the
    // same thing, and merging them would show a child under another conversation's name.
    const catalog = indexSideChatCatalog({
      projects: [{ ...project, conversations: [
        child('a', { kind: 'conversation', conversationId: '99999999-2222-4333-8444-555555555555' }),
        child('b', { kind: 'conversation', conversationId: '88888888-2222-4333-8444-555555555555' }),
        child('c', { kind: 'native-session', providerId: 'claude', cwd: '/repo', nativeSessionId: 'gone-native' })
      ] }],
      runningRunIds: new Set(),
      waitingQuestionRunIds: new Set(),
      questionKindsByRun: new Map()
    })
    expect(catalog.orphans.map(group => [group.key, group.items.map(item => item.id), group.total])).toEqual([
      ['conversation:88888888-2222-4333-8444-555555555555', ['b'], 1],
      ['conversation:99999999-2222-4333-8444-555555555555', ['a'], 1],
      [`native:${JSON.stringify(['claude', null, '/repo', 'gone-native'])}`, ['c'], 1]
    ])
    // Every group still prints the captured title it really has.
    expect(catalog.orphans.every(group => group.parentTitleAtCapture === '原主会话')).toBe(true)
  })

  it('treats a parent known from another loaded list as present', () => {
    const catalog = indexSideChatCatalog({
      projects: [{ ...project, conversations: [child('kept', { kind: 'conversation', conversationId: parentId })] }],
      runningRunIds: new Set(),
      waitingQuestionRunIds: new Set(),
      questionKindsByRun: new Map(),
      extraParentKeys: [conversationSourceKey(parentId)]
    })
    expect(catalog.orphans).toEqual([])
    expect(catalog.counts.get(conversationSourceKey(parentId))?.total).toBe(1)
  })

  it('reports no counter for a row without children', () => {
    const catalog = indexSideChatCatalog({ projects: [project], runningRunIds: new Set(),
      waitingQuestionRunIds: new Set(), questionKindsByRun: new Map() })
    expect(catalog.counts.size).toBe(0)
    expect(sideChatCountLabel(catalog.counts.get(conversationSourceKey(parentId)))).toBeUndefined()
  })
})
