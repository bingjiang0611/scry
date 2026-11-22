import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'
import { isConversationRunId } from './daemon-run-evidence'

// A conversation or side-chat send belongs to its conversation view. In process it never
// reached the window-wide (legacy focus) trace stream, whose main pane adopts the first
// run it hears from; with the daemon it did, and a running side chat took over the parent
// pane (its composer turned into "queue" and its Agent picker locked). Device and App runs
// still travel on that stream (P3f E3).

const LEDGER = '3f2a6c1e-8b4d-4c2a-9f1e-2b7c5d9a0e13'

function fixture(scryRunId: string) {
  const legacy: TraceEvent[] = []
  const scoped: TraceEvent[] = []
  let reads = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'watch') {
      return { watch: { state: 'dispatched', poll: { cursor: 1, events: [{ runId: LEDGER, kind: 'run_progress',
        detail: JSON.stringify({ event: 'bound', ledgerRunId: LEDGER, scryRunId, providerId: 'codex', cwd: '/w' }) }] },
      output: { chunks: [], cursor: 0, count: 1 } } }
    }
    if (payload.op === 'desktop') {
      return { desktop: reads++ === 0 ? { kind: 'trace', run: { runId: scryRunId, providerId: 'codex', cwd: '/w', userText: 'hi',
        items: [{ id: 'e-1', ts: '2024-01-01T00:00:00.000Z', runId: scryRunId, kind: 'model', stage: 'text', messageId: 'm-1', text: 'child words' }],
        done: false, providerSettled: false }, cursor: { revision: 'r1', count: 1 } } : { kind: 'trace', run: null } }
    }
    if (payload.op === 'questions') return { questions: [] }
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
    runTraces: { route: (event: TraceEvent) => { scoped.push(event) }, settle: () => undefined } as never,
    waitMs: 0
  })
  return { runtime, legacy, scoped }
}

describe('conversation runs on the window-wide trace stream', () => {
  it('names a conversation run by its turn UUID, never an App or device run', () => {
    expect(isConversationRunId('d428f668-cf65-493b-bc39-92a8ea149edd', LEDGER)).toBe(true)
    expect(isConversationRunId('remote-run-mwqm0k6u-0', LEDGER)).toBe(false)
    expect(isConversationRunId('run-abc-1', LEDGER)).toBe(false)
    // Not bound yet, or bound to its own ledger id: nothing proves a conversation run.
    expect(isConversationRunId(undefined, LEDGER)).toBe(false)
    expect(isConversationRunId(LEDGER, LEDGER)).toBe(false)
  })

  it('delivers a conversation run to its scoped view only', async () => {
    const { runtime, legacy, scoped } = fixture('d428f668-cf65-493b-bc39-92a8ea149edd')
    await runtime.adopt(LEDGER)
    expect(scoped.map((event) => event.text)).toEqual(['child words'])
    expect(legacy).toEqual([])
    runtime.dispose()
  })

  it('keeps App and device runs on the window-wide stream', async () => {
    const { runtime, legacy, scoped } = fixture('remote-run-phone0-0')
    await runtime.adopt(LEDGER)
    expect(legacy.map((event) => event.text)).toEqual(['child words'])
    expect(scoped.map((event) => event.text)).toEqual(['child words'])
    runtime.dispose()
  })
})
