import { describe, expect, it } from 'vitest'
import { activityGroups, sidebarActivity } from './sidebar-activity'
import type { ProjectMeta } from './env'

const projects: ProjectMeta[] = [{
  cwd: '/work/store', name: 'Store', mtime: 3,
  sessions: [
    { sessionId: 'first', providerId: 'claude', preview: '修复布局', mtime: 3, count: 1, runId: 'run-a', pinnedAt: 1 },
    { sessionId: 'second', providerId: 'pi', preview: 'Update API', mtime: 2, count: 1, runId: 'old-run' },
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
      ['conversation', 'attention'], ['session', 'attention'], ['session', 'recent']
    ])
    expect(activityGroups.map((group) => group.label)).toEqual(['等待回复', '运行中', '最近'])
    expect(sidebarActivity(projects, new Set(['run-a']), empty, '').map((row) => row.group))
      .toEqual(['working', 'working', 'recent'])
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

  it('separates native identities across profiles, providers and workspaces', () => {
    const source = projects[0].sessions[0]
    const rows = sidebarActivity([
      { ...projects[0], conversations: [], sessions: [source, { ...source, providerId: 'pi' }, { ...source, agentProfileId: 'work' }] },
      { ...projects[0], cwd: '/different', conversations: [], sessions: [source] }
    ], empty, empty, '')
    expect(new Set(rows.map((row) => row.key)).size).toBe(4)
  })
})
