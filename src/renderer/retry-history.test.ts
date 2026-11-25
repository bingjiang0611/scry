import { describe, expect, it } from 'vitest'
import { retryHistoryAction, retryHistoryFor } from './retry-history'
import type { ProjectMeta } from '../preload'

const projects = [
  { cwd: '/w/a', sessions: [{ sessionId: 's-1', cwd: '/w/a' }, { sessionId: 's-2', cwd: '/w/b' }] }
] as unknown as readonly ProjectMeta[]

describe('retry history lookup', () => {
  it('finds the row only when the session id and cwd both match', () => {
    expect(retryHistoryFor(projects, 's-1', '/w/a')?.row.sessionId).toBe('s-1')
    expect(retryHistoryFor(projects, 's-1', '/w/b')).toBeUndefined()
    expect(retryHistoryFor(projects, null, '/w/a')).toBeUndefined()
  })

  // The action exists only for an error gap: a loading gap has nothing to retry.
  it('offers the action only while the evidence gap is an error', () => {
    expect(retryHistoryAction(projects, 's-1', '/w/a', 'error')?.row.sessionId).toBe('s-1')
    expect(retryHistoryAction(projects, 's-1', '/w/a', 'loading')).toBeUndefined()
    expect(retryHistoryAction(projects, 's-1', '/w/a', undefined)).toBeUndefined()
  })
})
