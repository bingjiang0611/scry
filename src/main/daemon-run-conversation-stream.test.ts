import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { announceRun } from './daemon-run-subscription.fixtures'
import { TraceOutputBridge } from './trace-output'
import { isConversationRunId } from './daemon-run-evidence'
import { publishQuestions } from './daemon-run-questions'
import type { RunCursor } from './daemon-run-cursor'

// A conversation or side-chat send belongs to its conversation view. In process it never
// reached the window-wide (legacy focus) trace stream, whose main pane adopts the first
// run it hears from; with the daemon it did, and a running side chat took over the parent
// pane (its composer turned into "queue" and its Agent picker locked). Device and App runs
// still travel on that stream (P3f E3).

const LEDGER = '3f2a6c1e-8b4d-4c2a-9f1e-2b7c5d9a0e13'

function fixture(scryRunId: string, conversationId?: string) {
  const legacy: TraceEvent[] = []
  const scoped: TraceEvent[] = []
  let reads = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'desktop') {
      return { desktop: reads++ === 0 ? { kind: 'trace', run: { runId: scryRunId, providerId: 'codex', cwd: '/w', userText: 'hi', conversationId,
        items: [{ id: 'e-1', ts: '2024-01-01T00:00:00.000Z', runId: scryRunId, kind: 'model', stage: 'text', messageId: 'm-1', text: 'child words' }],
        done: false, providerSettled: false }, cursor: { revision: 'r1', count: 1 } } : { kind: 'trace', run: null } }
    }
    return { error: 'unknown_op' }
  }
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: () => undefined,
    bridge: new TraceOutputBridge({
      canSend: () => true,
      send: (payload) => legacy.push(...((payload as { events?: TraceEvent[] }).events ?? [])),
      publishHealth: () => undefined,
      schedule: () => () => undefined
    }),
    runTraces: { route: (event: TraceEvent) => { scoped.push(event) }, settle: () => undefined } as never
  })
  return { runtime, legacy, scoped }
}

describe('conversation runs on the window-wide trace stream', () => {
  it('names a conversation run by its turn UUID, never an App or device run', () => {
    expect(isConversationRunId('d428f668-cf65-493b-bc39-92a8ea149edd', LEDGER)).toBe(true)
    expect(isConversationRunId('remote-run-mwqm0k6u-0', LEDGER)).toBe(false)
    expect(isConversationRunId('run-abc-1', LEDGER)).toBe(false)
    expect(isConversationRunId(undefined, LEDGER)).toBe(false)
    expect(isConversationRunId(LEDGER, LEDGER)).toBe(false)
  })

  it('delivers a conversation run to its scoped view only', async () => {
    const { runtime, legacy, scoped } = fixture('d428f668-cf65-493b-bc39-92a8ea149edd')
    await announceRun(runtime, LEDGER, { scryRunId: 'd428f668-cf65-493b-bc39-92a8ea149edd' })
    expect(scoped.map((event) => event.text)).toEqual(['child words'])
    expect(legacy).toEqual([])
    runtime.dispose()
  })

  it('keeps an orchestrated conversation scoped when the ledger id is its canonical id', async () => {
    const { runtime, legacy, scoped } = fixture(LEDGER)
    await runtime.applySubscribeEvent({
      type: 'run.intent_recorded', stream: 'run', seq: 1, at: 1, runId: LEDGER, cwd: '/w',
      payload: { provider: 'codex', isConversationRun: true }
    })
    runtime.applyRunHint({ kind: 'run', runId: LEDGER, scryRunId: LEDGER, admitted: true, outputSeq: 1 })
    await expect.poll(() => scoped.map(event => event.text)).toEqual(['child words'])
    runtime.bridge.flushAll()
    expect(legacy).toEqual([])
    runtime.dispose()
  })

  it('learns the conversation scope from the live authority after a reconnect', async () => {
    const { runtime, legacy, scoped } = fixture(LEDGER, 'conversation-1')
    runtime.applyRunHint({ kind: 'run', runId: LEDGER, scryRunId: LEDGER, admitted: true, outputSeq: 1, cwd: '/w', providerId: 'codex' })
    await expect.poll(() => scoped.map(event => event.text)).toEqual(['child words'])
    runtime.bridge.flushAll()
    expect(legacy).toEqual([])
    runtime.dispose()
  })

  it('keeps App and device runs on the window-wide stream', async () => {
    const { runtime, legacy, scoped } = fixture('remote-run-phone0-0')
    await announceRun(runtime, LEDGER, { scryRunId: 'remote-run-phone0-0' })
    expect(legacy.map((event) => event.text)).toEqual(['child words'])
    expect(scoped.map((event) => event.text)).toEqual(['child words'])
    runtime.dispose()
  })

  it('asks a conversation run question in its own view only, and an App run question in the window', async () => {
    const question = { runId: LEDGER, questionId: 'q-1', title: 'allow?', options: [] }
    for (const [scryRunId, windowWide] of [['d428f668-cf65-493b-bc39-92a8ea149edd', false], [LEDGER, false], ['remote-run-phone0-0', true]] as const) {
      const cursor = { runId: LEDGER, scryRunId, scopedDelivery: scryRunId === LEDGER ? true : undefined,
        admitted: true, lifecycle: 'dispatched', askedQuestions: new Set(), answerIds: new Map(),
        pushed: [], output: 0, resyncRequired: false, stopped: false, sawText: false } as unknown as RunCursor
      const sent: string[] = []
      const scoped: string[] = []
      const sinks = { send: (channel: string) => { sent.push(channel) }, subscription: {
        publishQuestion: () => { scoped.push('open') }, publishQuestionClosed: () => { scoped.push('closed') } } }
      await publishQuestions(cursor, [question] as never, sinks)
      await publishQuestions(cursor, [], sinks)
      expect(scoped).toEqual(['open', 'closed'])
      expect(sent).toEqual(windowWide
        ? ['agent:questionAttention', 'agent:userQuestion', 'agent:questionAttention', 'agent:userQuestionClosed']
        : ['agent:questionAttention', 'agent:questionAttention'])
    }
  })
})
