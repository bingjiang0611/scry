import type { AgentQuestionResponse } from '../shared/runtime'
import type { ActiveRun } from '../shared/trace'
import type { DesktopRemoteContext, DesktopTraceCursor, DesktopRemoteTraceRead } from '../shared/desktop-remote'
import type { SubscribeActiveRunRow, SubscribeReply, SubscribeRequest } from '../shared/orchestration-subscribe'
import { isExecutionTargetCallIds, type ExecutionTargetWorkCall, type ExecutionTargetWorkReply, type ExecutionTargetWorkRequest } from '../shared/execution-target-work'
import { RUN_ADMISSION_BUSY_MESSAGE } from './context-admission'
import { DaemonRunRefusedError } from './daemon-run-admission'
import { DaemonClientError } from './daemon-client'
import { DaemonRunError, fail, record, type DaemonRunFailure } from './daemon-run-error'
import { readDaemonTrace } from './daemon-run-trace-read'
import { laneWasNotSent, laneWasWrittenUnknown } from './remote/desktop-lane'
import { assembleByteChunks } from './remote/desktop-byte-chunks'
import { parseSubscribeReply, readDaemonArchivedRunTrace } from './daemon-subscribe-parse'

// The App's run surface against its own daemon, over the same frames the phone
// uses. This module only parses and types those frames: it holds no socket, no
// credential and no run state, so a caller can drive it from a test without a
// daemon and the bootstrap can decide where the frames come from.
//
// Failure is explicit: a host error code becomes a named rejection, and a reply
// that does not carry the expected fields is `invalid_daemon_response` rather
// than an empty success.

export { DaemonRunError, type DaemonRunFailure } from './daemon-run-error'

export type DaemonRequest = (
  request: Record<string, unknown>,
  options?: { replayable?: boolean; signal?: AbortSignal }
) => Promise<unknown>

export interface DaemonSubmitResult {
  intentId: string
  runId: string
  status: 'recorded' | 'duplicate'
  /** The intent's ledger position, when this daemon reports one. */
  seq?: number
}

export interface DaemonIntentState {
  runId: string
  state: string
}

function transportFailure(error: unknown): DaemonRunFailure {
  if (error instanceof DaemonClientError) {
    // Raised before any frame is written (no grant) or by the daemon's own answer.
    if (error.reason === 'daemon_device_not_authorized') return 'daemon_device_not_authorized'
    return 'daemon_not_running'
  }
  if (laneWasNotSent(error)) return 'daemon_not_running'
  if (laneWasWrittenUnknown(error)) return 'daemon_outcome_unknown'
  // Unclassified: the write may have landed. Fail closed.
  return 'daemon_outcome_unknown'
}

// Deliberately narrow: the daemon only ever names runs it created itself.
export function isDaemonRunId(value: unknown): value is string {
  return typeof value === 'string' && (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
    /^run-[0-9a-z]{1,16}-[0-9]{1,12}$/.test(value)
  )
}

function failure(reply: Record<string, unknown>, op?: string): Error | undefined {
  const code = reply.error
  if (code === undefined) return undefined
  if (op === 'submit' && code === 'session_run_active') return new DaemonRunRefusedError(RUN_ADMISSION_BUSY_MESSAGE)
  if (code === 'device_not_authorized' || code === 'execution_target_bridge_unauthorized') return new DaemonRunError('daemon_device_not_authorized')
  // An older daemon has no run controls at all: a named absence, not an empty success.
  // Only the W10 execution-target bridge maps unknown_op to an unavailable control.
  if (code === 'unsupported_op' || (code === 'unknown_op' && (op === 'executionTargetWork' || op === 'executionTargetResult'))) {
    return new DaemonRunError('daemon_run_control_unavailable')
  }
  return new DaemonRunError('invalid_daemon_response')
}

export class DaemonRunTransport {
  readonly #request: DaemonRequest

  constructor(request: DaemonRequest) {
    this.#request = request
  }

  async submit(input: { intentId: string; detail: string }): Promise<DaemonSubmitResult> {
    const reply = await this.#call({ op: 'submit', intentId: input.intentId, detail: input.detail }, { replayable: true })
    const runId = reply.runId
    if (!isDaemonRunId(runId) || (reply.status !== 'recorded' && reply.status !== 'duplicate')) {
      throw new DaemonRunError('invalid_daemon_response')
    }
    // When no position is reported, the caller uses its last observed cursor.
    const seq = Number.isSafeInteger(reply.seq) && (reply.seq as number) > 0 ? reply.seq as number : undefined
    return { intentId: input.intentId, runId, status: reply.status, ...(seq !== undefined ? { seq } : {}) }
  }

