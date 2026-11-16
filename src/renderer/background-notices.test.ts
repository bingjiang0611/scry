import { describe, expect, it } from 'vitest'
import { conversationAttentionKey, sessionAttentionKey } from '@shared/session-attention'
import type { ProjectMeta } from './env'
import { addedKeys, isStickyNotice, MAX_VISIBLE_NOTICES, NOTICE_RESOLVE_WINDOW_MS, noticeKind, pushNotices, resolveNotice, trackUnread, type BackgroundNotice, type NoticeTracker } from './background-notices'

const project: ProjectMeta = {
  cwd: '/work/store', name: 'Store', mtime: 3,
  sessions: [
    { sessionId: 'done', providerId: 'claude', preview: '修复布局', mtime: 3, count: 1, runId: 'run-done', lastRunOutcome: 'completed' },
    { sessionId: 'broken', providerId: 'codex', externalSessionId: 'native-broken', preview: '迁移数据库', mtime: 2, count: 1, runId: 'run-broken', lastRunOutcome: 'failed' },
    { sessionId: 'unknown', providerId: 'pi', preview: '整理文档', mtime: 2, count: 1, runId: 'run-unknown' },
    { sessionId: 'archived', providerId: 'codex', preview: '归档', mtime: 1, count: 1, archivedAt: 1, lastRunOutcome: 'failed' }
  ],
  conversations: [
    { id: 'asking', cwd: '/work/store', title: '等待回复的对话', revision: 1, turnCount: 2, activeRunId: 'run-asking' },
    { id: 'child', cwd: '/work/store', title: '侧边会话', revision: 1, turnCount: 1, lastRunOutcome: 'failed',
      sideChat: { parentConversationId: 'asking' } as never }
  ]
}
const key = (sessionId: string, providerId: 'claude' | 'codex' | 'pi', cwd = '/work/store') => sessionAttentionKey({ providerId, cwd, sessionId })
const none = new Set<string>()

describe('background notices', () => {
  it('classifies with the sidebar grouping and never calls an outcome-less result completed', () => {
    expect(noticeKind({ active: false, blocked: true })).toBe('attention')
    expect(noticeKind({ active: false, blocked: false, outcome: 'completed' })).toBe('completed')
    expect(noticeKind({ active: false, blocked: false, outcome: 'failed' })).toBe('failed')
    expect(noticeKind({ active: false, blocked: false, outcome: 'cancelled' })).toBe('cancelled')
    expect(noticeKind({ active: false, blocked: false, outcome: 'interrupted' })).toBe('interrupted')
    expect(noticeKind({ active: false, blocked: false })).toBe('updated')
    // A run still in progress has nothing to report yet.
    expect(noticeKind({ active: true, blocked: false, outcome: 'completed' })).toBeUndefined()
    expect(['attention', 'failed', 'interrupted'].every((kind) => isStickyNotice(kind as never))).toBe(true)
    expect(['completed', 'cancelled', 'updated'].some((kind) => isStickyNotice(kind as never))).toBe(false)
  })

  it('resolves local sessions and conversations by their attention key', () => {
    expect(resolveNotice(key('done', 'claude'), [project], none, none)).toMatchObject({ kind: 'completed', title: '修复布局', projectName: 'Store', target: { kind: 'session', cwd: '/work/store' } })
    // The native id is the session's identity once the Provider has reported it.
    expect(resolveNotice(key('native-broken', 'codex'), [project], none, none)?.kind).toBe('failed')
    expect(resolveNotice(key('unknown', 'pi'), [project], none, none)?.kind).toBe('updated')
    expect(resolveNotice(conversationAttentionKey('asking'), [project], new Set(['run-asking']), new Set(['run-asking'])))
      .toMatchObject({ kind: 'attention', title: '等待回复的对话', target: { kind: 'conversation' } })
  })

  it('gives no notice for running, archived, side-chat or unknown keys', () => {
    expect(resolveNotice(key('done', 'claude'), [project], new Set(['run-done']), none)).toBeUndefined()
    expect(resolveNotice(key('archived', 'codex'), [project], none, none)).toBeUndefined()
    expect(resolveNotice(conversationAttentionKey('child'), [project], none, none)).toBeUndefined()
    expect(resolveNotice('remote\0elsewhere', [project], none, none)).toBeUndefined()
  })

  it('keeps one notice per session, newest first, at most three', () => {
    const notice = (id: string): BackgroundNotice => ({ key: id, kind: 'completed', title: id, projectName: 'p',
      target: { kind: 'session', cwd: '/', session: project.sessions[0] } })
    let list = pushNotices([], [notice('a'), notice('b')])
    expect(list.map((item) => item.key)).toEqual(['b', 'a'])
    list = pushNotices(list, [notice('a')])
    expect(list.map((item) => item.key)).toEqual(['a', 'b'])
    list = pushNotices(list, [notice('c'), notice('d')])
    expect(list.map((item) => item.key)).toEqual(['d', 'c', 'a'])
    expect(list).toHaveLength(MAX_VISIBLE_NOTICES)
    expect(addedKeys(new Set(['a']), new Set(['a', 'b', 'c']))).toEqual(['b', 'c'])
  })
  it('treats the first snapshot as a baseline, retries until the catalog catches up, and forgets read or stale keys', () => {
    const tracker: NoticeTracker = { baseline: null, pending: new Map() }
    const done = key('done', 'claude'), broken = key('native-broken', 'codex'), unknown = key('unknown', 'pi')
    const step = (unread: string[], now: number, running: Set<string> = none) =>
      trackUnread(tracker, { unread: new Set(unread), projects: [project], runningRunIds: running, waitingQuestionRunIds: none, now }).map((notice) => notice.key)
    // Already unread when the window opened: sidebar only, no notice.
    expect(step([done], 0)).toEqual([])
    // Newly unread while its run is still marked running: waits instead of guessing.
    expect(step([done, broken], 1, new Set(['run-broken']))).toEqual([])
    expect(tracker.pending.has(broken)).toBe(true)
    expect(step([done, broken], 2)).toEqual([broken])
    expect(tracker.pending.size).toBe(0)
    // Read before it resolved: dropped.
    expect(step([done, broken, unknown], 3, new Set(['run-unknown']))).toEqual([])
    expect(step([done, broken], 4)).toEqual([])
    expect(tracker.pending.size).toBe(0)
    // Never caught up within the window: dropped instead of notifying late.
    expect(step([done, broken, unknown], 5, new Set(['run-unknown']))).toEqual([])
    expect(step([done, broken, unknown], 6 + NOTICE_RESOLVE_WINDOW_MS)).toEqual([])
    expect(tracker.pending.size).toBe(0)
  })
})
