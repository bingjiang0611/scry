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

  it('后台完成时增加 badge，窗口重新聚焦后清除当前会话', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)
    badge.view('session-a', false)

    badge.markTerminal('session-a', {
      windowFocused: false,
      sessionViewed: true,
      needsAttention: true
    })
    badge.focusWindow()

    expect(setCount.mock.calls).toEqual([[1], [0]])
    expect(badge.count).toBe(0)
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
