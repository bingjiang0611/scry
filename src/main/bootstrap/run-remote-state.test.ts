import { describe, expect, it, vi } from 'vitest'
import { createRemoteRunState } from './run-remote-state'
import { DockBadgeState } from '../dock-badge'

describe('run terminal attention', () => {
  it('tracks managed attention by conversation, clears only the opened conversation, and respects visibility', () => {
    const badge = new DockBadgeState(() => {})
    const runtime = (conversationId: string) => createRemoteRunState({
      isRemoteRun: false,
      runId: `run-${conversationId}`,
      providerId: 'claude',
      runtimeProvider: 'claude_sdk',
      runState: { runId: `run-${conversationId}`, conversationId, userText: 'task', items: [], done: false },
      getObservedSessionId: () => 'native-session',
      getWindow: () => ({ isFocused: () => true }),
      dockBadge: badge,
      scopedSessionKey: (id) => `native:${id}`,
      // Unified views subscribe to their run without adopting the legacy focus.
      runs: { isViewed: () => false }
    })
    const first = runtime('first')
    const second = runtime('second')
    first.markTerminalAttention('native-session', true)
    second.markTerminalAttention('another-native-session', true)
    expect(badge.snapshot().unreadSessionKeys).toEqual(['conversation\0first', 'conversation\0second'])

    badge.view('conversation\0first', true)
    expect(badge.snapshot().unreadSessionKeys).toEqual(['conversation\0second'])
    first.markTerminalAttention('new-native-session-after-provider-switch', true)
    expect(badge.count).toBe(1)

    badge.view(null, true)
    first.markTerminalAttention('new-native-session-after-provider-switch', true)
    expect(badge.count).toBe(2)
  })

  it('uses the current window after the run outlives a closed renderer', () => {
    let closed = false
    const firstWindow = {
      isFocused: () => {
        if (closed) throw new Error('Object has been destroyed')
        return true
      }
    }
    let currentWindow: { isFocused: () => boolean } | null = firstWindow
    const markAttention = vi.fn()
    const runtime = createRemoteRunState({
      isRemoteRun: false,
      runId: 'run-attention',
      providerId: 'claude',
      runtimeProvider: 'claude_sdk',
      runState: { runId: 'run-attention', userText: 'task', items: [], done: false },
      getObservedSessionId: () => 'session',
      getWindow: () => currentWindow,
      dockBadge: { markAttention, isViewed: () => false },
      scopedSessionKey: (id) => `scope:${id}`,
      runs: { isViewed: () => false }
    })

    runtime.markTerminalAttention('session', true)
    expect(markAttention).toHaveBeenLastCalledWith('scope:session', {
      windowFocused: true, sessionViewed: false, needsAttention: true
    })
    closed = true
    currentWindow = null
    runtime.markTerminalAttention('session', true)
    expect(markAttention).toHaveBeenLastCalledWith('scope:session', {
      windowFocused: false, sessionViewed: false, needsAttention: true
    })
    currentWindow = { isFocused: () => false }
    runtime.markTerminalAttention('session', false)
    expect(markAttention).toHaveBeenLastCalledWith('scope:session', {
      windowFocused: false, sessionViewed: false, needsAttention: false
    })
  })
})
