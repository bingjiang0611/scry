import { describe, expect, it, vi } from 'vitest'
import type { AgentQuestionRequest } from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { TraceBatch } from './trace-output'
import { TraceOutputBridge } from './trace-output'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { announceRun, runEvent, subscribedRun } from './daemon-run-subscription.fixtures'

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
  trace: Array<Record<string, unknown>>
  answerFails?: boolean[]
}) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const traceRequests: Record<string, unknown>[] = []
  const answerRequests: Record<string, unknown>[] = []
  const stopRequests: Record<string, unknown>[] = []
  let traceCall = 0
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded' }
    if (payload.op === 'desktop') {
      traceRequests.push(payload)
      return { desktop: frames.trace[traceCall++] ?? { kind: 'trace', run: null } }
    }
    if (payload.op === 'stop') { stopRequests.push(payload); return { stop: { status: 'requested' } } }
    // The daemon answers with its ledger receipt; a bare `true` is not a shape it sends.
    if (payload.op === 'answerQuestion') {
      answerRequests.push(payload)
      // A lost reply: the request was written, and the App never learned the outcome.
      if (frames.answerFails?.[answerRequests.length - 1]) throw new Error('lane_lost')
      return { answer: { status: 'answered' } }
    }
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
    bridge
  })
  return { runtime, sent, traceRequests, answerRequests, stopRequests }
}

async function start(runtime: DaemonRunRuntime, canonical = RUN, other?: string) {
  const receipt = runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
  await vi.waitFor(() => expect(runtime.isTracking(RUN)).toBe(true), { interval: 1 })
  if (other) await announceRun(runtime, 'another-run', { scryRunId: other })
  await announceRun(runtime, RUN, { scryRunId: canonical })
  return await receipt
}

const read = (runtime: DaemonRunRuntime) => runtime.deliverAfterRead(RUN, () => undefined)

function projectQuestions(runtime: DaemonRunRuntime, questions: AgentQuestionRequest[]) {
  return runtime.applySubscribeEvent(runEvent(
    questions.length ? 'run.question_opened' : 'run.question_closed', RUN, {},
    subscribedRun(RUN, { admitted: true, questions })
  ))
}

function deliveredEvents(sent: Array<{ channel: string; payload: unknown }>): TraceEvent[] {
  return sent.filter((entry) => entry.channel === 'agent:trace')
    .flatMap((entry) => (entry.payload as TraceBatch).events)
}

