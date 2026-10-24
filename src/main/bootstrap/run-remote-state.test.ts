import { describe, expect, it, vi } from 'vitest'
import { createRemoteRunState } from './run-remote-state'

describe('run terminal attention', () => {
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
      dockBadge: { markAttention },
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
