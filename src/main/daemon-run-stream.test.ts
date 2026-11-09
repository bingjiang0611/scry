import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// Streaming in daemon mode (L1).
//
// The ledger only moves at lifecycle points, so a watch that waits on it alone hears
// nothing while the Provider writes text: the renderer saw the first chunk and then
// nothing until the message ended. Content wakes the poll instead, and a growing item
// must arrive as a tail whether the daemon answers with a delta or a snapshot.

const RUN = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CANONICAL = 'remote-run-mw6osn9o-0'
const CONTEXT = { cwd: '/w', providerId: 'codex' }

function textItem(text: string): TraceEvent {
  return { id: 'e-text', ts: '2024-01-01T00:00:00.000Z', runId: CANONICAL, kind: 'model', stage: 'text_delta', messageId: 'm-1', text }
}

function fixture(frames: { watch: Array<{ state: string; events?: unknown[]; output?: number }>; trace: unknown[] }) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  let watchCall = 0
  let traceCall = 0
  let outputCursor = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded' }
    if (payload.op === 'watch') {
      expect(payload.output).toBe(true)
      const frame = frames.watch[watchCall++] ?? { state: 'settled' }
      const count = frame.output ?? 0
      outputCursor += count
      const events = frame.events ?? []
      if (watchCall === 1) {
        events.push({ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: CANONICAL, providerId: 'codex', cwd: '/w' }) })
      }
      return {
        watch: {
          state: frame.state,
          poll: { cursor: watchCall, events },
          output: { chunks: Array.from({ length: count }, (_, index) => ({ seq: outputCursor - count + index + 1, kind: 'output', text: 'x' })), cursor: outputCursor }
        }
      }
    }
    if (payload.op === 'desktop') return { desktop: frames.trace[traceCall++] ?? { kind: 'trace', run: null } }
    if (payload.op === 'questions') return { questions: [] }
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
    }),
    waitMs: 0
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
    const { runtime, sent, warnings } = fixture({
      watch: [
        { state: 'dispatched', output: 1 },
        { state: 'dispatched', output: 1 },
        { state: 'settled', output: 1 }
      ],
      trace: [
        { kind: 'trace', run: run('chunk 1\n'), cursor: { revision: 'r1', count: 1 } },
        { kind: 'trace_delta', run: { ...run('chunk 1\n'), items: undefined }, base: 'r1', revision: 'r2', count: 1, changes: [{ index: 0, item: textItem('chunk 1\nchunk 2\n') }] },
        // The last read is a snapshot, which is what a quiet long poll returns: the
        // growth it carries must not be dropped for being "already delivered".
        { kind: 'trace', run: run('chunk 1\nchunk 2\nchunk 3\n'), cursor: { revision: 'r3', count: 1 } }
      ]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    // `start` begins the pump; it keeps polling until the run settles.
    for (let index = 0; index < 400 && !runtime.runView(CANONICAL)?.done; index++) await new Promise((resolve) => { setTimeout(resolve, 2) })
    runtime.dispose()
    expect(warnings).toEqual([])
    expect(deliveredText(sent)).toEqual(['chunk 1\n', 'chunk 2\n', 'chunk 3\n'])
  })
})