describe('daemon run runtime (the App view is fed by the daemon, not a local pipeline)', () => {
  it('delivers the daemon snapshot and then only the appended tail', async () => {
    const { runtime, sent } = fixture({
      trace: [
        { kind: 'trace', run: run([event('one')]), cursor: { revision: 'r1', count: 1 } },
        { kind: 'trace_delta', run: run([]), base: 'r1', revision: 'r2', count: 2, changes: [{ index: 0, item: event('one') }, { index: 1, item: event('two') }] }
      ]
    })
    await start(runtime)
    await read(runtime)
    expect(deliveredEvents(sent).map((item) => item.text)).toEqual(['one', 'two'])
  })

  it('does not deliver the same items again when a poll adopts a run it already follows', async () => {
    const canonical = 'remote-run-mw6osn9o-3'
    const { runtime, sent } = fixture({
      trace: [{ kind: 'trace', run: { ...run([event('hi')]), runId: canonical }, cursor: { revision: 'r1', count: 1 } }]
    })
    await start(runtime, canonical)
    const delivered = deliveredEvents(sent).length
    expect(runtime.isTracking(canonical)).toBe(true)
    await runtime.adopt(canonical)
    expect(deliveredEvents(sent).length).toBe(delivered)
  })

  it('streams a text block that grows in place as its own deltas', async () => {
    // The daemon's run view keeps one text block per message and rewrites it as the
    // Provider streams. Treating that as a rewrite would show the first few characters
    // and then nothing until the run ended.
    const growing = (text: string): TraceEvent => ({ id: 'e-text', ts: '2024-01-01T00:00:00.000Z', runId: RUN, kind: 'model', stage: 'text_delta', messageId: 'm1', text })
    const { runtime, sent } = fixture({
      trace: [
        { kind: 'trace', run: run([growing('chunk 1\n')]), cursor: { revision: 'r1', count: 1 } },
        { kind: 'trace_delta', run: run([]), base: 'r1', revision: 'r2', count: 1, changes: [{ index: 0, item: growing('chunk 1\nchunk 2\n') }] },
        { kind: 'trace_delta', run: run([]), base: 'r2', revision: 'r3', count: 1, changes: [{ index: 0, item: growing('chunk 1\nchunk 2\nchunk 3\n') }] }
      ]
    })
    await start(runtime)
    await read(runtime)
    await read(runtime)
    expect(deliveredEvents(sent).map((item) => item.text)).toEqual(['chunk 1\n', 'chunk 2\n', 'chunk 3\n'])
    expect(sent.some((entry) => entry.channel === 'agent:traceHealth')).toBe(false)
  })

  it('never replays a rewrite as an append', async () => {
    const { runtime, sent } = fixture({
      trace: [
        { kind: 'trace', run: run([event('one'), event('two')]), cursor: { revision: 'r1', count: 2 } },
        { kind: 'trace_delta', run: run([]), base: 'r1', revision: 'r2', count: 2, changes: [{ index: 0, item: event('rewritten') }] }
      ]
    })
    await start(runtime)
    await read(runtime)
    expect(deliveredEvents(sent).map((item) => item.text)).toEqual(['one', 'two'])
    expect(sent.some((entry) => entry.channel === 'agent:traceHealth')).toBe(true)
    await expect(runtime.snapshot(RUN, CONTEXT)).resolves.toBeNull()
  })

  it('asks a pending question once and closes it after the answer', async () => {
    const question: AgentQuestionRequest = { runId: RUN, questionId: 'q1', providerId: 'codex', questionKind: 'permission', questions: [] }
    const { runtime, sent } = fixture({
      trace: [{ kind: 'trace', run: run([]), cursor: { revision: 'r1', count: 0 } }]
    })
    await start(runtime)
    await projectQuestions(runtime, [question])
    await projectQuestions(runtime, [question])
    // The channel names are the ones the preload subscribes to ("userQuestion"), not
    // names invented here: a question nobody listens for is a question nobody answers.
    expect(sent.filter((entry) => entry.channel === 'agent:userQuestion')).toHaveLength(1)
    await runtime.answerQuestion({ runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} } as never)
    await projectQuestions(runtime, [])
    expect(sent.filter((entry) => entry.channel === 'agent:userQuestionClosed')).toEqual([
      { channel: 'agent:userQuestionClosed', payload: { runId: RUN, questionId: 'q1' } }
    ])
  })

  it('answers a start with the canonical run id the trace will carry', async () => {
    const { runtime } = fixture({
      trace: [{ kind: 'trace', run: run([]), cursor: { revision: 'r1', count: 0 } }]
    })
    await expect(start(runtime, 'run-abc-7')).resolves.toMatchObject({
      runId: 'run-abc-7', status: 'recorded', bound: true
    })
  })

  it('binds a run whose canonical id starts with remote-', async () => {
    const { runtime } = fixture({
      trace: [{ kind: 'trace', run: { ...run([]), runId: 'remote-run-mw6osn9o-0' }, cursor: { revision: 'r1', count: 0 } }]
    })
    await expect(start(runtime, 'remote-run-mw6osn9o-0')).resolves.toMatchObject({
      runId: 'remote-run-mw6osn9o-0', bound: true
    })
  })

  it('finds a finished run by the canonical id the window focuses', async () => {
    const canonical = 'remote-run-mw6osn9o-0'
    const { runtime, traceRequests } = fixture({
      trace: [{ kind: 'trace', run: { ...run([event('done')], true), runId: canonical }, cursor: { revision: 'r1', count: 1 } }]
    })
    await expect(start(runtime, canonical)).resolves.toMatchObject({ runId: canonical, bound: true })
    expect(runtime.runView(canonical)).toMatchObject({ runId: canonical, done: true })
    expect(traceRequests[0]).toMatchObject({ query: { runId: canonical } })
    expect(runtime.runView('remote-run-unread-0')).toBeNull()
  })

  it('answers a question asked about the canonical run id on the ledger run', async () => {
    const canonical = 'remote-run-mw6osn9o-0'
    const question: AgentQuestionRequest = { runId: canonical, questionId: 'q1', providerId: 'codex', questions: [] }
    const { runtime, answerRequests } = fixture({
      trace: [{ kind: 'trace', run: { ...run([event('hi')]), runId: canonical }, cursor: { revision: 'r1', count: 1 } }]
    })
    await start(runtime, canonical)
    await projectQuestions(runtime, [question])
    await expect(runtime.answerQuestion({ runId: canonical, questionId: 'q1', behavior: 'answered', answers: {} } as never)).resolves.toBe(true)
    const first = answerRequests[0] as { runId: string; answerId: string; response: Record<string, unknown> }
    expect(first.runId).toBe(RUN)
    expect(first.response).toMatchObject({ runId: RUN, questionId: 'q1' })
    expect(first.answerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

  })

  it('reuses the answer id when the same answer is retried after a lost reply', async () => {
    const { runtime, answerRequests } = fixture({
      trace: [{ kind: 'trace', run: run([]), cursor: { revision: 'r1', count: 0 } }],
      // The question is still pending across both reads: an answer that failed to be
      // delivered did not close it.
      answerFails: [true, false]
    })
    await start(runtime)
    await projectQuestions(runtime, [{ runId: RUN, questionId: 'q1', providerId: 'codex', questions: [] }])
    const answer = { runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} } as never
    await expect(runtime.answerQuestion(answer)).rejects.toMatchObject({ reason: 'daemon_outcome_unknown' })
    await expect(runtime.answerQuestion(answer)).resolves.toBe(true)
    expect((answerRequests[0] as { answerId: string }).answerId).toBe((answerRequests[1] as { answerId: string }).answerId)
  })

  it('ignores a bind event another run in the same context left behind', async () => {
    const mine = 'remote-run-mw6q00aa-1'
    const theirs = 'remote-run-mw6q00aa-0'
    const { runtime } = fixture({
      // The watch is per context, not per run: a second run in the same workspace
      // replays the first run's binding before its own.
      trace: [{ kind: 'trace', run: null, cursor: { revision: 'r1', count: 0 } }]
    })
    const receipt = await start(runtime, mine, theirs)
    expect(receipt.runId).toBe(mine)
  })

  it('stops the ledger run the window knows by its canonical id', async () => {
    const canonical = 'remote-run-mw6osn9o-0'
    const { runtime, stopRequests } = fixture({
      // No trace read yet: the user stops a run that has only just been bound, so the
      // ledger id has to come from the bind, not from a run view.
      trace: [{ kind: 'trace', run: null, cursor: { revision: 'r1', count: 0 } }]
    })
    await start(runtime, canonical)
    await runtime.stop(canonical)
    expect(stopRequests[0]).toMatchObject({ runId: RUN })
  })

  it('adopts a live run this window did not start, using the bind to find its context', async () => {
    const { runtime, sent } = fixture({
      trace: [{ kind: 'trace', run: { ...run([event('adopted')]), runId: 'run-abc-9' }, cursor: { revision: 'r1', count: 1 } }]
    })
    // No context is known up front: only the daemon's bind can address the trace.
    await announceRun(runtime, RUN, { scryRunId: 'run-abc-9', cwd: '/elsewhere' })
    await expect(runtime.adopt(RUN)).resolves.toMatchObject({ runId: 'run-abc-9' })
    expect(deliveredEvents(sent).map((item) => item.text)).toEqual(['adopted'])
    expect(runtime.isTracking(RUN)).toBe(true)
  })

  it('stops reading trace on new output hints after a settled run', async () => {
    const { runtime, traceRequests } = fixture({
      trace: [
        { kind: 'trace', run: run([]), cursor: { revision: 'r1', count: 0 } },
        { kind: 'trace', run: run([], true), cursor: { revision: 'r2', count: 0 } }
      ]
    })
    await start(runtime)
    await runtime.applySubscribeEvent(runEvent('run.settled', RUN))
    const reads = traceRequests.length
    expect(reads).toBe(2)
    await announceRun(runtime, RUN, { outputSeq: 3 })
    expect(traceRequests).toHaveLength(reads)
  })

  it('forwards a stop and keeps an unconfirmed stop visible', async () => {
    const { runtime } = fixture({ trace: [] })
    await start(runtime)
    await expect(runtime.stop(RUN)).resolves.toBe(true)
  })

  it('reports a revoked trace read and keeps the run outcome unknown', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const onWarn = vi.fn()
    const runtime = new DaemonRunRuntime({
      transport: new DaemonRunTransport(async (payload) => payload.op === 'submit'
        ? { runId: RUN, status: 'recorded' }
        : { error: 'device_not_authorized' }),
      send: (channel, payload) => sent.push({ channel, payload }),
      onWarn,
      bindBudgetMs: 10
    })
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).resolves.toMatchObject({
      runId: RUN, status: 'recorded', bound: false
    })
    await runtime.applyRunHint({ kind: 'run', runId: RUN, outputSeq: 1, scryRunId: RUN, admitted: true })
    expect(onWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'daemon_device_not_authorized' }))
    expect(runtime.runView(RUN)).toBeNull()
    expect(deliveredEvents(sent)).toEqual([])
  })
})
