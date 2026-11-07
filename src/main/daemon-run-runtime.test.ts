import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { TraceBatch } from './trace-output'
import { TraceOutputBridge } from './trace-output'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'

const RUN = '7b0b4f2c-1c4d-4a3f-9a2e-2f2c1a4b5d6e'
const CONTEXT = { cwd: '/w', providerId: 'claude' }

function event(text: string): TraceEvent {
  return { id: `e-${text}`, ts: '2024-01-01T00:00:00.000Z', runId: RUN, kind: 'model', stage: 'text', text }
}

function run(items: TraceEvent[], done = false): ActiveRun {
  return { runId: RUN, providerId: 'claude', cwd: '/w', userText: 'hi', items, done, providerSettled: false }
}

/**
 * One scripted daemon: the test writes the frames a real host would send, so the
 * runtime is exercised through the same parsing the App uses in production.
 */
function fixture(frames: {
  watch: Array<{ state: string | null; events?: unknown[] }>
  trace: Array<Record<string, unknown>>
  questions?: unknown[][]
}) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const traceRequests: Record<string, unknown>[] = []
  let watchCall = 0
  let traceCall = 0
  let questionCall = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded' }
    if (payload.op === 'watch') {
      const frame = frames.watch[watchCall++] ?? { state: 'settled' }
      return { watch: { state: frame.state, poll: { cursor: watchCall, events: frame.events ?? [] } } }
    }
    if (payload.op === 'desktop') {
      traceRequests.push(payload)
      return { desktop: frames.trace[traceCall++] ?? { kind: 'trace', run: null } }
    }
    if (payload.op === 'questions') return { questions: frames.questions?.[questionCall++] ?? [] }
    if (payload.op === 'stop') return { stop: { status: 'requested' } }
    if (payload.op === 'answerQuestion') return { answer: true }
    if (payload.op === 'liveRuns') return { liveRuns: { revision: 'v1', runs: [] } }
    return { error: 'unknown_op' }
  }
  const bridge = new TraceOutputBridge({
    canSend: () => true,
    send: (payload: TraceBatch) => sent.push({ channel: 'agent:trace', payload }),
    schedule: (fn) => { fn(); return () => {} }
  })
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: (channel, payload) => sent.push({ channel, payload }),
    bridge,
    waitMs: 0
  })
  return { runtime, sent, traceRequests, frames }
}

function deliveredEvents(sent: Array<{ channel: string; payload: unknown }>): TraceEvent[] {
  return sent.filter((entry) => entry.channel === 'agent:trace')
    .flatMap((entry) => (entry.payload as TraceBatch).events)
}

