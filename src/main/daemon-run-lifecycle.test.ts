import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { announceRun, runEvent } from './daemon-run-subscription.fixtures'
import { TraceOutputBridge } from './trace-output'

// A daemon run stops on the ledger, not in the trace.
//
// The trace reports `done` only in a snapshot, and after the first snapshot every read
// is a delta - so a run the user stopped kept looking alive, and the window's stop
// control (which waits for `done`) never finished. The ledger's terminal state is the
// authority on whether a daemon run finished.

const RUN = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CANONICAL = 'remote-run-mw6osn9o-0'

const event: TraceEvent = { id: 'e-1', ts: '2024-01-01T00:00:00.000Z', runId: CANONICAL, kind: 'model', stage: 'text', text: 'stopping' }
const liveRun: ActiveRun = { runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [event], done: false, providerSettled: false }

function runtimeFor(traceFrames: unknown[]) {
  let traceCall = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded' }
    if (payload.op === 'desktop') return { desktop: traceFrames[traceCall++] ?? traceFrames[traceFrames.length - 1] }
    return { error: 'unknown_op' }
  }
  return new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: () => {},
    bridge: new TraceOutputBridge({ canSend: () => true, send: () => {}, schedule: (fn) => { fn(); return () => {} } })
  })
}

describe('daemon run lifecycle (stopping a run reaches done)', () => {
  it('reports done from the ledger when the trace only answers with deltas', async () => {
    const runtime = runtimeFor([
      { kind: 'trace', run: liveRun, cursor: { revision: 'r1', count: 1 } },
      { kind: 'trace_delta', run: liveRun, base: 'r1', revision: 'r2', count: 1, changes: [] }
    ])
    await announceRun(runtime, RUN, { scryRunId: CANONICAL })
    await runtime.applySubscribeEvent(runEvent('run.cancelled', RUN))
    expect(runtime.runView(CANONICAL)).toMatchObject({ runId: CANONICAL, done: true })
    // A finished run is not offered as live work any more.
    expect(runtime.activeRuns()).toEqual([])
    runtime.dispose()
  })

  it('leaves a run whose ledger state is not terminal alone', async () => {
    const runtime = runtimeFor([
      { kind: 'trace', run: liveRun, cursor: { revision: 'r1', count: 1 } }
    ])
    await announceRun(runtime, RUN, { scryRunId: CANONICAL })
    expect(runtime.runView(CANONICAL)).toMatchObject({ done: false })
    runtime.dispose()
  })
})
