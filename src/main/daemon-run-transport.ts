import type { AgentQuestionRequest, AgentQuestionResponse } from '../shared/runtime'
import type { ActiveRun } from '../shared/trace'
import type { DesktopTraceCursor, DesktopRemoteTraceRead } from '../shared/desktop-remote'
import { DaemonClientError } from './daemon-client'
import { laneWasNotSent, laneWasWrittenUnknown } from './remote/desktop-lane'

// The App's run surface against its own daemon, over the same frames the phone
// uses. This module only parses and types those frames: it holds no socket, no
// credential and no run state, so a caller can drive it from a test without a
// daemon and the bootstrap can decide where the frames come from.
//
// Failure is explicit: a host error code becomes a named rejection, and a reply
// that does not carry the expected fields is `invalid_daemon_response` rather
// than an empty success.

export type DaemonRequest = (
  request: Record<string, unknown>,
  options?: { replayable?: boolean; signal?: AbortSignal }
) => Promise<unknown>

export type DaemonRunFailure =
  | 'daemon_not_running'
  | 'daemon_device_not_authorized'
  | 'daemon_run_unknown'
  | 'daemon_stop_not_confirmed'
  | 'daemon_answer_not_delivered'
  | 'daemon_run_control_unavailable'
  // The request was written and no reply came back: the daemon may or may not have
  // acted. Callers reconcile (by intent id) and never resend.
  | 'daemon_outcome_unknown'
  // A start was submitted, the reply was lost, and the daemon could not confirm what
  // it recorded. Reported as unknown so the App never starts the same prompt twice.
  | 'daemon_submit_unknown'
  | 'invalid_daemon_response'

export class DaemonRunError extends Error {
  readonly reason: DaemonRunFailure
  constructor(reason: DaemonRunFailure) {
    super(reason)
    this.name = 'DaemonRunError'
    this.reason = reason
  }
}

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

export interface DaemonWatchReply {
  // Lifecycle state as the daemon reports it; `null` means the ledger no longer
  // holds the run, which is evidence, not "still running".
  state: string | null
  cursor: number
  events: ReadonlyArray<{ runId: string; kind: string; detail?: string }>
  // How much content the daemon has for this run. The text itself travels on the
  // trace, but the count is what tells a live run apart from an idle one: the ledger
  // only moves at lifecycle points, so a watch that waits on it alone hears nothing
  // while the Provider is streaming.
  output: { count: number; cursor: number }
}

export interface DaemonOutputStream {
  chunks: ReadonlyArray<{ seq: number; text?: string }>
  cursor: number
}

const MAX_ITEMS = 512

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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Deliberately narrow: the daemon only ever names runs it created itself.
export function isDaemonRunId(value: unknown): value is string {
  return typeof value === 'string' && (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
    /^run-[0-9a-z]{1,16}-[0-9]{1,12}$/.test(value)
  )
}