describe('daemon run runtime (the App view is fed by the daemon, not a local pipeline)', () => {
  it('delivers the daemon snapshot and then only the appended tail', async () => {
    const { runtime, sent } = fixture({
      watch: [{ state: 'dispatched', events: [{ runId: RUN, kind: 'run_dispatched' }] }],
      trace: [
        { kind: 'trace', run: run([event('one')]), cursor: { revision: 'r1', count: 1 } },
        { kind: 'trace_delta', run: run([]), base: 'r1', revision: 'r2', count: 2, changes: [{ index: 0, item: event('one') }, { index: 1, item: event('two') }] }
      ]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.step(RUN, { waitMs: 0 })
    await runtime.step(RUN, { waitMs: 0 })
    expect(deliveredEvents(sent).map((item) => item.text)).toEqual(['one', 'two'])
  })

  it('never replays a rewrite as an append', async () => {
    const { runtime, sent } = fixture({
      watch: [{ state: 'dispatched' }, { state: 'dispatched' }],
      trace: [
        { kind: 'trace', run: run([event('one'), event('two')]), cursor: { revision: 'r1', count: 2 } },
        // Index 0 changed: the renderer's copy is stale, so this is not an append.
        { kind: 'trace_delta', run: run([]), base: 'r1', revision: 'r2', count: 2, changes: [{ index: 0, item: event('rewritten') }] }
      ]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.step(RUN, { waitMs: 0 })
    await runtime.step(RUN, { waitMs: 0 })
    expect(deliveredEvents(sent).map((item) => item.text)).toEqual(['one', 'two'])
    // The gap is reported, so the view knows to re-read the authoritative snapshot.
    expect(sent.some((entry) => entry.channel === 'agent:traceHealth')).toBe(true)
    await expect(runtime.snapshot(RUN, CONTEXT)).resolves.toBeNull()
  })

  it('asks a pending question once and closes it after the answer', async () => {
    const question = { runId: RUN, questionId: 'q1', questionKind: 'permission', questions: [] }
    const { runtime, sent } = fixture({
      watch: [{ state: 'dispatched' }, { state: 'dispatched' }, { state: 'dispatched' }],
      trace: [{ kind: 'trace', run: run([]), cursor: { revision: 'r1', count: 0 } }],
      questions: [[question], [question], []]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.step(RUN, { waitMs: 0 })
    await runtime.step(RUN, { waitMs: 0 })
    expect(sent.filter((entry) => entry.channel === 'agent:question')).toHaveLength(1)
    await runtime.answerQuestion({ runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} } as never)
    await runtime.step(RUN, { waitMs: 0 })
    expect(sent.filter((entry) => entry.channel === 'agent:questionClosed')).toEqual([
      { channel: 'agent:questionClosed', payload: { runId: RUN, questionId: 'q1' } }
    ])
  })

  it('answers a start with the canonical run id the trace will carry', async () => {
    const { runtime } = fixture({
      // The daemon binds the ledger run to its own canonical run on dispatch.
      watch: [{ state: 'dispatched', events: [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: 'run-abc-7', providerId: 'claude', cwd: '/w' }) }] }],
      trace: [{ kind: 'trace', run: run([]), cursor: { revision: 'r1', count: 0 } }]
    })
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).resolves.toMatchObject({
      runId: 'run-abc-7', status: 'recorded', bound: true
    })
  })

  it('stops polling a settled run instead of re-reading it forever', async () => {
    const watch: Array<{ state: string | null }> = [{ state: 'dispatched' }, { state: 'settled' }]
    const { runtime } = fixture({
      watch,
      trace: [
        { kind: 'trace', run: run([], true), cursor: { revision: 'r1', count: 0 } },
        { kind: 'trace', run: run([], true), cursor: { revision: 'r2', count: 0 } }
      ]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.pump(RUN)
    // Two windows is all a settled run gets: no third read, and no invented event.
    expect(watch.length).toBe(2)
  })

  it('forwards a stop and keeps an unconfirmed stop visible', async () => {
    const { runtime } = fixture({ watch: [{ state: 'dispatched' }], trace: [] })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await expect(runtime.stop(RUN)).resolves.toBe(true)
  })

  it('surfaces a revoked grant as a stopped pump, not as a finished run', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const onWarn = vi.fn()
    const runtime = new DaemonRunRuntime({
      transport: new DaemonRunTransport(async (payload) => payload.op === 'submit'
        ? { runId: RUN, status: 'recorded' }
        : { error: 'device_not_authorized' }),
      send: (channel, payload) => sent.push({ channel, payload }),
      onWarn,
      waitMs: 0
    })
    // The intent is recorded before the grant is checked, so the submit itself
    // succeeds; what must not happen is claiming the run bound or finished.
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).resolves.toMatchObject({
      runId: RUN, status: 'recorded', bound: false
    })
    await expect(runtime.step(RUN, { waitMs: 0 })).rejects.toMatchObject({ reason: 'daemon_device_not_authorized' })
    await runtime.pump(RUN)
    expect(onWarn).toHaveBeenCalled()
    expect(deliveredEvents(sent)).toEqual([])
  })
})
