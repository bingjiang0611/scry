import type { AgentInputAttachment, AgentQuestionResponse } from '../shared/runtime'
import type { ActiveRun } from '../shared/trace'
import type { DesktopRemoteContext, DesktopTraceCursor, DesktopRemoteTraceRead } from '../shared/desktop-remote'
import type { SubscribeActiveRunRow, SubscribeReply, SubscribeRequest } from '../shared/orchestration-subscribe'
import { isExecutionTargetCallIds, type ExecutionTargetWorkCall, type ExecutionTargetWorkReply, type ExecutionTargetWorkRequest } from '../shared/execution-target-work'
import { RUN_ADMISSION_BUSY_MESSAGE } from './context-admission'
import { DaemonRunRefusedError } from './daemon-run-admission'
import { DaemonClientError } from './daemon-client'
import { DaemonRunError, fail, record, type DaemonRunFailure } from './daemon-run-error'
import { readDaemonTrace } from './daemon-run-trace-read'
import { context as desktopContext } from './remote/desktop-client-validation'
import { laneWasNotSent, laneWasWrittenUnknown } from './remote/desktop-lane'
import { assembleByteChunks } from './remote/desktop-byte-chunks'
import { stageDesktopImage, type desktopImageReference } from './remote/desktop-attachments'
import { parseSubscribeReply, readDaemonArchivedRunTrace } from './daemon-subscribe-parse'


export { DaemonRunError, type DaemonRunFailure } from './daemon-run-error'

export type DaemonRequest = (
  request: Record<string, unknown>,
  options?: { replayable?: boolean; signal?: AbortSignal }
) => Promise<unknown>

export interface DaemonSubmitResult {
  intentId: string
  runId: string
  status: 'recorded' | 'duplicate'
  seq?: number
}

export interface DaemonIntentState {
  runId: string
  state: string
}

function transportFailure(error: unknown): DaemonRunFailure {
  if (error instanceof DaemonClientError) {
    if (error.reason === 'daemon_device_not_authorized') return 'daemon_device_not_authorized'
    return 'daemon_not_running'
  }
  if (laneWasNotSent(error)) return 'daemon_not_running'
  if (laneWasWrittenUnknown(error)) return 'daemon_outcome_unknown'
  return 'daemon_outcome_unknown'
}

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
  if (code === 'unknown_intent' && op === 'intentStatusAtLog') return new DaemonRunError('daemon_run_unknown')
  if (op === 'submit' && (code === 'command_payload_conflict' || code === 'intent_payload_conflict')) {
    return new DaemonRunError('command_payload_conflict')
  }
  if (code === 'device_not_authorized' || code === 'execution_target_bridge_unauthorized') return new DaemonRunError('daemon_device_not_authorized')
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
    const seq = Number.isSafeInteger(reply.seq) && (reply.seq as number) > 0 ? reply.seq as number : undefined
    return { intentId: input.intentId, runId, status: reply.status, ...(seq !== undefined ? { seq } : {}) }
  }

  stageImage(reference: ReturnType<typeof desktopImageReference>, attachment: AgentInputAttachment): Promise<void> {
    return stageDesktopImage((request) => this.#call(request), reference, attachment)
  }

  async intentState(intentId: string): Promise<DaemonIntentState> {
    const reply = await this.#call({ op: 'intentStatusAtLog', intentId })
    const intent = reply.intent
    if (!record(intent) || !isDaemonRunId(intent.runId) || typeof intent.state !== 'string') {
      throw new DaemonRunError('daemon_run_unknown')
    }
    return { runId: intent.runId, state: intent.state }
  }

  async trace(input: { context: unknown; runId: string; after?: DesktopTraceCursor }): Promise<DesktopRemoteTraceRead> {
    return await readDaemonTrace((request, options) => this.#call(request, options), input)
  }

  async archivedRunTrace(input: { context: DesktopRemoteContext; runId: string }): Promise<ActiveRun | null> {
    return await readDaemonArchivedRunTrace((request, options) => this.#call(request, options), input)
  }

  async subscribe(input: SubscribeRequest, signal?: AbortSignal): Promise<SubscribeReply> {
    const request = async (chunk?: SubscribeRequest['chunk']) => {
      const reply = await this.#call({ op: 'subscribe', ...input, ...(chunk ? { chunk } : {}) }, { replayable: true, signal })
      return record(reply.subscribe) ? reply.subscribe : fail()
    }
    let subscribe = await request()
    if (subscribe.kind === 'history_chunk') subscribe = await assembleByteChunks(subscribe, request, fail)
    return parseSubscribeReply({ subscribe })
  }

  async runControl(request: { method: 'steer' | 'stopBackgroundTask'; payload: unknown }): Promise<Record<string, unknown>> {
    return await this.#call({ op: 'runControl', ...request })
  }

  async adopt(runId: string): Promise<ActiveRun | null> {
    const reply = await this.#call({ op: 'runControl', method: 'adopt', runId, payload: 'traceContext' }, { replayable: true })
    if (typeof reply.refused === 'string') throw new Error(reply.refused)
    if (reply.run === null) return null
    if (reply.traceContext !== undefined) {
      const read = await this.trace({ context: desktopContext(reply.traceContext), runId })
      if (read.kind !== 'snapshot' || (read.run !== null && read.run.runId !== runId)) return fail()
      return read.run
    }
    if (!record(reply.run) || reply.run.runId !== runId || !Array.isArray(reply.run.items)) return fail()
    return reply.run as unknown as ActiveRun
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

  async attentionViewed(sessionKey: string): Promise<void> {
    const reply = await this.#call({ op: 'attentionViewed', sessionKey }, { replayable: true })
    if (reply.viewed !== true) throw new DaemonRunError('invalid_daemon_response')
  }

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

  async run(runId: string, context: unknown): Promise<ActiveRun | null> {
    const read = await this.trace({ context, runId })
    return read.kind === 'snapshot' ? read.run : fail()
  }

  async localOp(input: { op: string; method: string; args: unknown[]; read: boolean }): Promise<unknown> {
    const absent = input.args.flatMap((value, index) => value === undefined ? [index] : [])
    const reply = await this.forward({ op: input.op, method: input.method, args: input.args, ...(absent.length > 0 ? { absent } : {}) }, input.read)
    if (!('result' in reply)) throw new DaemonRunError('invalid_daemon_response')
    return reply.result
  }

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
      throw error instanceof DaemonRunError ? error : new DaemonRunError(transportFailure(error))
    }
    if (!record(reply)) throw new DaemonRunError('invalid_daemon_response')
    const error = failure(reply, typeof request.op === 'string' ? request.op : undefined)
    if (error) throw error
    return reply
  }
}
