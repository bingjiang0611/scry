import { describe, expect, it } from 'vitest'
import { activityGroups, sidebarActivity } from './sidebar-activity'
import type { ProjectMeta } from './env'
import { sessionAttentionKey } from '@shared/session-attention'

const remoteProject = {
  key: '["mac2","/remote/rotom-team"]',
  connection: { id: 'mac2', label: 'mac2', hostId: 'host-2', anchorSHA256: 'anchor',
    ssh: { hostname: 'mac2', username: 'owner', port: 22 }, state: 'connected' as const, expiresAt: 0 },
  state: 'connected' as const, cwd: '/remote/rotom-team', name: 'rotom-team', mtime: 5,
  canManage: true, canDelete: true, needsUpgrade: false,
  sessions: [{ sessionId: 'remote-row', externalSessionId: 'native-id', providerId: 'pi',
    cwd: '/remote/rotom-team', label: '/skill:rotom-team-performance', ts: 5, isActive: true, pinnedAt: 1 }]
}

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
describe('sidebar activity projection', () => {
  it('uses live run evidence, gives questions precedence, and does not call inactive history completed', () => {
    const rows = sidebarActivity(projects, new Set(['run-a']), new Set(['run-a', 'run-b']), '')
    expect(rows.map((row) => [row.kind, row.group])).toEqual([
      ['conversation', 'attention'], ['session', 'attention'], ['session', 'completed']
    ])
    expect(activityGroups.map((group) => group.label)).toEqual(['需要回复', '进行中', '待查看', '已完成'])
    expect(sidebarActivity(projects, new Set(['run-a']), empty, '').map((row) => row.group))
      .toEqual(['working', 'working', 'completed'])
  })

  it('preserves identity across all native state transitions and includes pinned entries once', () => {
    const snapshots = [empty, new Set(['run-a'])].flatMap((running) => [empty, new Set(['run-a'])]
      .map((waiting) => sidebarActivity(projects, running, waiting, '修复')))
    expect(snapshots.every((rows) => rows.length === 1 && rows[0].key === snapshots[0][0].key)).toBe(true)
  })

  it('searches titles, project names and paths without changing source data', () => {
    const before = JSON.stringify(projects)
    expect(sidebarActivity(projects, empty, empty, '  api ')).toHaveLength(1)
    expect(sidebarActivity(projects, empty, empty, 'STORE')).toHaveLength(3)
    expect(sidebarActivity(projects, empty, empty, '/work/')).toHaveLength(3)
    expect(sidebarActivity(projects, empty, empty, 'missing')).toEqual([])
    expect(JSON.stringify(projects)).toBe(before)
  })

  it('keeps terminal non-success reviewable without ever claiming success, and hides only unknown history', () => {
    const unknown = [{ ...projects[0],
      sessions: [{ ...projects[0].sessions[0], lastRunOutcome: undefined }],
      conversations: [{ ...projects[0].conversations![0], activeRunId: undefined, lastRunOutcome: undefined }]
    }]
    // Absence of an outcome is not evidence, so nothing is shown for it.
    expect(sidebarActivity(unknown, empty, empty, '')).toEqual([])
    for (const lastRunOutcome of ['failed', 'cancelled', 'interrupted'] as const) {
      const source = [{ ...projects[0],
        sessions: [{ ...projects[0].sessions[0], lastRunOutcome }],
        conversations: [{ ...projects[0].conversations![0], activeRunId: undefined, lastRunOutcome }]
      }]
      // A terminal non-success is reviewable evidence: it stays visible, never completed.
      expect(sidebarActivity(source, empty, empty, '').map((row) => row.group)).toEqual(['updates', 'updates'])
      expect(sidebarActivity(source, new Set(['run-a']), empty, '').map((row) => row.group)).toEqual(['updates', 'working'])
    }
    const completed = [{ ...projects[0], sessions: [], conversations: [
      { ...projects[0].conversations![0], activeRunId: undefined, lastRunOutcome: 'completed' as const }
    ] }]
    expect(sidebarActivity(completed, empty, empty, '')[0].group).toBe('completed')
  })

  it('keeps unread terminal results visible without claiming unknown or failed runs succeeded', () => {
    const session = { ...projects[0].sessions[0], externalSessionId: 'native-id' }
    const source = [{ ...projects[0], conversations: [], sessions: [session] }]
    const unread = new Set([sessionAttentionKey({ providerId: session.providerId, cwd: source[0].cwd, sessionId: 'native-id' })])
    // Unread evidence alone decides visibility here, so the outcome stays unknown.
    const catalog = [{ ...source[0], sessions: [{ ...session, lastRunOutcome: undefined }] }]
    const rows = sidebarActivity(catalog, empty, empty, '', [], unread)
    expect(rows).toHaveLength(1)
    expect(rows[0].group).toBe('updates')
    // Without unread evidence an unknown outcome is not activity at all.
    expect(sidebarActivity(catalog, empty, empty, '', [], empty)).toEqual([])
    expect(sidebarActivity(catalog, new Set(['run-a']), empty, '', [], unread)[0].group).toBe('working')
    expect(sidebarActivity(catalog, new Set(['run-a']), new Set(['run-a']), '', [], unread)[0].group).toBe('attention')
    expect(sidebarActivity(catalog, empty, empty, 'missing', [], unread)).toEqual([])
    expect(sidebarActivity([{ ...catalog[0], sessions: [{ ...catalog[0].sessions[0], archivedAt: 1 }] }], empty, empty, '', [], unread)).toEqual([])
    for (const change of [{ providerId: 'pi' }, { agentProfileId: 'work' }, { externalSessionId: 'another' }] as const) {
      expect(sidebarActivity([{ ...catalog[0], sessions: [{ ...catalog[0].sessions[0], ...change }] }], empty, empty, '', [], unread)).toEqual([])
    }
    expect(sidebarActivity([{ ...catalog[0], cwd: '/another' }], empty, empty, '', [], unread)).toEqual([])
    expect(sidebarActivity(source, empty, empty, '', [], unread)[0].group).toBe('completed')
    expect(sidebarActivity(source, empty, empty, '', [], empty)[0].group).toBe('completed')
  })

  it('looks up grouped worktree unread state by the session directory, not the project root', () => {
    const session = { ...projects[0].sessions[0], cwd: '/work/store-worktree', lastRunOutcome: undefined }
    const source = [{ ...projects[0], conversations: [], sessions: [session] }]
    const unread = new Set([sessionAttentionKey({ providerId: session.providerId, cwd: session.cwd, sessionId: session.sessionId })])
    expect(sidebarActivity(source, empty, empty, '', [], unread)).toMatchObject([{ group: 'updates' }])
    const rootUnread = new Set([sessionAttentionKey({ providerId: session.providerId, cwd: source[0].cwd, sessionId: session.sessionId })])
    expect(sidebarActivity(source, empty, empty, '', [], rootUnread)).toEqual([])
  })

  it('preserves catalog reordering without changing task identities', () => {
    const before = sidebarActivity(projects, empty, empty, '')
    const reordered = sidebarActivity([{ ...projects[0], sessions: [...projects[0].sessions].reverse() }], empty, empty, '')
    expect(reordered.filter(row => row.kind === 'session').map(row => row.key))
      .toEqual(before.filter(row => row.kind === 'session').map(row => row.key).reverse())
  })

  it('merges live remote sessions with local activity, retaining their host and session identity', () => {
    const rows = sidebarActivity(projects, new Set(['run-a']), empty, '', [remoteProject])
    const remote = rows.filter(row => row.kind === 'remote')
    expect(rows.filter(row => row.kind !== 'remote')).toEqual(sidebarActivity(projects, new Set(['run-a']), empty, ''))
    expect(remote).toHaveLength(1)
    expect(remote[0]).toMatchObject({ group: 'working', project: remoteProject, session: remoteProject.sessions[0] })
    expect(sidebarActivity([], empty, empty, 'MAC2', [remoteProject])).toEqual(remote)
    expect(sidebarActivity([], empty, empty, 'performance', [remoteProject])).toEqual(remote)
    expect(sidebarActivity([], empty, empty, 'rotom-team', [remoteProject])).toEqual(remote)
    expect(sidebarActivity([], empty, empty, '/remote/', [remoteProject])).toEqual(remote)
    expect(sidebarActivity([], empty, empty, 'missing', [remoteProject])).toEqual([])
  })

  it('does not treat cached, archived, idle or unknown remote sessions as live or completed', () => {
    for (const state of ['disconnected', 'unknown', 'pairing'] as const) {
      expect(sidebarActivity([], empty, empty, '', [{ ...remoteProject, state }])).toEqual([])
    }
    for (const change of [{ isActive: false }, { isActive: undefined }, { archivedAt: 1 }, { externalSessionId: undefined }]) {
      expect(sidebarActivity([], empty, empty, '', [{ ...remoteProject,
        sessions: [{ ...remoteProject.sessions[0], ...change }] }])).toEqual([])
    }
  })

  it('restores host-confirmed completed and non-success sessions to Activity after reconnect, but not unknown history', () => {
    const completed = { ...remoteProject.sessions[0], isActive: false, lastRunId: 'done', lastRunOutcome: 'completed' as const }
    const project = { ...remoteProject, sessions: [completed] }
    expect(sidebarActivity([], empty, empty, '', [{ ...project, state: 'disconnected' }])).toEqual([])
    expect(sidebarActivity([], empty, empty, '', [project])[0]).toMatchObject({ kind: 'remote', group: 'completed' })
    expect(sidebarActivity([], empty, empty, '', [{ ...project, sessions: [{ ...completed, isActive: true }] }])[0].group).toBe('working')
    expect(sidebarActivity([], empty, empty, '', [{ ...project, sessions: [{ ...completed, lastRunOutcome: undefined }] }])).toEqual([])
    for (const lastRunOutcome of ['failed', 'cancelled', 'interrupted'] as const) {
      // The host persisted a terminal non-success: it needs review, not "no activity".
      expect(sidebarActivity([], empty, empty, '', [{ ...project, sessions: [{ ...completed, lastRunOutcome }] }])
        .map((row) => row.group)).toEqual(['updates'])
    }
  })

  it('keeps remote keys stable across titles and pins, but distinct across hosts, profiles, providers and workspaces', () => {
    const session = remoteProject.sessions[0]
    const original = sidebarActivity([], empty, empty, '', [remoteProject])[0].key
    expect(sidebarActivity([], empty, empty, '', [{ ...remoteProject,
      sessions: [{ ...session, label: 'renamed', pinnedAt: undefined }] }])[0].key).toBe(original)
    const rows = sidebarActivity([], empty, empty, '', [remoteProject,
      { ...remoteProject, connection: { ...remoteProject.connection, id: 'mac3' } },
      { ...remoteProject, cwd: '/another' },
      { ...remoteProject, sessions: [{ ...session, providerId: 'codex' }, { ...session, agentProfileId: 'work' }] }
    ])
    expect(new Set(rows.map(row => row.key)).size).toBe(5)
  })

  it('separates native identities across profiles, providers and workspaces', () => {
    const source = projects[0].sessions[0]
    const rows = sidebarActivity([
      { ...projects[0], conversations: [], sessions: [source, { ...source, providerId: 'pi' }, { ...source, agentProfileId: 'work' }, { ...source, cwd: '/work/store-worktree' }] },
      { ...projects[0], cwd: '/different', conversations: [], sessions: [source] }
    ], empty, empty, '')
    expect(new Set(rows.map((row) => row.key)).size).toBe(5)
  })

  it('puts a blocked conversation in attention, outranking its active run', () => {
    const blocked = (blockedReason: string, activeRunId?: string): ProjectMeta[] => [{
      ...projects[0], sessions: [],
      conversations: [{ id: 'blocked', cwd: '/work/store', title: '被阻塞', revision: 3, turnCount: 2,
        ...(activeRunId ? { activeRunId } : {}), blockedReason }]
    }]
    // Each durable block reason the host persists must reach the user, including while a
    // run is still active: attention proves a decision is missing, not that work is moving.
    for (const reason of ['统一对话正在删除或已删除，不能执行', '原生分支结果尚未确认：回执丢失；不会自动重建',
      '投递结果尚未确认，且没有可关联的运行；请重启核查', '当前轮仍在投递']) {
      expect(sidebarActivity(blocked(reason), new Set(['run-blocked']), empty, '').map((row) => row.group))
        .toEqual(['attention'])
      expect(sidebarActivity(blocked(reason, 'run-blocked'), new Set(['run-blocked']), empty, '').map((row) => row.group))
        .toEqual(['attention'])
    }
    // The same conversation without a block reason keeps its liveness reading.
    expect(sidebarActivity(blocked('', 'run-blocked'), new Set(['run-blocked']), empty, '').map((row) => row.group))
      .toEqual(['working'])
  })

  it('keeps a background child run visible without flattening it into a root row', () => {
    const parent = '主会话：重构侧边栏'
    const withChild: ProjectMeta[] = [{
      ...projects[0], sessions: [],
      conversations: [
        { id: 'parent', cwd: '/work/store', title: parent, revision: 1, turnCount: 3 },
        {
          id: 'child', cwd: '/work/store', title: '侧聊：查一下这段 diff', revision: 1, turnCount: 1, activeRunId: 'child-run',
          sideChat: {
            source: { kind: 'conversation', conversationId: 'parent' }, parentTitleAtCapture: parent,
            initialTarget: { providerId: 'claude', permissionMode: 'default' },
            throughOrdinal: 2, throughRunId: 'parent-run', capturedAt: 1,
            prefixFingerprint: 'a'.repeat(64), messageCount: 3
          }
        }
      ]
    }]
    const rows = sidebarActivity(withChild, new Set(['child-run']), empty, '')
    expect(rows.map((row) => [row.kind, row.group, row.kind === 'conversation' ? row.sideChatParent : null]))
      .toEqual([['conversation', 'working', parent]])
    // The child keeps its own identity instead of borrowing the parent row.
    expect(rows[0].kind === 'conversation' && rows[0].conversation.id).toBe('child')
  })

  it('surfaces a host-reported blocked remote run as attention and keeps its terminal failures visible', () => {
    const blocked = { ...remoteProject.sessions[0], isActive: true, pendingQuestions: 1 }
    expect(sidebarActivity([], empty, empty, '', [{ ...remoteProject, sessions: [blocked] }])
      .map((row) => row.group)).toEqual(['attention'])
    const idle = { ...blocked, isActive: false, pendingQuestions: 0 }
    expect(sidebarActivity([], empty, empty, '', [{ ...remoteProject, sessions: [idle] }])).toEqual([])
    for (const lastRunOutcome of ['failed', 'cancelled', 'interrupted'] as const) {
      const terminal = { ...remoteProject.sessions[0], isActive: false, lastRunOutcome }
      expect(sidebarActivity([], empty, empty, '', [{ ...remoteProject, sessions: [terminal] }])
        .map((row) => row.group)).toEqual(['updates'])
    }
  })
})
