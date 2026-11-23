import { describe, expect, it, vi } from 'vitest'
import { DaemonRunError, DaemonRunTransport } from './daemon-run-transport'
import { laneNotSent, laneOutcomeUnknown } from './remote/desktop-lane'

const RUN = '7b0b4f2c-1c4d-4a3f-9a2e-2f2c1a4b5d6e'

function transport(reply: (request: Record<string, unknown>) => unknown) {
  const calls: Array<{ request: Record<string, unknown>; options?: { replayable?: boolean } }> = []
  const value = new DaemonRunTransport(async (request, options) => {
    calls.push({ request, ...(options ? { options } : {}) })
    return reply(request)
  })
  return { value, calls }
}

// The App speaks to its own daemon over the phone's frames. Each assertion here is
// about the frame and the parsed answer, not about a socket: the transport holds no
// credential and no run state, so a bad answer must be named, never rounded up.
describe('daemon run transport', () => {
  it('uses the daemon-provided context to read a live snapshot without pinning an unbound session', async () => {
    const traceContext = { providerId: 'pi', agentProfileId: 'pi:rotom', cwd: '/worktree' }
    const run = { runId: RUN, externalSessionId: 'bound-since-lookup', items: [] }
    const { value, calls } = transport(frame => frame.op === 'runControl'
      ? { traceContext }
      : { desktop: { kind: 'trace', run } })
    await expect(value.adopt(RUN)).resolves.toEqual(run)
    expect(calls).toEqual([
      { request: { op: 'runControl', method: 'adopt', runId: RUN, payload: 'traceContext' }, options: { replayable: true } },
      { request: { op: 'desktop', query: { kind: 'trace', context: traceContext, runId: RUN, images: true, byteChunks: true, settledTail: true } }, options: { replayable: true } }
    ])
  })

  it('accepts an older daemon’s inline snapshot and does not read a trace for an absent run', async () => {
    const run = { runId: RUN, items: [] }
    const older = transport(() => ({ run }))
    await expect(older.value.adopt(RUN)).resolves.toEqual(run)
    expect(older.calls).toHaveLength(1)
    const absent = transport(() => ({ run: null }))
    await expect(absent.value.adopt(RUN)).resolves.toBeNull()
    expect(absent.calls).toHaveLength(1)
  })

  it('records an intent and keeps the receipt idempotent', async () => {
    const { value, calls } = transport(() => ({ runId: RUN, status: 'duplicate' }))
    await expect(value.submit({ intentId: 'intent-1', detail: '{"cwd":"/w"}' })).resolves.toEqual({
      intentId: 'intent-1', runId: RUN, status: 'duplicate'
    })
    expect(calls[0]!.request).toEqual({ op: 'submit', intentId: 'intent-1', detail: '{"cwd":"/w"}' })
    // A submit is replayable: a lost acknowledgement must not create a second run.
    expect(calls[0]!.options).toEqual({ replayable: true })
  })

  it('refuses a submit receipt without a host run id', async () => {
    const { value } = transport(() => ({ status: 'recorded' }))
    await expect(value.submit({ intentId: 'intent-1', detail: '{}' })).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
  })

  it('names a revoked or unenrolled grant instead of reporting an empty run', async () => {
    const { value } = transport(() => ({ error: 'device_not_authorized' }))
    await expect(value.intentState('intent-1')).rejects.toMatchObject({ reason: 'daemon_device_not_authorized' })
  })

  it('reports an unanswered intent as unknown rather than as a run', async () => {
    const { value } = transport(() => ({ intent: null }))
    await expect(value.intentState('intent-1')).rejects.toMatchObject({ reason: 'daemon_run_unknown' })
  })

  it('reads a canonical run snapshot with a delta cursor', async () => {
    const run = { runId: RUN, items: [], done: false }
    const { value, calls } = transport(() => ({ desktop: { kind: 'trace', run, cursor: { revision: 'r1', count: 3 } } }))
    await expect(value.run(RUN, { workspaceKey: 'w' })).resolves.toEqual(run)
    expect(calls[0]!.request).toMatchObject({ op: 'desktop', query: { kind: 'trace', runId: RUN } })
  })

  it('keeps a stop unconfirmed instead of claiming the run stopped', async () => {
    const { value } = transport(() => ({ stop: { status: 'unknown' } }))
    await expect(value.stop(RUN)).rejects.toMatchObject({ reason: 'daemon_stop_not_confirmed' })
  })

  it('reads the daemon receipt an accepted answer really returns', async () => {
    // The daemon answers with its ledger receipt ({status}), not a bare `true`.
    const accepted = transport(() => ({ answer: { status: 'answered' } }))
    await expect(accepted.value.answerQuestion({
      runId: RUN, answerId: 'q1',
      response: { runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} }
    })).resolves.toBe(true)
    // A receipt the App cannot read is still not a delivery.
    const unreadable = transport(() => ({ answer: { status: 'unknown' } })).value
    await expect(unreadable.answerQuestion({
      runId: RUN, answerId: 'q1',
      response: { runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} }
    })).rejects.toMatchObject({ reason: 'daemon_answer_not_delivered' })
  })

  it('keeps an undelivered answer visible', async () => {
    const { value } = transport(() => ({ answer: false }))
    await expect(value.answerQuestion({
      runId: RUN, answerId: 'q1',
      response: { runId: RUN, questionId: 'q1', behavior: 'answered', answers: {} }
    })).rejects.toMatchObject({ reason: 'daemon_answer_not_delivered' })
  })

  it('turns a provably unsent transport throw into a named failure', async () => {
    // Previously any throw was "not running", which let the caller replay a write whose
    // reply was merely lost. The phase is now part of the error, and only the provable
    // "nothing was written" case stays retryable.
    const value = new DaemonRunTransport(vi.fn(async () => { throw laneNotSent(new Error('desktop_not_connected')) }))
    await expect(value.runState(RUN)).rejects.toMatchObject({ reason: 'daemon_not_running' })
  })

  it('sends a run control as one frame and keeps the daemon answer', async () => {
    const { value, calls } = transport(() => ({ steer: { status: 'accepted', messageId: 'm-1' } }))
    await expect(value.runControl({ method: 'steer', payload: { runId: RUN, messageId: 'm-1', prompt: 'go' } }))
      .resolves.toEqual({ steer: { status: 'accepted', messageId: 'm-1' } })
    expect(calls[0]!.request).toEqual({ op: 'runControl', method: 'steer', payload: { runId: RUN, messageId: 'm-1', prompt: 'go' } })
  })

  it('names a daemon that does not serve run controls at all', async () => {
    // An older daemon answers unsupported_op. That is an absence, not an empty success:
    // the App must not show "sent" for a steer that never reached a run.
    const { value } = transport(() => ({ error: 'unsupported_op' }))
    await expect(value.adopt(RUN)).rejects.toMatchObject({ reason: 'daemon_run_control_unavailable' })
  })

  it('keeps a revoked grant a revoked grant, not an unavailable control', async () => {
    const { value } = transport(() => ({ error: 'device_not_authorized' }))
    await expect(value.adopt(RUN)).rejects.toMatchObject({ reason: 'daemon_device_not_authorized' })
  })

  // A write whose bytes may have reached the daemon must never look like "nothing was
  // sent": that is what made the App replay a start and create a second run.
  it('keeps a provably unsent request retryable', async () => {
    const value = new DaemonRunTransport(vi.fn(async () => { throw laneNotSent(new Error('desktop_lane_not_sent')) }))
    await expect(value.stop(RUN)).rejects.toMatchObject({ reason: 'daemon_not_running' })
  })

  it('reports a written request with a lost reply as an unknown outcome', async () => {
    const value = new DaemonRunTransport(vi.fn(async () => { throw laneOutcomeUnknown(new Error('desktop_lane_closed')) }))
    await expect(value.stop(RUN)).rejects.toMatchObject({ reason: 'daemon_outcome_unknown' })
  })

  it('fails closed on a transport error it cannot classify', async () => {
    // Guessing "not sent" here would replay a write. An unclassified failure is an
    // unknown outcome, which the caller must reconcile, never resend.
    const value = new DaemonRunTransport(vi.fn(async () => { throw new Error('socket hang up') }))
    await expect(value.stop(RUN)).rejects.toMatchObject({ reason: 'daemon_outcome_unknown' })
  })

  it('sends an App channel as a local op and returns the handler result', async () => {
    const { value, calls } = transport(() => ({ result: ['/w'] }))
    await expect(value.localOp({ op: 'projectStore', method: 'recentFolders', args: [], read: true })).resolves.toEqual(['/w'])
    expect(calls[0]!.request).toEqual({ op: 'projectStore', method: 'recentFolders', args: [] })
    expect(calls[0]!.options).toEqual({ replayable: true })
  })

  it('keeps the daemon handler message and names an older daemon without the op', async () => {
    await expect(transport(() => ({ error: '工作区未授权' })).value.localOp({ op: 'sessionStore', method: 'listSessions', args: [], read: true }))
      .rejects.toThrow('工作区未授权')
    await expect(transport(() => ({ error: 'unsupported_op' })).value.localOp({ op: 'sessionStore', method: 'listSessions', args: [], read: true }))
      .rejects.toThrow('daemon_capability_unavailable:sessionStore:listSessions')
    await expect(transport(() => ({ error: 'device_not_authorized' })).value.localOp({ op: 'sessionStore', method: 'listSessions', args: [], read: true }))
      .rejects.toThrow(DaemonRunError)
    // An answer without a result is not an empty success.
    await expect(transport(() => ({})).value.localOp({ op: 'sessionStore', method: 'listSessions', args: [], read: true }))
      .rejects.toThrow('invalid_daemon_response')
  })

  it('forwards an existing op for an App channel and maps its errors the same way', async () => {
    const { value, calls } = transport(() => ({ commands: [] }))
    await expect(value.forward({ op: 'commands', cwd: '/w' }, true)).resolves.toEqual({ commands: [] })
    expect(calls.at(-1)).toMatchObject({ request: { op: 'commands', cwd: '/w' } })
    await expect(transport(() => ({ error: 'unsupported_op' })).value.forward({ op: 'sessionDelete' }, false))
      .rejects.toThrow('daemon_capability_unavailable:sessionDelete')
    await expect(transport(() => ({ error: '会话正在运行' })).value.forward({ op: 'sessionDelete' }, false)).rejects.toThrow('会话正在运行')
    await expect(transport(() => ({ error: 'device_not_authorized' })).value.forward({ op: 'commands' }, true)).rejects.toThrow(DaemonRunError)
  })

  it('validates and filters notices on the subscription lane', async () => {
    const hints = [
      { kind: 'data', event: { kind: 'conversation_changed', conversationId: 'c1' } },
      { kind: 'data', event: { runId: RUN, kind: 'turn_recorded' } },
      { kind: 'run', runId: RUN, outputSeq: 12 }
    ]
    const { value, calls } = transport(() => ({ subscribe: { hostId: 'h1', logId: 'l1', seq: 3, mode: 'idle', hints: [
      ...hints,
      { kind: 'attention', snapshot: {} },
      { kind: 'run', runId: 7 },
      { kind: 'data', event: { kind: 'conversation_changed', conversationId: 7 } }
    ] } }))
    const query = { views: ['activeRuns'] as const, known: { hostId: 'h1', logId: 'l1', seq: 1 }, waitMs: 20_000 }
    const input = { ...query, views: [...query.views] }
    await expect(value.subscribe(input)).resolves.toEqual({ hostId: 'h1', logId: 'l1', seq: 3, mode: 'idle', hints })
    expect(calls[0]).toEqual({ request: { op: 'subscribe', ...input }, options: { replayable: true, signal: undefined } })
    const reset = transport(() => ({ subscribe: { hostId: 'h1', logId: 'l2', seq: 0, mode: 'snapshot', snapshot: {} } }))
    await expect(reset.value.subscribe({ views: ['activeRuns'], waitMs: 0 })).resolves.toMatchObject({ mode: 'snapshot', logId: 'l2' })
    expect(reset.calls[0]!.request).toEqual({ op: 'subscribe', views: ['activeRuns'], waitMs: 0 })
    const broken = transport(() => ({ subscribe: { seq: 'x' } }))
    await expect(broken.value.subscribe({ views: ['activeRuns'], waitMs: 0 })).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
  })

  it('names the arguments the renderer left out, which JSON would turn into null', async () => {
    // The preload always passes its optional parameters; an omitted one is undefined,
    // which a JSON array carries as null. The daemon must see what main would have seen.
    const { value, calls } = transport(() => ({ result: { ok: true } }))
    await value.localOp({ op: 'conversation', method: 'read', args: ['conv-1', undefined], read: true })
    // In memory the array still holds undefined; the lane's JSON makes it null.
    expect(calls[0]!.request).toStrictEqual({ op: 'conversation', method: 'read', args: ['conv-1', undefined], absent: [1] })
    await value.localOp({ op: 'conversation', method: 'read', args: ['conv-1', 5], read: true })
    expect(calls[1]!.request).toStrictEqual({ op: 'conversation', method: 'read', args: ['conv-1', 5] })
    // A real null is the renderer's own value and travels as one.
    await value.localOp({ op: 'conversation', method: 'read', args: ['conv-1', null], read: true })
    expect(calls[2]!.request).toStrictEqual({ op: 'conversation', method: 'read', args: ['conv-1', null] })
  })

  it('reads the daemon unread set and reports a viewed session (E1b)', async () => {
    const snapshot = { revision: 4, unreadSessionKeys: ['codex\u0000\u0000/w\u0000s1'] }
    const { value, calls } = transport((request) => request.op === 'attentionViewed'
      ? { viewed: true }
      : { subscribe: { hostId: 'h1', logId: 'l1', seq: 1, mode: 'idle', hints: [{ kind: 'attention', snapshot }, { kind: 'attention', snapshot: { revision: 'x' } }] } })
    await expect(value.subscribe({ views: ['activeRuns'], waitMs: 0 })).resolves.toMatchObject({ hints: [{ kind: 'attention', snapshot }] })
    await value.attentionViewed('codex\u0000\u0000/w\u0000s1')
    // Viewing is idempotent, so a lost reply may be asked again.
    expect(calls[1]).toEqual({ request: { op: 'attentionViewed', sessionKey: 'codex\u0000\u0000/w\u0000s1' }, options: { replayable: true } })
    const refused = transport(() => ({ error: 'invalid_request' }))
    await expect(refused.value.attentionViewed('k')).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
  })

  it('passes on only the window notices a daemon is meant to forward (W1)', async () => {
    const { value } = transport(() => ({ subscribe: { hostId: 'h1', logId: 'l1', seq: 3, mode: 'idle', hints: [
      { kind: 'window', channel: 'agent:error', payload: { runId: 'r1', message: 'boom' } },
      { kind: 'window', channel: 'agent:turnDone', payload: { runId: 'r1', stopped: false } },
      // A channel outside the list, or a payload that is not an object, is not passed on.
      { kind: 'window', channel: 'workspace:openKnownExternal', payload: { path: '/etc' } },
      { kind: 'window', channel: 'agent:error', payload: 'boom' }
    ] } }))
    await expect(value.subscribe({ views: ['activeRuns'], waitMs: 0 })).resolves.toMatchObject({
      hints: [{ kind: 'window', channel: 'agent:error', payload: { runId: 'r1', message: 'boom' } }]
    })
  })
})