  // A recorded intent is not a dispatched run. Recovery asks this after a
  // reconnect instead of re-submitting the same prompt.
  async intentState(intentId: string): Promise<DaemonIntentState> {
    const reply = await this.#call({ op: 'intentStatusAtLog', intentId })
    const intent = reply.intent
    if (!record(intent) || !isDaemonRunId(intent.runId) || typeof intent.state !== 'string') {
      throw new DaemonRunError('daemon_run_unknown')
    }
    return { runId: intent.runId, state: intent.state }
  }

  /**
   * One canonical trace read for a live run; the delta cursor is the caller's.
   */
  async trace(input: { context: unknown; runId: string; after?: DesktopTraceCursor }): Promise<DesktopRemoteTraceRead> {
    return await readDaemonTrace((request, options) => this.#call(request, options), input)
  }

  /** P4-3 archive read for a settled run that already left the live registry. */
  async archivedRunTrace(input: { context: DesktopRemoteContext; runId: string }): Promise<ActiveRun | null> {
    return await readDaemonArchivedRunTrace((request, options) => this.#call(request, options), input)
  }

  /** P4-3 local orchestration subscribe on the events lane (active only when daemon reports subscribe=1). */
  async subscribe(input: SubscribeRequest, signal?: AbortSignal): Promise<SubscribeReply> {
    const request = async (chunk?: SubscribeRequest['chunk']) => {
      const reply = await this.#call({ op: 'subscribe', ...input, ...(chunk ? { chunk } : {}) }, { replayable: true, signal })
      return record(reply.subscribe) ? reply.subscribe : fail()
    }
    let subscribe = await request()
    if (subscribe.kind === 'history_chunk') subscribe = await assembleByteChunks(subscribe, request, fail)
    return parseSubscribeReply({ subscribe })
  }

  /**
   * App-only run controls, answered by the daemon's own registry. Kept as raw frames:
   * the reply is the renderer's existing result shape, and inventing one here would
   * be a second answer to the same question.
   */
  async runControl(request: { method: 'steer' | 'stopBackgroundTask'; payload: unknown } | { method: 'adopt'; runId: string }): Promise<Record<string, unknown>> {
    // #call turns `unsupported_op` into a named absence; every other error code stays
    // the one the daemon sent.
    return await this.#call({
      op: 'runControl',
      method: request.method,
      ...(request.method === 'adopt' ? { runId: request.runId } : { payload: request.payload })
    })
  }

  async stop(runId: string): Promise<'requested' | 'already_requested'> {
    const reply = await this.#call({ op: 'stop', runId })
    const stop = reply.stop
    if (!record(stop) || (stop.status !== 'requested' && stop.status !== 'already_requested')) {
      throw new DaemonRunError('daemon_stop_not_confirmed')
    }
    return stop.status
  }

  async answerQuestion(input: { runId: string; answerId: string; response: AgentQuestionResponse }): Promise<boolean> {
    const reply = await this.#call({ op: 'answerQuestion', runId: input.runId, answerId: input.answerId, response: input.response })
    // The daemon answers with its ledger receipt: `answered` and `duplicate` both mean
    // the broker settled this question with this answer; anything else is not delivery.
    const receipt = reply.answer
    const status = record(receipt) ? receipt.status : undefined
    if (status !== 'answered' && status !== 'duplicate') throw new DaemonRunError('daemon_answer_not_delivered')
    return true
  }

  async runProjection(runId: string): Promise<SubscribeActiveRunRow | undefined> {
    const reply = await this.subscribe({ views: ['activeRuns'], trackedRunIds: [runId], waitMs: 0 })
    if (reply.mode !== 'snapshot' || !reply.snapshot.activeRuns) throw new DaemonRunError('invalid_daemon_response')
    return reply.snapshot.activeRuns.rows.find(row => row.runId === runId)
  }

  async runState(runId: string): Promise<string | null> {
    return (await this.runProjection(runId))?.lifecycle ?? null
  }

