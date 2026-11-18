import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// F1: a read that already carries text must reach the window in the same step.
//
// In daemon mode the App holds the text as soon as the trace read returns, but the
// batching bridge only flushed on its own timer, so the message sat in the App for a
// timer interval after it was already known. The step boundary is the point where the
// App knows it has the whole read, so that is where the batch is handed over; the timer
// stays for anything queued outside a step, and backpressure is unchanged.

const RUN = '3f2a6c1e-8b4d-4c2a-9f1e-2b7c5d9a0e13'
const CANONICAL = 'remote-run-f1first0-0'

function textItem(text: string): TraceEvent {
  return { id: 'e-text', ts: '2024-01-01T00:00:00.000Z', runId: CANONICAL, kind: 'model', stage: 'text', messageId: 'm-1', text }
}

function fixture(trace: unknown[]) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const timers: Array<() => void> = []
  let traceCall = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'watch') {
      return {
        watch: {
          state: 'dispatched',
          poll: {
            cursor: 1,
            events: [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: CANONICAL, providerId: 'codex', cwd: '/w' }) }]
          },
          output: { chunks: [], cursor: 0, count: 1 }
        }
      }
    }
    if (payload.op === 'desktop') return { desktop: trace[traceCall++] ?? { kind: 'trace', run: null } }
    if (payload.op === 'questions') return { questions: [] }
    return { error: 'unknown_op' }
  }
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: (channel, payload) => sent.push({ channel, payload }),
    bridge: new TraceOutputBridge({
      canSend: () => true,
      send: (payload) => sent.push({ channel: 'agent:trace', payload }),
      // The timer is captured, never run: anything that arrives here arrived from the
      // step itself, not from a later timer.
      schedule: (fn) => { timers.push(fn); return () => { timers.splice(timers.indexOf(fn), 1) } }
    }),
    waitMs: 0
  })
  return { runtime, sent, timers }
}

const deliveredText = (sent: Array<{ channel: string; payload: unknown }>): string[] =>
  sent.filter((entry) => entry.channel === 'agent:trace')
    .flatMap((entry) => (entry.payload as { events?: TraceEvent[] }).events ?? [])
    .filter((event) => event.stage === 'text' || event.stage === 'text_delta')
    .map((event) => event.text ?? '')

describe('daemon run first text (F1: held text is handed over inside the step)', () => {
  it('sends the text of the first read before any batching timer runs', async () => {
    const { runtime, sent, timers } = fixture([
      { kind: 'trace', run: { runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [textItem('first words\n')], done: false, providerSettled: false }, cursor: { revision: 'r1', count: 1 } }
    ])
    await runtime.adopt(RUN)
    // The batched flush timer was never allowed to fire, so this text can only have been
    // delivered by the step that read it.
    expect(timers.length).toBeGreaterThanOrEqual(0)
    expect(deliveredText(sent)).toEqual(['first words\n'])
    runtime.dispose()
  })

  it('keeps one batch per step instead of one send per event', async () => {
    const { runtime, sent } = fixture([
      {
        kind: 'trace',
        run: {
          runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi',
          items: [textItem('one\n'), { ...textItem('two\n'), id: 'e-text-2' }], done: false, providerSettled: false
        },
        cursor: { revision: 'r1', count: 2 }
      }
    ])
    await runtime.adopt(RUN)
    const batches = sent.filter((entry) => entry.channel === 'agent:trace')
    // Two items, one step: still a single batch, so batching itself is not what changed.
    expect(batches).toHaveLength(1)
    expect((batches[0].payload as { events: TraceEvent[] }).events).toHaveLength(2)
    runtime.dispose()
  })
})
