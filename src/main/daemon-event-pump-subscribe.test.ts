import { describe, expect, it, vi } from 'vitest'
import type { SubscribeReply, SubscribeRequest } from '../shared/orchestration-subscribe'
import { DaemonEventPump } from './daemon-event-pump'

describe('DaemonEventPump subscribe mode (P4-3 protocol §5.2)', () => {
  it('drops known cursor and pulls a fresh snapshot on an unknown event type', async () => {
    const requests: SubscribeRequest[] = []
    const replies: SubscribeReply[] = [
      { hostId: 'h1', logId: 'l1', seq: 5, mode: 'snapshot', snapshot: { activeRuns: { rows: [] } } },
      {
        hostId: 'h1',
        logId: 'l1',
        seq: 6,
        mode: 'events',
        events: [{ seq: 6, type: 'task.requested', stream: 'task:1', at: 100, payload: {} }]
      },
      { hostId: 'h1', logId: 'l1', seq: 7, mode: 'snapshot', snapshot: { activeRuns: { rows: [] } } }
    ]
    let idx = 0
    const onSnapshot = vi.fn()
    const onSubscribeEvent = vi.fn()
    const send = vi.fn()

    const pump = new DaemonEventPump({
      subscribeMode: true,
      source: {
        appEvents: vi.fn(),
        subscribe: async (req) => {
          requests.push(req)
          const next = replies[idx++]
          if (!next) {
            pump.dispose()
            return { hostId: 'h1', logId: 'l1', seq: 7, mode: 'idle' }
          }
          return next
        }
      },
      send,
      onSnapshot,
      onSubscribeEvent,
      waitMs: 50
    })

    pump.start()
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2))
    pump.dispose()

    expect(onSubscribeEvent).not.toHaveBeenCalled()
    expect(requests[0]?.known).toBeUndefined()
    expect(requests[1]?.known).toEqual({ hostId: 'h1', logId: 'l1', seq: 5 })
    // After encountering unknown event type `task.requested`, known was dropped to force snapshot
    expect(requests[2]?.known).toBeUndefined()
    expect(onSnapshot.mock.calls[1]?.[1]).toMatchObject({ isReset: true, logIdChanged: false })
  })

  it('reports logId change and routes hostNotice / terminal / oauth / attention / window hints', async () => {
    const notice = { id: 'n-1', kind: 'device_revoked_via_cli' as const, ts: 1234, deviceId: 'dev-1' }
    const replies: SubscribeReply[] = [
      { hostId: 'h1', logId: 'log-A', seq: 1, mode: 'snapshot', snapshot: { activeRuns: { rows: [] } } },
      {
        hostId: 'h1',
        logId: 'log-B',
        seq: 1,
        mode: 'snapshot',
        snapshot: { activeRuns: { rows: [] } },
        hints: [
          { kind: 'hostNotice', notice },
          { kind: 'terminal' },
          { kind: 'oauth', url: 'https://example.test/oauth' },
          { kind: 'attention', snapshot: { revision: 2, unreadSessionKeys: ['s1'] } },
          { kind: 'window', channel: 'agent:error', payload: { runId: 'r1', message: 'boom' } }
        ]
      }
    ]
    let idx = 0
    const onLogIdChanged = vi.fn()
    const onHostAdmin = vi.fn()
    const onTerminal = vi.fn()
    const onOAuth = vi.fn()
    const onAttention = vi.fn()
    const onWindow = vi.fn()

    const pump = new DaemonEventPump({
      subscribeMode: true,
      source: {
        appEvents: vi.fn(),
        subscribe: async () => {
          const next = replies[idx++]
          if (!next) {
            pump.dispose()
            return { hostId: 'h1', logId: 'log-B', seq: 1, mode: 'idle' }
          }
          return next
        }
      },
      send: vi.fn(),
      onLogIdChanged,
      onHostAdmin,
      onTerminal,
      onOAuth,
      onAttention,
      onWindow,
      waitMs: 50
    })

    pump.start()
    await vi.waitFor(() => expect(onWindow).toHaveBeenCalledTimes(1))
    pump.dispose()

    expect(onLogIdChanged).toHaveBeenCalledWith('log-A', 'log-B')
    expect(onHostAdmin).toHaveBeenCalledWith(notice)
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onOAuth).toHaveBeenCalledWith('https://example.test/oauth')
    expect(onAttention).toHaveBeenCalledWith({ revision: 2, unreadSessionKeys: ['s1'] })
    expect(onWindow).toHaveBeenCalledWith('agent:error', { runId: 'r1', message: 'boom' })
  })
})
