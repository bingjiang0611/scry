import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { sessionAttentionKey } from '../shared/session-attention'
import { DockBadgeState } from './dock-badge'
import { startDaemonRunEvents } from './daemon-run-events'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'

// In process, a focused run that learns its native session views it (run-session.ts),
// so the reply the user is watching never counts as unread. In daemon mode the session
// arrives through the bound-session event; the window must still say it is on screen.

const KEY = sessionAttentionKey({ providerId: 'codex', cwd: '/w', sessionId: 'native-1' })

function wire(focusedRunId: string | null, windowFocused: boolean) {
  let reads = 0
  const identity = { hostId: 'host', logId: 'log' }
  const transport = new DaemonRunTransport(async (request, options) => {
    if (request.op === 'attentionViewed') return { viewed: true }
    if (request.op !== 'subscribe') throw new Error('unexpected operation')
    if (++reads === 1) return { subscribe: { ...identity, mode: 'snapshot', snapshot: {}, seq: 0 } }
    if (reads === 2) return { subscribe: { ...identity, mode: 'events', seq: 2, events: [
      { seq: 1, type: 'run.intent_recorded', stream: 'run', at: 0, runId: 'turn-1', cwd: '/w', payload: { provider: 'codex' } },
      { seq: 2, type: 'run.session_bound', stream: 'run', at: 0, runId: 'turn-1', payload: { nativeSessionId: 'native-1' } }
    ] } }
    return await new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  vi.spyOn(transport, 'attentionViewed')
  const send = vi.fn()
  const runtime = new DaemonRunRuntime({ transport, send })
  const badge = new DockBadgeState(vi.fn())
  badge.setDaemon({ revision: 1, unreadSessionKeys: [] }, false)
  const run = { runId: 'turn-1', providerId: 'codex', cwd: '/w', userText: '', items: [], done: false } as unknown as ActiveRun
  const events = startDaemonRunEvents({
    transport, runtime, send, dockBadge: badge, isWindowFocused: () => windowFocused,
    focusedRun: async () => focusedRunId === 'turn-1' ? run : null
  })
  return { dispose: () => { events.dispose(); runtime.dispose() }, badge, send, transport }
}

describe('daemon mode: the focused run\'s session is on screen', () => {
  it('does not count the reply the focused window is watching', async () => {
    const { dispose, badge, send, transport } = wire('turn-1', true)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith('agent:session', expect.objectContaining({ sessionId: 'native-1' })))
      await vi.waitFor(() => expect(badge.snapshot().unreadSessionKeys).toEqual([]))
      // The daemon marks it unread when the turn ends; this window answers it as viewed.
      badge.setDaemon({ revision: 2, unreadSessionKeys: [KEY] }, true)
      expect(transport.attentionViewed).toHaveBeenCalledWith(KEY)
      expect(badge.count).toBe(0)
    } finally {
      dispose()
    }
  })

  it('leaves a run the window does not show unread', async () => {
    const { dispose, badge, send, transport } = wire(null, true)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith('agent:session', expect.anything()))
      await new Promise((resolve) => setTimeout(resolve, 5))
      badge.setDaemon({ revision: 2, unreadSessionKeys: [KEY] }, true)
      expect(transport.attentionViewed).not.toHaveBeenCalled()
      expect(badge.count).toBe(1)
    } finally {
      dispose()
    }
  })
})
