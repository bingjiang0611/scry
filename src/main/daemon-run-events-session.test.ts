import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { sessionAttentionKey } from '../shared/session-attention'
import { DockBadgeState } from './dock-badge'
import { startDaemonRunEvents, type DaemonRunEventsDeps } from './daemon-run-events'

// In process, a focused run that learns its native session views it (run-session.ts),
// so the reply the user is watching never counts as unread. In daemon mode the session
// arrives as a window notice; the window must still say the session is on screen.

const KEY = sessionAttentionKey({ providerId: 'codex', cwd: '/w', sessionId: 'native-1' })

function wire(focusedRunId: string | null, windowFocused: boolean) {
  const sessionNotice = { kind: 'window' as const, channel: 'agent:session', payload: { runId: 'turn-1', sessionId: 'native-1', providerId: 'codex' } }
  let calls = 0
  const transport = {
    appEvents: vi.fn(async (_input: unknown, signal?: AbortSignal) => {
      calls += 1
      if (calls === 1) return { epoch: 'e1', cursor: 0, items: [], reset: false }
      if (calls === 2) return { epoch: 'e1', cursor: 1, items: [sessionNotice], reset: false }
      return await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }),
    liveRuns: vi.fn(async () => ({ revision: '0', runs: [] })),
    attentionViewed: vi.fn(async () => true)
  }
  const runtime = {
    wake: vi.fn(), wakeAll: vi.fn(), setWakesLive: vi.fn(), isTracking: () => true, follow: vi.fn(),
    deliverAfterRead: async (_runId: string | undefined, deliver: () => void) => { deliver() }
  }
  const badge = new DockBadgeState(vi.fn())
  badge.setDaemon({ revision: 1, unreadSessionKeys: [] }, false)
  const send = vi.fn()
  const run = { runId: 'turn-1', providerId: 'codex', cwd: '/w', userText: '', items: [], done: false } as unknown as ActiveRun
  const events = startDaemonRunEvents({
    transport, runtime, send, dockBadge: badge, isWindowFocused: () => windowFocused,
    focusedRun: async () => focusedRunId === 'turn-1' ? run : null
  } as unknown as DaemonRunEventsDeps)
  return { events, badge, send, transport }
}

describe('daemon mode: the focused run\'s session is on screen', () => {
  it('does not count the reply the focused window is watching', async () => {
    const { events, badge, send, transport } = wire('turn-1', true)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith('agent:session', expect.objectContaining({ sessionId: 'native-1' })))
      await vi.waitFor(() => expect(badge.snapshot().unreadSessionKeys).toEqual([]))
      // The daemon marks it unread when the turn ends; this window answers it as viewed.
      badge.setDaemon({ revision: 2, unreadSessionKeys: [KEY] }, true)
      expect(transport.attentionViewed).toHaveBeenCalledWith(KEY)
      expect(badge.count).toBe(0)
    } finally {
      events.dispose()
    }
  })

  it('leaves a run the window does not show unread', async () => {
    const { events, badge, send, transport } = wire(null, true)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith('agent:session', expect.anything()))
      await new Promise((resolve) => setTimeout(resolve, 5))
      badge.setDaemon({ revision: 2, unreadSessionKeys: [KEY] }, true)
      expect(transport.attentionViewed).not.toHaveBeenCalled()
      expect(badge.count).toBe(1)
    } finally {
      events.dispose()
    }
  })
})
