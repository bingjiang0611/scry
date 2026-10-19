import { describe, expect, it } from 'vitest'
import { activityGroups, sidebarActivity } from './sidebar-activity'
import type { ProjectMeta } from './env'

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
    expect(activityGroups.map((group) => group.label)).toEqual(['需要回复', '进行中', '已完成'])
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

  it('excludes unknown, failed, cancelled and interrupted history instead of claiming success', () => {
    for (const lastRunOutcome of [undefined, 'failed', 'cancelled', 'interrupted'] as const) {
      const source = [{ ...projects[0],
        sessions: [{ ...projects[0].sessions[0], lastRunOutcome }],
        conversations: [{ ...projects[0].conversations![0], activeRunId: undefined, lastRunOutcome }]
      }]
      expect(sidebarActivity(source, empty, empty, '')).toEqual([])
      expect(sidebarActivity(source, new Set(['run-a']), empty, '')[0].group).toBe('working')
    }
    const completed = [{ ...projects[0], sessions: [], conversations: [
      { ...projects[0].conversations![0], activeRunId: undefined, lastRunOutcome: 'completed' as const }
    ] }]
    expect(sidebarActivity(completed, empty, empty, '')[0].group).toBe('completed')
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
      { ...projects[0], conversations: [], sessions: [source, { ...source, providerId: 'pi' }, { ...source, agentProfileId: 'work' }] },
      { ...projects[0], cwd: '/different', conversations: [], sessions: [source] }
    ], empty, empty, '')
    expect(new Set(rows.map((row) => row.key)).size).toBe(4)
  })
})
