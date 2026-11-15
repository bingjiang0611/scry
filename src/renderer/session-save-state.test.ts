import { describe, expect, it } from 'vitest'
import type { ProjectMeta, SessionMeta } from './env'
import { patchProjectSession, sessionRowKey } from './session-save-state'

const session = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ sessionId: id, providerId: 'claude', mtime: 1, preview: `s ${id}`, count: 1, ...extra })
const projects: ProjectMeta[] = [
  { cwd: '/a', name: 'a', mtime: 1, sessions: [session('1'), session('2')] },
  { cwd: '/b', name: 'b', mtime: 1, sessions: [session('1')] }
]

describe('patchProjectSession', () => {
  it('changes only the row with the same cwd, provider, profile and id', () => {
    const next = patchProjectSession(projects, '/a', session('1'), { pinnedAt: 5 })
    expect(next[0].sessions[0].pinnedAt).toBe(5)
    expect(next[0].sessions[1].pinnedAt).toBeUndefined()
    expect(next[1].sessions[0].pinnedAt).toBeUndefined()
  })

  it('removes the row for an optimistic archive', () => {
    const next = patchProjectSession(projects, '/a', session('2'), null)
    expect(next[0].sessions.map((row) => row.sessionId)).toEqual(['1'])
    expect(next[1]).toBe(projects[1])
  })

  it('is a no-op when the row is gone, so a late rollback cannot invent a row', () => {
    expect(patchProjectSession(projects, '/c', session('1'), { pinnedAt: undefined })).toBe(projects)
  })

  it('matches rows grouped under another project root by their own cwd', () => {
    const grouped: ProjectMeta[] = [{ cwd: '/root', name: 'r', mtime: 1, sessions: [session('9', { cwd: '/root/sub' })] }]
    expect(patchProjectSession(grouped, '/root/sub', session('9'), { preview: 'new' })[0].sessions[0].preview).toBe('new')
    expect(sessionRowKey('/x', session('9'))).toBe('/x:claude::9')
  })
})
