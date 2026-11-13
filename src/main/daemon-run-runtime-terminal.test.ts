import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import { TraceOutputBridge } from './trace-output'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'

// The ledger can report a run settled before this step's trace read has brought in its
// last text. A view read while that trace read is still in flight must not already say
// `done`: the window would end the run without its final text (B4-S exclusion lane).

const RUN = '7b0b4f2c-1c4d-4a3f-9a2e-2f2c1a4b5d6e'
const CONTEXT = { cwd: '/w', providerId: 'claude' }
const event = (text: string): TraceEvent => ({ id: `e-${text}`, ts: '2024-01-01T00:00:00.000Z', runId: RUN, kind: 'model', stage: 'text', text })
const run = (items: TraceEvent[], done = false): ActiveRun => ({ runId: RUN, providerId: 'claude', cwd: '/w', userText: 'hi', items, done, providerSettled: false })

describe('daemon run runtime: terminal state follows the trace of the same step', () => {
  it('does not report done while the step that read `settled` is still fetching the last text', async () => {
    let releaseTrace!: () => void
    const traceHeld = new Promise<void>((resolve) => { releaseTrace = resolve })
    let traceStarted!: () => void
    const traceRequested = new Promise<void>((resolve) => { traceStarted = resolve })
    let watchCall = 0
        let settle = false
    // What the watch of the step now reading the trace said: the race needs `settled` there.
    let watchSaidSettled = false
    const delivered: string[] = []
    const request = async (payload: Record<string, unknown>): Promise<unknown> => {
      if (payload.op === 'submit') return { runId: RUN, status: 'recorded' }
      if (payload.op === 'watch') {
        watchCall += 1
        const bound = watchCall === 1
          ? [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: RUN, providerId: 'claude', cwd: '/w' }) }]
          : []
        watchSaidSettled = settle
        return { watch: { state: settle ? 'settled' : 'dispatched', poll: { cursor: watchCall, events: bound } } }
      }
      if (payload.op === 'desktop') {
        if (!watchSaidSettled) return { desktop: { kind: 'trace', run: run([event('one')]), cursor: { revision: 'r1', count: 1 } } }
        traceStarted()
        await traceHeld
        return { desktop: { kind: 'trace_delta', run: run([], true), base: 'r1', revision: 'r2', count: 2, changes: [{ index: 1, item: event('two') }] } }
      }
      if (payload.op === 'questions') return { questions: [] }
      if (payload.op === 'liveRuns') return { liveRuns: { revision: 'v1', runs: [] } }
      return { error: 'unknown_op' }
    }
    const bridge = new TraceOutputBridge({
      canSend: () => true,
      send: (batch) => { for (const item of batch.events) if (item.text) delivered.push(item.text) },
      schedule: (fn) => { fn(); return () => {} }
    })
    const runtime = new DaemonRunRuntime({ transport: new DaemonRunTransport(request), send: () => undefined, bridge, waitMs: 0 })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.step(RUN, { waitMs: 0 })
    expect(runtime.runView(RUN)?.done).toBe(false)
    expect(delivered).toEqual(['one'])

    settle = true
    const step = runtime.step(RUN, { waitMs: 0 })
    await traceRequested
    // Mid-step: the ledger said settled, the last text is not in yet.
    expect(delivered).toEqual(['one'])
    expect(runtime.runView(RUN)?.done).toBe(false)
    releaseTrace()
    await step
    expect(delivered).toEqual(['one', 'two'])
    expect(runtime.runView(RUN)?.done).toBe(true)
  })
})
