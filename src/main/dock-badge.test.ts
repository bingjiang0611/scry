import { describe, expect, it, vi } from 'vitest'
import { DockBadgeState } from './dock-badge'

describe('DockBadgeState', () => {
  it('前台正在查看的会话完成时不增加 badge', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)
    badge.view('session-a', true)

    badge.markTerminal('session-a', {
      windowFocused: true,
      sessionViewed: true,
      needsAttention: true
    })

    expect(badge.count).toBe(0)
    expect(setCount).not.toHaveBeenCalled()
  })

  it('后台完成后重新聚焦窗口会清除当前已展示会话的 badge', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)

    badge.markTerminal('session-a', {
      windowFocused: false,
      sessionViewed: true,
      needsAttention: true
    })
    expect(setCount.mock.calls).toEqual([[1]])

    badge.focusWindow()
    expect(setCount.mock.calls).toEqual([[1], [0]])
    expect(badge.count).toBe(0)
  })

  it('重新聚焦只清除当前会话，保留其他未读会话', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)
    badge.view('session-a', false)
    badge.markTerminal('session-a', {
      windowFocused: false,
      sessionViewed: true,
      needsAttention: true
    })
    badge.markTerminal('session-b', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })

    badge.focusWindow()

    expect(setCount.mock.calls).toEqual([[1], [2], [1]])
    expect(badge.snapshot().unreadSessionKeys).toEqual(['session-b'])
  })

  it('同一会话去重，不同会话独立计数并按查看状态清除', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)

    badge.markTerminal('session-a', {
      windowFocused: true,
      sessionViewed: false,
      needsAttention: true
    })
    badge.markTerminal('session-a', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })
    badge.markTerminal('session-b', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })
    badge.view('session-a', true)

    expect(setCount.mock.calls).toEqual([[1], [2], [1]])
    expect(badge.count).toBe(1)
  })

  it('每次变化都发布带 revision 的会话快照', () => {
    const snapshots = vi.fn()
    const badge = new DockBadgeState(() => {}, snapshots)

    badge.markTerminal('session-a', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })
    badge.markTerminal('session-b', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })
    badge.view('session-a', true)

    expect(snapshots.mock.calls).toEqual([
      [{ revision: 1, unreadSessionKeys: ['session-a'] }],
      [{ revision: 2, unreadSessionKeys: ['session-a', 'session-b'] }],
      [{ revision: 3, unreadSessionKeys: ['session-b'] }]
    ])
    expect(badge.snapshot()).toEqual({ revision: 3, unreadSessionKeys: ['session-b'] })
  })

  it('用户停止的轮次不增加 badge', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)

    badge.markTerminal('session-a', {
      windowFocused: false,
      sessionViewed: true,
      needsAttention: false
    })

    expect(badge.count).toBe(0)
    expect(setCount).not.toHaveBeenCalled()
  })
})