function failure(reply: Record<string, unknown>): DaemonRunError | undefined {
  const code = reply.error
  if (code === undefined) return undefined
  if (code === 'device_not_authorized') return new DaemonRunError('daemon_device_not_authorized')
  // An older daemon has no run controls at all: a named absence, not an empty success.
  if (code === 'unsupported_op') return new DaemonRunError('daemon_run_control_unavailable')
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
    // An older daemon does not report the intent's position; the caller then falls back
    // to the newest cursor this connection has seen.
    const seq = Number.isSafeInteger(reply.seq) && (reply.seq as number) > 0 ? reply.seq as number : undefined
    return { intentId: input.intentId, runId, status: reply.status, ...(seq !== undefined ? { seq } : {}) }
  }

  // A recorded intent is not a dispatched run. Recovery asks this after a
  // reconnect instead of re-submitting the same prompt.
  async intentState(intentId: string): Promise<DaemonIntentState> {
    const reply = await this.#call({ op: 'intentStatus', intentId })
    const intent = reply.intent
    if (!record(intent) || !isDaemonRunId(intent.runId) || typeof intent.state !== 'string') {
      throw new DaemonRunError('daemon_run_unknown')
    }
    return { runId: intent.runId, state: intent.state }
  }

  async watch(input: { runId: string; cursor: number; outputCursor: number; waitMs: number; output: boolean }, signal?: AbortSignal): Promise<DaemonWatchReply> {
    const reply = await this.#call({
      op: 'watch', runId: input.runId, cursor: input.cursor,
      outputCursor: input.outputCursor, waitMs: input.waitMs, output: input.output
    }, signal === undefined ? undefined : { signal })
    const watch = reply.watch
    if (!record(watch) || !record(watch.poll) || !Array.isArray(watch.poll.events) ||
        !Number.isSafeInteger(watch.poll.cursor) || watch.poll.events.length > MAX_ITEMS) {
      throw new DaemonRunError('invalid_daemon_response')
    }
    const poll = watch.poll as { events: unknown[]; cursor: number }
    const events = poll.events.flatMap((raw) => {
      if (!record(raw) || typeof raw.runId !== 'string' || typeof raw.kind !== 'string') return []
      return [{ runId: raw.runId, kind: raw.kind, ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}) }]
    })
    const state = watch.state === undefined || watch.state === null ? null : typeof watch.state === 'string' ? watch.state : fail()
    const page = record(watch.output) ? watch.output : undefined
    const chunks = page && Array.isArray(page.chunks) ? page.chunks : []
    const output = {
      count: chunks.length,
      cursor: page && Number.isSafeInteger(page.cursor) ? page.cursor as number : input.outputCursor
    }
    return { state, cursor: poll.cursor as number, events, output }
  }

  /** One canonical trace read for a live run; the delta cursor is the caller's. */
  async trace(input: { context: unknown; runId: string; after?: DesktopTraceCursor }): Promise<DesktopRemoteTraceRead> {
    const reply = await this.#call({
      op: 'desktop',
      query: {
        kind: 'trace', context: input.context, runId: input.runId, images: true, byteChunks: true,
        ...(input.after ? { delta: { after: input.after } } : {})
      }
    }, { replayable: true })
    const desktop = reply.desktop
    if (!record(desktop)) throw new DaemonRunError('invalid_daemon_response')
    // The wire says `trace`/`trace_delta`; the renderer contract says
    // snapshot/delta. A wire shape that names neither is refused, not guessed.
    if (desktop.kind === 'trace') {
      const run = desktop.run === null ? null : record(desktop.run) && typeof desktop.run.runId === 'string' ? desktop.run as unknown as ActiveRun : fail()
      const cursor = traceCursor(desktop.cursor)
      return { kind: 'snapshot', run, ...(cursor ? { cursor } : {}) }
    }
    if (desktop.kind === 'trace_delta') {
      const base = typeof desktop.base === 'string' ? desktop.base : fail()
      const cursor = traceCursor({ revision: desktop.revision, count: desktop.count })
      if (!record(desktop.run) || !Array.isArray(desktop.changes)) throw new DaemonRunError('invalid_daemon_response')
      return {
        kind: 'delta', run: desktop.run as unknown as Omit<ActiveRun, 'items'>,
        base, cursor: cursor ?? fail(), changes: desktop.changes as never
      }
    }
    throw new DaemonRunError('invalid_daemon_response')
  }

  async output(input: { runId: string; cursor: number }): Promise<DaemonOutputStream> {
    const reply = await this.#call({ op: 'output', runId: input.runId, cursor: input.cursor }, { replayable: true })
    const output = reply.output
    if (!record(output) || !Array.isArray(output.chunks) || !Number.isSafeInteger(output.cursor)) {
      throw new DaemonRunError('invalid_daemon_response')
    }
    return output as unknown as DaemonOutputStream
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

  async questions(runId: string): Promise<AgentQuestionRequest[]> {
    const reply = await this.#call({ op: 'questions', runId }, { replayable: true })
    if (!Array.isArray(reply.questions)) throw new DaemonRunError('invalid_daemon_response')
    return reply.questions as AgentQuestionRequest[]
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

  async liveRuns(input: { waitMs: number; revision?: string }): Promise<{ revision: string; runs: ReadonlyArray<{ runId: string; state: string; scryRunId?: string }> }> {
    const reply = await this.#call(
      { op: 'liveRuns', waitMs: input.waitMs, ...(input.revision ? { revision: input.revision } : {}) },
      { replayable: true }
    )
    const live = reply.liveRuns
    if (!record(live) || typeof live.revision !== 'string' || !Array.isArray(live.runs)) throw new DaemonRunError('invalid_daemon_response')
    const runs = live.runs.flatMap((raw) => {
      if (!record(raw) || !isDaemonRunId(raw.runId) || typeof raw.state !== 'string') return []
      return [{ runId: raw.runId, state: raw.state, ...(isDaemonRunId(raw.scryRunId) ? { scryRunId: raw.scryRunId } : {}) }]
    })
    return { revision: live.revision, runs }
  }

  async runState(runId: string): Promise<string | null> {
    const reply = await this.#call({ op: 'runState', runId }, { replayable: true })
    if (reply.state === null) return null
    if (!record(reply.state) || typeof reply.state.state !== 'string') throw new DaemonRunError('invalid_daemon_response')
    return reply.state.state
  }

  /** A full run snapshot, used to resynchronise after a gap. */
  async run(runId: string, context: unknown): Promise<ActiveRun | null> {
    const read = await this.trace({ context, runId })
    return read.kind === 'snapshot' ? read.run : fail()
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
    const error = failure(reply)
    if (error) throw error
    return reply
  }
}

function traceCursor(value: unknown): DesktopTraceCursor | undefined {
  if (value === undefined) return undefined
  if (!record(value) || typeof value.revision !== 'string' || !Number.isSafeInteger(value.count)) return undefined
  return { revision: value.revision, count: value.count as number }
}

function fail(): never {
  throw new DaemonRunError('invalid_daemon_response')
}
