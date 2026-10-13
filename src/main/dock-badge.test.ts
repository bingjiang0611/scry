import { describe, expect, it, vi } from 'vitest'
import { DockBadgeState } from './dock-badge'

describe('DockBadgeState', () => {
  it('启动同步清除系统残留角标，不制造未读状态变化', () => {
    let nativeCount = 1
    const snapshots = vi.fn()
    const badge = new DockBadgeState((count) => { nativeCount = count }, snapshots)

    badge.sync()

    expect(nativeCount).toBe(0)
    expect(badge.snapshot()).toEqual({ revision: 0, unreadSessionKeys: [] })
    expect(snapshots).not.toHaveBeenCalled()
  })

  it('同步以当前未读计数为准，不清除未查看的其他会话', () => {
    const setCount = vi.fn()
    const snapshots = vi.fn()
    const badge = new DockBadgeState(setCount, snapshots)
    badge.markAttention('session-a', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })
    const snapshot = badge.snapshot()
    setCount.mockClear()
    snapshots.mockClear()

    badge.sync()

    expect(setCount.mock.calls).toEqual([[1]])
    expect(badge.snapshot()).toEqual(snapshot)
    expect(snapshots).not.toHaveBeenCalled()
  })

  it('前台正在查看的会话完成时不增加 badge', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)
    badge.view('session-a', true)

    badge.markAttention('session-a', {
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

    badge.markAttention('session-a', {
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
    badge.markAttention('session-a', {
      windowFocused: false,
      sessionViewed: true,
      needsAttention: true
    })
    badge.markAttention('session-b', {
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

    badge.markAttention('session-a', {
      windowFocused: true,
      sessionViewed: false,
      needsAttention: true
    })
    badge.markAttention('session-a', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })
    badge.markAttention('session-b', {
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

    badge.markAttention('session-a', {
      windowFocused: false,
      sessionViewed: false,
      needsAttention: true
    })
    badge.markAttention('session-b', {
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

  it('后台待回答按会话去重，查看后只清除该会话', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)
    const background = { windowFocused: true, sessionViewed: false, needsAttention: true }

    badge.markAttention('question-session', background)
    badge.markAttention('question-session', background)
    badge.markAttention('completed-session', background)
    expect(badge.snapshot().unreadSessionKeys).toEqual(['question-session', 'completed-session'])

    badge.view('question-session', true)
    expect(setCount.mock.calls).toEqual([[1], [2], [1]])
    expect(badge.snapshot().unreadSessionKeys).toEqual(['completed-session'])
  })

  it('待回答先于原生 session ID 时迁移提醒，避免重复计数和残留', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)
    badge.view('run-id', false)
    badge.markAttention('run-id', { windowFocused: false, sessionViewed: true, needsAttention: true })

    badge.rekey('run-id', 'native-session')
    expect(badge.snapshot().unreadSessionKeys).toEqual(['native-session'])
    badge.markAttention('native-session', { windowFocused: false, sessionViewed: true, needsAttention: true })
    expect(badge.count).toBe(1)
    badge.focusWindow()
    expect(badge.count).toBe(0)
  })

  it('后台会话获取原生 ID 不会改变当前查看的会话，已有目标提醒合并', () => {
    const badge = new DockBadgeState(() => {})
    badge.view('viewed-session', false)
    const background = { windowFocused: false, sessionViewed: false, needsAttention: true }
    badge.markAttention('run-id', background)
    badge.markAttention('native-session', background)

    badge.rekey('run-id', 'native-session')
    badge.focusWindow()
    expect(badge.snapshot().unreadSessionKeys).toEqual(['native-session'])
  })

  it('用户停止的轮次不增加 badge', () => {
    const setCount = vi.fn()
    const badge = new DockBadgeState(setCount)

    badge.markAttention('session-a', {
      windowFocused: false,
      sessionViewed: true,
      needsAttention: false
    })

    expect(badge.count).toBe(0)
    expect(setCount).not.toHaveBeenCalled()
  })
})
