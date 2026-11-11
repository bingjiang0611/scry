import { describe, expect, it, vi } from 'vitest'
import { DockBadgeState, unreadSessionsAnswerWhenKnown } from './dock-badge'

// be81d57 verification: every daemon-mode start logged an agent:unreadSessions error,
// because the renderer asks before the daemon's first unread snapshot arrives. The answer
// now waits briefly for it; only a daemon that never says stays a named absence.

describe('unread sessions at daemon-mode start', () => {
  it('answers once the first daemon snapshot arrives, instead of failing first', async () => {
    const badge = new DockBadgeState(vi.fn())
    // A long wait, so only the snapshot itself can end it in time.
    const answer = unreadSessionsAnswerWhenKnown(badge, true, 60_000)
    badge.setDaemon({ revision: 1, unreadSessionKeys: ['k'] }, false)
    const late = new Promise((resolve) => setTimeout(() => resolve('late'), 200))
    await expect(Promise.race([answer, late])).resolves.toMatchObject({ unreadSessionKeys: ['k'] })
  })

  it('stays a named absence when the daemon never says, and in process answers at once', async () => {
    const badge = new DockBadgeState(vi.fn())
    await expect(unreadSessionsAnswerWhenKnown(badge, true, 20)).rejects.toThrow('daemon_capability_unavailable:agent:unreadSessions')
    await expect(unreadSessionsAnswerWhenKnown(badge, false, 1_000)).resolves.toEqual({ revision: 0, unreadSessionKeys: [] })
  })
})
