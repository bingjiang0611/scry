import { describe, expect, it, vi } from 'vitest'
import { DockBadgeState } from './dock-badge'

// A unified conversation shows one native session per Provider binding. Its runs are
// never the window's focused run, so without being told what the conversation shows,
// every reply it receives stays unread for good, in both modes.

const attention = (windowFocused: boolean) => ({ windowFocused, sessionViewed: false, needsAttention: true })
const MAIN = { id: 'main:c1', main: true }
const SIDE = { id: 'side:c2', main: false }

describe('DockBadgeState: a conversation on screen', () => {
  it('does not count a reply in a session the focused conversation shows', () => {
    const badge = new DockBadgeState(vi.fn())
    badge.viewSessions(MAIN, ['codex|/w|a', 'claude|/w|b'], true)
    badge.markAttention('claude|/w|b', attention(true))
    expect(badge.count).toBe(0)
    // A session outside the conversation still counts.
    badge.markAttention('other', attention(true))
    expect(badge.count).toBe(1)
  })

  it('clears what the conversation shows when it opens, or when the window regains focus', () => {
    const badge = new DockBadgeState(vi.fn())
    badge.markAttention('codex|/w|a', attention(false))
    badge.markAttention('claude|/w|b', attention(false))
    badge.markAttention('other', attention(false))
    badge.viewSessions(MAIN, ['codex|/w|a'], true)
    expect(badge.snapshot().unreadSessionKeys).toEqual(['claude|/w|b', 'other'])
    badge.viewSessions(MAIN, ['codex|/w|a', 'claude|/w|b'], false)
    expect(badge.count).toBe(2)
    badge.focusWindow()
    expect(badge.snapshot().unreadSessionKeys).toEqual(['other'])
  })

  it('in the main pane replaces the viewed session; a side chat sits beside it', () => {
    const badge = new DockBadgeState(vi.fn())
    badge.view('single', true)
    badge.viewSessions(SIDE, ['side|/w|s'], true)
    badge.markAttention('single', attention(true))
    badge.markAttention('side|/w|s', attention(true))
    expect(badge.count).toBe(0)
    badge.viewSessions(MAIN, ['codex|/w|a'], true)
    badge.markAttention('single', attention(true))
    expect(badge.snapshot().unreadSessionKeys).toEqual(['single'])
  })

  it('forgets a conversation once it closes, and nothing it did not show', () => {
    const badge = new DockBadgeState(vi.fn())
    badge.viewSessions(MAIN, ['codex|/w|a'], true)
    badge.viewSessions(SIDE, ['side|/w|s'], true)
    badge.view('single', true)
    badge.viewSessions(MAIN, [], true)
    badge.markAttention('codex|/w|a', attention(true))
    badge.markAttention('side|/w|s', attention(true))
    badge.markAttention('single', attention(true))
    expect(badge.snapshot().unreadSessionKeys).toEqual(['codex|/w|a'])
  })

  it('in daemon mode, tells the daemon what the focused conversation shows', () => {
    const viewed = vi.fn()
    const badge = new DockBadgeState(vi.fn())
    badge.bindDaemon(viewed)
    badge.setDaemon({ revision: 1, unreadSessionKeys: ['codex|/w|a', 'other'] }, true)
    badge.viewSessions(MAIN, ['codex|/w|a'], true)
    expect(viewed).toHaveBeenCalledWith('codex|/w|a')
    expect(badge.snapshot().unreadSessionKeys).toEqual(['other'])
    // A later snapshot naming it again is answered as viewed, not counted.
    viewed.mockClear()
    badge.setDaemon({ revision: 2, unreadSessionKeys: ['codex|/w|a', 'other'] }, true)
    expect(viewed).toHaveBeenCalledWith('codex|/w|a')
    expect(badge.count).toBe(1)
  })
})
