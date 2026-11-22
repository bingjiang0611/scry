import { describe, expect, it, vi } from 'vitest'
import type { SubscribeReply, SubscribeRequest } from '../shared/orchestration-subscribe'
import { DaemonEventPump } from './daemon-event-pump'
import { applySubscribeSnapshotToRuntime, readSubscribeTraceOnce, type SubscribeRuntimeContext } from './daemon-run-subscribe'
import type { RunCursor } from './daemon-run-cursor'

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

  it('readSubscribeTraceOnce preserves cursor.pushed when live trace returns run=null and never re-emits archive result', async () => {
    const resultEvent = { id: 'r1:result', runId: 'r1', kind: 'harness' as const, stage: 'result' as const, ts: '2026-01-01T00:00:00Z' }
    const cursor: RunCursor = {
      runId: 'ledger-1',
      scryRunId: 'r1',
      context: { cwd: '/tmp/ws', providerId: 'codex', externalSessionId: 'sess-1' },
      lifecycle: 'dispatched',
      watch: 0,
      output: 1,
      pushed: [resultEvent as never],
      askedQuestions: new Set(),
      answerIds: new Map(),
      resyncRequired: false,
      pumping: false,
      stopped: false,
      sawText: true
    }
    const apply = vi.fn(() => false)
    const archivedRunTrace = vi.fn(async () => ({
      cwd: '/tmp/ws', providerId: 'codex' as const, externalSessionId: 'sess-1',
      runId: 'r1', userText: 'prompt', done: true, items: [resultEvent]
    }))

    // Non-terminal trailing hint after RunRegistry deleted the run: must NOT wipe cursor.pushed
    await readSubscribeTraceOnce({
      cursor,
      runId: 'ledger-1',
      disposed: false,
      transport: { trace: async () => ({ kind: 'snapshot', run: null }), archivedRunTrace },
      apply,
      syncQuestions: async () => undefined,
      flush: vi.fn()
    })
    expect(archivedRunTrace).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(cursor.pushed).toHaveLength(1)

    // The Provider result can precede archived final evidence. On the terminal read,
    // consult the archive once, then keep the already-delivered result deduplicated.
    await readSubscribeTraceOnce({
      cursor,
      runId: 'ledger-1',
      disposed: false,
      terminal: true,
      transport: { trace: async () => ({ kind: 'snapshot', run: null }), archivedRunTrace },
      apply,
      syncQuestions: async () => undefined,
      flush: vi.fn()
    })
    expect(archivedRunTrace).toHaveBeenCalledExactlyOnceWith({ context: cursor.context, runId: 'r1' })
    expect(apply).not.toHaveBeenCalled()
    expect(cursor.pushed).toEqual([resultEvent])
  })

  it('still delivers the hints of a reply whose events include an unknown type', async () => {
    const notice = { id: 'n-u', kind: 'device_approved_via_cli' as const, ts: 1, deviceLabel: 'Phone' }
    const replies: SubscribeReply[] = [
      { hostId: 'h1', logId: 'l1', seq: 5, mode: 'snapshot', snapshot: { activeRuns: { rows: [] } } },
      {
        hostId: 'h1', logId: 'l1', seq: 6, mode: 'events',
        events: [{ seq: 6, type: 'task.requested', stream: 'task:1', at: 100, payload: {} }],
        hints: [{ kind: 'hostNotice', notice }]
      }
    ]
    let idx = 0
    const onHostAdmin = vi.fn()
    const requests: SubscribeRequest[] = []
    const pump = new DaemonEventPump({
      subscribeMode: true,
      source: {
        appEvents: vi.fn(),
        subscribe: async (req) => {
          requests.push(req)
          const next = replies[idx++]
          if (!next) { pump.dispose(); return { hostId: 'h1', logId: 'l1', seq: 6, mode: 'idle' } }
          return next
        }
      },
      send: vi.fn(),
      onHostAdmin,
      waitMs: 50
    })
    pump.start()
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3))
    pump.dispose()
    expect(onHostAdmin).toHaveBeenCalledWith(notice)
    expect(requests[2]?.known).toBeUndefined()
    expect(requests[0]?.views).toEqual(['activeRuns'])
  })

  it('probes cursors a snapshot no longer lists and finalizes only those that ended', async () => {
    const cursor = (runId: string): RunCursor => ({
      runId, lifecycle: 'dispatched', watch: 0, output: 0, pushed: [], askedQuestions: new Set(),
      answerIds: new Map(), resyncRequired: false, pumping: false, stopped: false
    } as unknown as RunCursor)
    const runs = new Map<string, RunCursor>([
      ['gone', cursor('gone')], ['ended', cursor('ended')], ['racing', cursor('racing')], ['listed', cursor('listed')]
    ])
    const probed: string[] = []
    const answers: Record<string, string | null> = { gone: null, ended: 'settled', racing: 'dispatched' }
    const ctx: SubscribeRuntimeContext = {
      runs,
      wakes: { wake: vi.fn() } as unknown as SubscribeRuntimeContext['wakes'],
      cursorFor: (id) => runs.get(id),
      send: vi.fn(),
      flushBridge: vi.fn(),
      scheduleTraceRead: vi.fn(async () => undefined),
      syncQuestions: vi.fn(async () => undefined),
      probeRunState: async (id) => { probed.push(id); return answers[id] ?? null }
    }
    await applySubscribeSnapshotToRuntime(ctx, [{
      runId: 'listed', sessionKey: 's', scope: 'local', origin: 'local', provider: 'codex', profile: null, cwd: '/w',
      promptPreview: null, lifecycle: 'dispatched', stopState: null, outputSeq: 0, intentSeq: 1,
      settledAt: null, recoveredAt: null, outcome: null, revSeq: 1
    } as never])
    expect(probed.sort()).toEqual(['ended', 'gone', 'racing'])
    expect(runs.get('gone')?.stopped).toBe(true)
    expect(runs.get('gone')?.lifecycle).toBe('interrupted')
    expect(runs.get('ended')?.stopped).toBe(true)
    expect(runs.get('ended')?.lifecycle).toBe('settled')
    expect(runs.get('racing')?.stopped).toBe(false)
    expect(runs.get('listed')?.stopped).toBe(false)
  })
})
