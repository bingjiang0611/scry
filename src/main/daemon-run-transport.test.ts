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

  it('returns the lifecycle state and cursor from one watch window', async () => {
    const { value, calls } = transport(() => ({
      watch: { state: 'dispatched', poll: { cursor: 12, events: [{ runId: RUN, kind: 'run_dispatched' }, { runId: RUN, kind: 'run_progress', detail: '{"event":"bound"}' }] } }
    }))
    await expect(value.watch({ runId: RUN, cursor: 10, outputCursor: 0, waitMs: 15_000, output: false })).resolves.toEqual({
      state: 'dispatched', cursor: 12, events: [{ runId: RUN, kind: 'run_dispatched' }, { runId: RUN, kind: 'run_progress', detail: '{"event":"bound"}' }],
      // A daemon that answers without an output page has produced nothing yet.
      output: { count: 0, cursor: 0 }
    })
    expect(calls[0]!.request).toEqual({ op: 'watch', runId: RUN, cursor: 10, outputCursor: 0, waitMs: 15_000, output: false })
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

  it('declares its live-run read replayable so a dead daemon can be retried', async () => {
    const { value, calls } = transport(() => ({ liveRuns: { revision: 'r1', runs: [] } }))
    await value.liveRuns({ waitMs: 0 })
    // A read changes nothing; only a write may never be replayed.
    expect(calls[0]!.options).toEqual({ replayable: true })
  })

  it('never reports an empty paged read as complete content', async () => {
    const { value } = transport(() => ({ output: { chunks: [], cursor: 4 } }))
    await expect(value.output({ runId: RUN, cursor: 0 })).resolves.toEqual({ chunks: [], cursor: 4 })
    const broken = transport(() => ({ output: { cursor: 4 } })).value
    await expect(broken.output({ runId: RUN, cursor: 0 })).rejects.toBeInstanceOf(DaemonRunError)
  })

  it('passes the live set through with its revision', async () => {
    const { value } = transport(() => ({ liveRuns: { revision: 'v7', runs: [{ runId: RUN, state: 'running', scryRunId: 'run-abc-1' }] } }))
    await expect(value.liveRuns({ waitMs: 15_000 })).resolves.toEqual({ revision: 'v7', runs: [{ runId: RUN, state: 'running', scryRunId: 'run-abc-1' }] })
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
    await expect(value.runControl({ method: 'adopt', runId: RUN })).rejects.toMatchObject({ reason: 'daemon_run_control_unavailable' })
  })

  it('keeps a revoked grant a revoked grant, not an unavailable control', async () => {
    const { value } = transport(() => ({ error: 'device_not_authorized' }))
    await expect(value.runControl({ method: 'adopt', runId: RUN })).rejects.toMatchObject({ reason: 'daemon_device_not_authorized' })
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

  it('reads the App event feed, keeping only notices it can name', async () => {
    const { value, calls } = transport(() => ({ events: { epoch: 'e1', cursor: 3, items: [
      { kind: 'data', event: { kind: 'conversation_changed', conversationId: 'c1' } },
      { kind: 'data', event: { runId: RUN, kind: 'turn_recorded' } },
      // A newer daemon's notice this App does not know yet is skipped, not guessed at.
      { kind: 'run', runId: RUN },
      { kind: 'data', event: { kind: 'conversation_changed', conversationId: 7 } }
    ] } }))
    await expect(value.appEvents({ epoch: 'e1', cursor: 1, waitMs: 20_000 })).resolves.toEqual({
      epoch: 'e1', cursor: 3, reset: false, items: [
        { kind: 'data', event: { kind: 'conversation_changed', conversationId: 'c1' } },
        { kind: 'data', event: { runId: RUN, kind: 'turn_recorded' } }
      ]
    })
    expect(calls[0]).toEqual({ request: { op: 'appEvents', epoch: 'e1', cursor: 1, waitMs: 20_000 }, options: { replayable: true } })
    const reset = transport(() => ({ events: { epoch: 'e2', cursor: 0, items: [], reset: true } }))
    await expect(reset.value.appEvents({ cursor: 0, waitMs: 0 })).resolves.toMatchObject({ reset: true })
    expect(reset.calls[0]!.request).toEqual({ op: 'appEvents', cursor: 0, waitMs: 0 })
    const broken = transport(() => ({ events: { cursor: 'x' } }))
    await expect(broken.value.appEvents({ cursor: 0, waitMs: 0 })).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
  })
})