  /** The App viewed one of the daemon's unread sessions (E1b). Idempotent. */
  async attentionViewed(sessionKey: string): Promise<void> {
    const reply = await this.#call({ op: 'attentionViewed', sessionKey }, { replayable: true })
    if (reply.viewed !== true) throw new DaemonRunError('invalid_daemon_response')
  }

  /** Primary App pull for forwarded execution-target calls (W10); runs on its own lane. */
  async executionTargetWork(
    input: ExecutionTargetWorkRequest,
    signal?: AbortSignal
  ): Promise<ExecutionTargetWorkReply> {
    const reply = await this.#call(
      { op: 'executionTargetWork', ...input },
      { replayable: true, ...(signal ? { signal } : {}) }
    )
    const { calls, cancelledCallIds } = reply
    if (!Array.isArray(calls) || (cancelledCallIds !== undefined && !isExecutionTargetCallIds(cancelledCallIds))) {
      throw new DaemonRunError('invalid_daemon_response')
    }
    return { calls: calls as ExecutionTargetWorkCall[], ...(cancelledCallIds ? { cancelledCallIds } : {}) }
  }

  /** Primary App reply to a forwarded execution-target call (W10). */
  async executionTargetResult(
    input: { callId: string; ok: boolean; result?: unknown; error?: string },
    signal?: AbortSignal
  ): Promise<{ accepted: boolean }> {
    const reply = await this.#call(
      {
        op: 'executionTargetResult',
        callId: input.callId,
        ok: input.ok,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      },
      { replayable: false, ...(signal ? { signal } : {}) }
    )
    if (typeof reply.accepted !== 'boolean') throw new DaemonRunError('invalid_daemon_response')
    return { accepted: reply.accepted }
  }

  /** A full run snapshot, used to resynchronise after a gap. */
  async run(runId: string, context: unknown): Promise<ActiveRun | null> {
    const read = await this.trace({ context, runId })
    return read.kind === 'snapshot' ? read.run : fail()
  }

  /**
   * One App channel the daemon answers for this App (B4-L4). Transport failures keep the
   * lane's phase rule; the daemon's own error text is kept as the handler's message, so
   * the renderer sees what main's handler would have thrown. An older daemon without the
   * op is a named absence.
   */
  async localOp(input: { op: string; method: string; args: unknown[]; read: boolean }): Promise<unknown> {
    // JSON carries an omitted (undefined) argument as null. The renderer's own null and
    // a parameter it left out are different inputs to main's handler, so the positions
    // left out are named and the daemon restores them.
    const absent = input.args.flatMap((value, index) => value === undefined ? [index] : [])
    const reply = await this.forward({ op: input.op, method: input.method, args: input.args, ...(absent.length > 0 ? { absent } : {}) }, input.read)
    if (!('result' in reply)) throw new DaemonRunError('invalid_daemon_response')
    return reply.result
  }

  /**
   * One request for an op the daemon serves (route `forward` reuses the ops paired
   * devices use). Errors map as described for localOp; the reply is the caller's to read.
   */
  async forward(request: Record<string, unknown>, read: boolean): Promise<Record<string, unknown>> {
    let reply: unknown
    try {
      reply = await this.#request(request, { replayable: read })
    } catch (error) {
      throw error instanceof DaemonRunError ? error : new DaemonRunError(transportFailure(error))
    }
    if (!record(reply)) throw new DaemonRunError('invalid_daemon_response')
    if (reply.error === 'device_not_authorized') throw new DaemonRunError('daemon_device_not_authorized')
    if (reply.error === 'unsupported_op') {
      throw new Error(`daemon_capability_unavailable:${String(request.op)}${typeof request.method === 'string' ? `:${request.method}` : ''}`)
    }
    if (typeof reply.error === 'string') throw new Error(reply.error)
    return reply
  }

  async #call(request: Record<string, unknown>, options?: { replayable?: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    let reply: unknown
    try {
      reply = await this.#request(request, options)
    } catch (error) {
      // Lanes prove the phase they failed in. Only a provably unsent request may be
      // replayed by the caller; anything else - including an error this layer cannot
      // classify - is an unknown outcome, because guessing "not sent" re-runs writes.
      throw error instanceof DaemonRunError ? error : new DaemonRunError(transportFailure(error))
    }
    if (!record(reply)) throw new DaemonRunError('invalid_daemon_response')
    const error = failure(reply, typeof request.op === 'string' ? request.op : undefined)
    if (error) throw error
    return reply
  }
}
