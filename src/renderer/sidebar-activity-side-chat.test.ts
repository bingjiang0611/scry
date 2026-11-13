import { describe, expect, it } from 'vitest'
import { sidebarActivity } from './sidebar-activity'
import type { ProjectMeta } from './env'

const projects: ProjectMeta[] = [{
  cwd: '/work/store', name: 'Store', mtime: 3,
  sessions: [
    { sessionId: 'first', providerId: 'claude', preview: '修复布局', mtime: 3, count: 1, runId: 'run-a', pinnedAt: 1, lastRunOutcome: 'completed' },
    { sessionId: 'second', providerId: 'pi', preview: 'Update API', mtime: 2, count: 1, runId: 'old-run', lastRunOutcome: 'completed' },
    { sessionId: 'archived', providerId: 'codex', preview: '归档', mtime: 1, count: 1, archivedAt: 1 }
  ],
  conversations: [
    { id: 'logical', cwd: '/work/store', title: '逻辑会话', revision: 1, turnCount: 2, activeRunId: 'run-b' },
    { id: 'archived-logical', cwd: '/work/store', title: '归档逻辑会话', revision: 1, turnCount: 2, archivedAt: 1 }
  ]
}]

const empty = new Set<string>()

/** A side chat is never a row of its own; its live run lifts the row of its source. */
describe('side chats in the activity projection', () => {
  it('never lists a side chat as its own row; its live run lifts the parent row instead', () => {
    const parent = '主会话：重构侧边栏'
    const child = (extra: Partial<NonNullable<ProjectMeta['conversations']>[number]> = {}): NonNullable<ProjectMeta['conversations']>[number] => ({
      id: 'child', cwd: '/work/store', title: '侧聊：查一下这段 diff', revision: 1, turnCount: 1,
      sideChat: {
        source: { kind: 'conversation', conversationId: 'parent' }, parentTitleAtCapture: parent,
        initialTarget: { providerId: 'claude', permissionMode: 'default' },
        throughOrdinal: 2, throughRunId: 'parent-run', capturedAt: 1,
        prefixFingerprint: 'a'.repeat(64), messageCount: 3
      },
      ...extra
    })
    const rows = (childExtra: Parameters<typeof child>[0], waiting: ReadonlySet<string> = empty,
      parentExtra: Partial<NonNullable<ProjectMeta['conversations']>[number]> = {}) => sidebarActivity([{
      ...projects[0], sessions: [],
      conversations: [{ id: 'parent', cwd: '/work/store', title: parent, revision: 1, turnCount: 3, ...parentExtra }, child(childExtra)]
    }], new Set(['child-run']), waiting, '')
      .map((row) => [row.kind === 'conversation' ? row.conversation.id : row.kind, row.group])
    // A running child is background work of its parent: one row, the parent's.
    expect(rows({ activeRunId: 'child-run' })).toEqual([['parent', 'working']])
    // A child waiting for an answer needs the user even when the parent itself finished.
    expect(rows({ activeRunId: 'child-run' }, new Set(['child-run']), { lastRunOutcome: 'completed' }))
      .toEqual([['parent', 'attention']])
    // A finished or idle child is read in the parent's panel and adds no row at all.
    expect(rows({ lastRunOutcome: 'completed' })).toEqual([])
    expect(rows({ lastRunOutcome: 'failed' })).toEqual([])
    // The parent's own waiting state is never lowered by a merely running child.
    expect(rows({ activeRunId: 'child-run' }, new Set(['parent-live']), { activeRunId: 'parent-live' }))
      .toEqual([['parent', 'attention']])
  })

  it('lifts the conversation that adopted a side chat’s Provider session', () => {
    const adoptedChild: NonNullable<ProjectMeta['conversations']>[number] = {
      id: 'child-adopted', cwd: projects[0].cwd, title: '侧聊', revision: 1, turnCount: 1, activeRunId: 'child-run',
      sideChat: {
        source: { kind: 'native-session', providerId: 'claude', cwd: projects[0].cwd, nativeSessionId: 'adopted-native' },
        parentTitleAtCapture: '原主会话', initialTarget: { providerId: 'claude', permissionMode: 'default' },
        throughOrdinal: 1, throughRunId: 'r', capturedAt: 1, prefixFingerprint: 'a'.repeat(64), messageCount: 2,
        parentConversationId: 'adopter'
      }
    }
    const rows = sidebarActivity([{ ...projects[0], sessions: [], conversations: [
      { id: 'adopter', cwd: projects[0].cwd, title: '接管后的主会话', revision: 1, turnCount: 1 }, adoptedChild
    ] }], new Set(['child-run']), new Set(['child-run']), '')
    // The adopted session's own row is hidden behind the conversation, so that row is lifted.
    expect(rows.map((row) => [row.kind === 'conversation' ? row.conversation.id : row.kind, row.group]))
      .toEqual([['adopter', 'attention']])
  })

  it('lifts a native session row for its own side chat and drops a child whose source is not listed', () => {
    const session = projects[0].sessions[0]
    const nativeChild = (nativeSessionId: string): NonNullable<ProjectMeta['conversations']>[number] => ({
      id: `child-${nativeSessionId}`, cwd: projects[0].cwd, title: '侧聊', revision: 1, turnCount: 1, activeRunId: 'child-run',
      sideChat: {
        source: { kind: 'native-session', providerId: 'claude', cwd: projects[0].cwd, nativeSessionId },
        parentTitleAtCapture: '原主会话', initialTarget: { providerId: 'claude', permissionMode: 'default' },
        throughOrdinal: 1, throughRunId: 'r', capturedAt: 1, prefixFingerprint: 'a'.repeat(64), messageCount: 2
      }
    })
    const idle = { ...session, runId: undefined, lastRunOutcome: undefined }
    const own = sidebarActivity([{ ...projects[0], sessions: [idle],
      conversations: [nativeChild(session.externalSessionId ?? session.sessionId)] }], empty, empty, '')
    expect(own.map((row) => [row.kind, row.group])).toEqual([['session', 'working']])
    // A source that is not in the loaded list has no row to lift, and the child is not
    // promoted into one.
    expect(sidebarActivity([{ ...projects[0], sessions: [idle], conversations: [nativeChild('gone-native')] }],
      empty, empty, '')).toEqual([])
  })
})
