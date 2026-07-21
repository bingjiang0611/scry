import { describe, expect, it } from 'vitest'
import { firstSessionInProject } from './session-selection'
import type { ProjectMeta } from './env'

describe('firstSessionInProject', () => {
  const projects: ProjectMeta[] = [
    {
      cwd: '/workspace/fixture-repo',
      name: 'fixture-repo',
      mtime: 20,
      sessions: [
        { sessionId: 'newest', externalSessionId: 'newest', providerId: 'claude', mtime: 20, preview: '按顺序做下面每一步', count: 1 },
        { sessionId: 'older', externalSessionId: 'older', providerId: 'codex', mtime: 10, preview: '旧会话', count: 1 }
      ]
    },
    {
      cwd: '/workspace/empty',
      name: 'empty',
      mtime: 1,
      sessions: []
    }
  ]

  it('returns the first session shown for the selected project', () => {
    expect(firstSessionInProject(projects, '/workspace/fixture-repo')?.sessionId).toBe('newest')
  })

  it('returns null when the project has no sessions or is unknown', () => {
    expect(firstSessionInProject(projects, '/workspace/empty')).toBeNull()
    expect(firstSessionInProject(projects, '/workspace/missing')).toBeNull()
  })
})
