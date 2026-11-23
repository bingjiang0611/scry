import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { announceRun, runEvent } from './daemon-run-subscription.fixtures'
import { TraceOutputBridge } from './trace-output'

// Streaming in daemon mode (L1).
//
// Output hints progress even between lifecycle events. A growing item arrives as a
// tail whether the canonical trace read returns a delta or a snapshot.

const RUN = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CANONICAL = 'remote-run-mw6osn9o-0'

function textItem(text: string): TraceEvent {
  return { id: 'e-text', ts: '2024-01-01T00:00:00.000Z', runId: CANONICAL, kind: 'model', stage: 'text_delta', messageId: 'm-1', text }
}

function fixture(trace: unknown[]) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  let traceCall = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded' }
    if (payload.op === 'desktop') return { desktop: trace[traceCall++] ?? { kind: 'trace', run: null } }
    return { error: 'unknown_op' }
  }
  const warnings: string[] = []
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: (channel, payload) => sent.push({ channel, payload }),
    onWarn: (message, detail) => warnings.push(`${message}: ${String(detail)}`),
    bridge: new TraceOutputBridge({
      canSend: () => true,
      send: (payload) => sent.push({ channel: 'agent:trace', payload }),
      schedule: (fn) => { fn(); return () => {} }
    })
  })
  return { runtime, sent, warnings }
}

function deliveredText(sent: Array<{ channel: string; payload: unknown }>): string[] {
  return sent.filter((entry) => entry.channel === 'agent:trace').flatMap((entry) => (entry.payload as { events?: TraceEvent[] }).events ?? [])
    .filter((event) => event.stage === 'text_delta' || event.stage === 'text').map((event) => event.text ?? '')
}

const run = (text: string, done = false) => ({ runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [textItem(text)], done, providerSettled: false })

describe('daemon run streaming (L1: text arrives as it grows)', () => {
  it('delivers each growth of a message as its own event', async () => {
    const { runtime, sent, warnings } = fixture([
        { kind: 'trace', run: run('chunk 1\n'), cursor: { revision: 'r1', count: 1 } },
        { kind: 'trace_delta', run: { ...run('chunk 1\n'), items: undefined }, base: 'r1', revision: 'r2', count: 1, changes: [{ index: 0, item: textItem('chunk 1\nchunk 2\n') }] },
        // The last read is a snapshot, which is what a cursor reset returns: the
        // growth it carries must not be dropped for being "already delivered".
        { kind: 'trace', run: run('chunk 1\nchunk 2\nchunk 3\n'), cursor: { revision: 'r3', count: 1 } }
    ])
    await announceRun(runtime, RUN, { scryRunId: CANONICAL, outputSeq: 1 })
    await announceRun(runtime, RUN, { scryRunId: CANONICAL, outputSeq: 2 })
    await runtime.applySubscribeEvent(runEvent('run.settled', RUN))
    await runtime.terminalDelivered(RUN)
    expect(runtime.runView(CANONICAL)?.done).toBe(true)
    runtime.dispose()
    expect(warnings).toEqual([])
    expect(deliveredText(sent)).toEqual(['chunk 1\n', 'chunk 2\n', 'chunk 3\n'])
  })
})
