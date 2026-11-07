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
  answerFails?: boolean[]
  stickyQuestions?: boolean
}) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const traceRequests: Record<string, unknown>[] = []
  const answerRequests: Record<string, unknown>[] = []
  const stopRequests: Record<string, unknown>[] = []
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
    if (payload.op === 'questions') {
      // `stickyQuestions`: the same question stays pending however often it is read,
      // which is what a question awaiting its answer looks like over the wire.
      if (frames.stickyQuestions) return { questions: frames.questions?.[0] ?? [] }
      return { questions: frames.questions?.[questionCall++] ?? [] }
    }
    if (payload.op === 'stop') { stopRequests.push(payload); return { stop: { status: 'requested' } } }
    // The daemon answers with its ledger receipt; a bare `true` is not a shape it sends.
    if (payload.op === 'answerQuestion') {
      answerRequests.push(payload)
      // A lost reply: the request was written, and the App never learned the outcome.
      if (frames.answerFails?.[answerRequests.length - 1]) throw new Error('lane_lost')
      return { answer: { status: 'answered' } }
    }
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
  return { runtime, sent, traceRequests, answerRequests, stopRequests, frames }
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
    // The channel names are the ones the preload subscribes to ("userQuestion"), not
    // names invented here: a question nobody listens for is a question nobody answers.
    expect(sent.filter((entry) => entry.channel === 'agent:userQuestion')).toHaveLength(1)
    await runtime.answerQuestion({ runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} } as never)
    await runtime.step(RUN, { waitMs: 0 })
    expect(sent.filter((entry) => entry.channel === 'agent:userQuestionClosed')).toEqual([
      { channel: 'agent:userQuestionClosed', payload: { runId: RUN, questionId: 'q1' } }
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

  it('binds a run whose canonical id starts with remote-', async () => {
    // A run the daemon starts for a device - or for the App itself - carries a
    // `remote-run-...` id, which is the same shape the device client accepts.
    const { runtime } = fixture({
      watch: [{ state: 'dispatched', events: [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: 'remote-run-mw6osn9o-0', providerId: 'codex', cwd: '/w' }) }] }],
      trace: [{ kind: 'trace', run: { ...run([]), runId: 'remote-run-mw6osn9o-0' }, cursor: { revision: 'r1', count: 0 } }]
    })
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).resolves.toMatchObject({
      runId: 'remote-run-mw6osn9o-0', bound: true
    })
  })

  it('finds a finished run by the canonical id the window focuses', async () => {
    const canonical = 'remote-run-mw6osn9o-0'
    const { runtime, traceRequests } = fixture({
      watch: [{ state: 'dispatched', events: [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: canonical, providerId: 'codex', cwd: '/w' }) }] }],
      trace: [{ kind: 'trace', run: { ...run([event('done')], true), runId: canonical }, cursor: { revision: 'r1', count: 1 } }]
    })
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).resolves.toMatchObject({ runId: canonical, bound: true })
    // The window holds the canonical id; the map is keyed by the ledger id.
    expect(runtime.runView(canonical)).toMatchObject({ runId: canonical, done: true })
    // The trace read is addressed by that canonical id, not by the ledger id.
    expect(traceRequests[0]).toMatchObject({ query: { runId: canonical } })
    // And a run this window has not read yet is absent, not an empty run.
    expect(runtime.runView('remote-run-unread-0')).toBeNull()
  })

  it('answers a question asked about the canonical run id on the ledger run', async () => {
    const canonical = 'remote-run-mw6osn9o-0'
    const question = { runId: canonical, questionId: 'q1', providerId: 'codex', questions: [] }
    const { runtime, answerRequests } = fixture({
      watch: [{ state: 'dispatched', events: [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: canonical, providerId: 'codex', cwd: '/w' }) }] }],
      trace: [{ kind: 'trace', run: { ...run([event('hi')]), runId: canonical }, cursor: { revision: 'r1', count: 1 } }],
      questions: [[question]]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.step(RUN, { waitMs: 0 })
    // The renderer answers with the id it was shown, which is the canonical one; the
    // daemon names pending questions by its ledger run, so the id is translated here.
    await expect(runtime.answerQuestion({ runId: canonical, questionId: 'q1', behavior: 'answered', answers: {} } as never)).resolves.toBe(true)
    // The whole payload speaks the daemon's id: the answer travels inside it. The
    // daemon's `answerId` is its own idempotency key (a UUID), not the question id.
    const first = answerRequests[0] as { runId: string; answerId: string; response: Record<string, unknown> }
    expect(first.runId).toBe(RUN)
    expect(first.response).toMatchObject({ runId: RUN, questionId: 'q1' })
    expect(first.answerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

  })

  it('reuses the answer id when the same answer is retried after a lost reply', async () => {
    const { runtime, answerRequests } = fixture({
      watch: [{ state: 'dispatched' }],
      trace: [{ kind: 'trace', run: run([]), cursor: { revision: 'r1', count: 0 } }],
      // The question is still pending across both reads: an answer that failed to be
      // delivered did not close it.
      questions: [[{ runId: RUN, questionId: 'q1', providerId: 'codex', questions: [] }]],
      stickyQuestions: true,
      answerFails: [true, false]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.step(RUN, { waitMs: 0 })
    const answer = { runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} } as never
    // A lost reply is reported as unknown, never retried behind the user's back.
    await expect(runtime.answerQuestion(answer)).rejects.toMatchObject({ reason: 'daemon_outcome_unknown' })
    await expect(runtime.answerQuestion(answer)).resolves.toBe(true)
    // One key per question: a retry must not look like a second answer to the daemon.
    expect((answerRequests[0] as { answerId: string }).answerId).toBe((answerRequests[1] as { answerId: string }).answerId)
  })

  it('ignores a bind event another run in the same context left behind', async () => {
    const mine = 'remote-run-mw6q00aa-1'
    const theirs = 'remote-run-mw6q00aa-0'
    const { runtime } = fixture({
      // The watch is per context, not per run: a second run in the same workspace
      // replays the first run's binding before its own.
      watch: [{
        state: 'dispatched',
        events: [
          { runId: 'ledger-a', kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: 'ledger-a', scryRunId: theirs, providerId: 'codex', cwd: '/w' }) },
          { runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: mine, providerId: 'codex', cwd: '/w' }) }
        ]
      }],
      trace: [{ kind: 'trace', run: null, cursor: { revision: 'r1', count: 0 } }]
    })
    const receipt = await runtime.start({ intentId: 'i-2', detail: '{}', context: CONTEXT })
    // Handing back the other run's id would make the window show, answer and stop a run
    // the user did not start.
    expect(receipt.runId).toBe(mine)
  })

  it('stops the ledger run the window knows by its canonical id', async () => {
    const canonical = 'remote-run-mw6osn9o-0'
    const { runtime, stopRequests } = fixture({
      // No trace read yet: the user stops a run that has only just been bound, so the
      // ledger id has to come from the bind, not from a run view.
      watch: [{ state: 'dispatched', events: [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: canonical, providerId: 'codex', cwd: '/w' }) }] }],
      trace: [{ kind: 'trace', run: null, cursor: { revision: 'r1', count: 0 } }]
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await runtime.stop(canonical)
    // The daemon stops runs by the id its own ledger recorded, not the trace's.
    expect(stopRequests[0]).toMatchObject({ runId: RUN })
  })

  it('adopts a live run this window did not start, using the bind to find its context', async () => {
    const { runtime, sent } = fixture({
      watch: [{
        state: 'dispatched',
        events: [{ runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: 'run-abc-9', providerId: 'codex', cwd: '/elsewhere' }) }]
      }],
      trace: [{ kind: 'trace', run: { ...run([event('adopted')]), runId: 'run-abc-9' }, cursor: { revision: 'r1', count: 1 } }]
    })
    // No context is known up front: only the daemon's bind can address the trace.
    await expect(runtime.adopt(RUN)).resolves.toMatchObject({ runId: 'run-abc-9' })
    expect(deliveredEvents(sent).map((item) => item.text)).toEqual(['adopted'])
    expect(runtime.isTracking(RUN)).toBe(true)
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
