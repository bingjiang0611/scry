import { admissionPhase, DaemonRunRefusedError, DEFAULT_ADMIT_BUDGET_MS } from './daemon-run-admission'
import { planDelivery } from './daemon-run-delivery'
import { PerformanceTrace } from './performance-timing'
import { TraceOutputBridge } from './trace-output'
import type { AgentQuestionRequest, AgentQuestionResponse, AgentStopState } from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { DesktopRemoteContext } from '../shared/desktop-remote'
import type { SubscribeActiveRunRow, SubscribeEventItem, SubscribeHint } from '../shared/orchestration-subscribe'
import { usesScopedRunDelivery, view, type RunCursor } from './daemon-run-cursor'
import { DaemonRunError, type DaemonRunTransport, type DaemonSubmitResult } from './daemon-run-transport'
import { RunWakes } from './daemon-run-wakes'
import { answerQuestion, publishQuestions, type QuestionSinks } from './daemon-run-questions'
import type { RunTraceRouter } from './run-trace-router'
import { applyRunHintToRuntime, applySubscribeEventToRuntime, applySubscribeSnapshotToRuntime, awaitSubscribeAdmission, readSubscribeTraceOnce, type SubscribeRuntimeContext } from './daemon-run-subscribe'


// How long a start waits for the daemon to bind a canonical run id. A run that has
// not bound by then is still recorded; the caller gets the ledger id and `bound:
// false`, and the window resynchronises from `agent:activeRun`.
const DEFAULT_BIND_BUDGET_MS = 3_000

export interface DaemonStartInput {
  intentId: string
  detail: string
  context: DesktopRemoteContext
  userText?: string
}

export interface DaemonStartReceipt {
  intentId: string
  runId: string
  status: 'recorded' | 'duplicate'
  seq?: number
  /** Whether `runId` is the canonical id the trace events carry. */
  bound: boolean
}

export interface DaemonRunRuntimeDeps {
  transport: DaemonRunTransport
  send: (channel: string, payload: unknown) => void
  bindBudgetMs?: number
  admitBudgetMs?: number
  bridge?: TraceOutputBridge
  onWarn?: (message: string, detail?: unknown) => void
  runTraces?: Pick<RunTraceRouter, 'route' | 'settle'> & Partial<Pick<RunTraceRouter, 'publishStopState'>> & NonNullable<QuestionSinks['subscription']>
}

export class DaemonRunRuntime {
  readonly #deps: DaemonRunRuntimeDeps
  readonly #runs = new Map<string, RunCursor>()
  readonly #locks = new Map<string, Promise<void>>()
  readonly #bridge: TraceOutputBridge
  #disposed = false
  readonly #terminal = new Map<string, Promise<void>>()
  #onSessionBound?: (payload: Record<string, unknown>) => void

  setOnSessionBound(listener: ((payload: Record<string, unknown>) => void) | undefined): void { this.#onSessionBound = listener }

  #subCtx(): SubscribeRuntimeContext {
    return {
      runs: this.#runs, wakes: this.#wakes, cursorFor: (id) => this.#cursorFor(id), send: this.#deps.send,
      isDisposed: () => this.#disposed, onWarn: this.#deps.onWarn,
      trackTerminal: (id, delivery) => {
        this.#terminal.set(id, delivery)
        void delivery.finally(() => { if (this.#terminal.get(id) === delivery) this.#terminal.delete(id) })
      },
      onSessionBound: (payload) => this.#onSessionBound?.(payload),
      publishStopState: (state: AgentStopState) => this.#deps.runTraces?.publishStopState?.(state),
      settleRunTrace: (id) => this.#deps.runTraces?.settle(id), flushBridge: () => this.#bridge.flushAll(),
      scheduleTraceRead: (id, opts) => this.#readTraceSerialized(id, opts), syncQuestions: (cursor, questions) => this.#publishQuestions(cursor, questions),
      probeRunState: (id) => this.#deps.transport.runState(id)
    }
  }

  async applySubscribeSnapshot(rows: SubscribeActiveRunRow[]): Promise<void> { if (!this.#disposed) await applySubscribeSnapshotToRuntime(this.#subCtx(), rows) }
  async applySubscribeEvent(event: SubscribeEventItem): Promise<void> { if (!this.#disposed) await applySubscribeEventToRuntime(this.#subCtx(), event) }
  /** Resolves once a terminal event's final trace delivery for `runId` has finished. */
  async terminalDelivered(runId: string): Promise<void> { await this.#terminal.get(runId) }
  applyRunHint(hint: Extract<SubscribeHint, { kind: 'run' }>): Promise<void> | undefined {
    if (!this.#disposed) return applyRunHintToRuntime(this.#subCtx(), hint)
    return undefined
  }

  #readTraceSerialized(runId: string, options?: { terminal?: boolean }): Promise<void> {
    const previous = this.#locks.get(runId) ?? Promise.resolve()
    const next = previous.then(() => readSubscribeTraceOnce({
      cursor: this.#runs.get(runId), runId, disposed: this.#disposed, terminal: options?.terminal,
      transport: this.#deps.transport, apply: (read, cursor) => this.#apply(read, cursor),
      flush: () => this.#bridge.flush(), onWarn: this.#deps.onWarn
    }))
    this.#locks.set(runId, next.then(() => undefined, () => undefined))
    return next
  }

  constructor(deps: DaemonRunRuntimeDeps) {
    this.#deps = deps
    this.#bridge = deps.bridge ?? new TraceOutputBridge({
      canSend: () => true,
      // The same batching window the in-process pipeline uses; the difference is only
      // what flushes it early (see the step boundary below).
      flushMs: 16,
      send: (payload) => this.#deps.send('agent:trace', payload),
      publishHealth: (state) => this.#deps.send('agent:traceHealth', state)
    })
  }

  readonly #wakes = new RunWakes()

  get bridge(): TraceOutputBridge { return this.#bridge }

  async start(input: DaemonStartInput): Promise<DaemonStartReceipt> {
    const stamp = new PerformanceTrace('daemon.run.firstText', input.context ? { provider: input.context.providerId } : {})
    const { intentId, detail } = input
    let receipt: DaemonSubmitResult
    let recovered = false
    try {
      receipt = await this.#deps.transport.submit({ intentId, detail })
    } catch (error) {
      if (!(error instanceof DaemonRunError) || error.reason !== 'daemon_outcome_unknown') throw error
      // The submit may have been recorded. Read its receipt; never dispatch it again.
      try {
        const recorded = await this.#deps.transport.intentState(intentId)
        receipt = { intentId, runId: recorded.runId, status: 'recorded' }
        recovered = true
      } catch (cause) {
        throw Object.assign(new DaemonRunError('daemon_submit_unknown'), { cause })
      }
    }
    stamp.mark('submitted')
    this.#track(receipt.runId, input.context, stamp, input.userText)
    const tracked = this.#runs.get(receipt.runId)!
    // A duplicate, or a receipt recovered after a lost reply, may have bound or been
    // refused while this window was not following it: read its projection row so the
    // normal binding and admission path decides, instead of focusing on the receipt alone.
    if ((receipt.status === 'duplicate' || recovered) && (!tracked.scryRunId || admissionPhase(tracked) === 'pending')) {
      const current = await this.#deps.transport.runProjection(receipt.runId)
      // One tracked row is a receipt lookup, not the window's full active set.
      if (current) await applySubscribeSnapshotToRuntime({ ...this.#subCtx(), probeRunState: undefined }, [current])
    }
    // The window identifies a run by the canonical id its trace events carry, not
    // by the ledger id it submitted. Wait for the daemon's bind and admission, and say
    // so when it did not bind instead of handing back an id the trace will never match.
    const bound = await this.#awaitBound(receipt.runId)
    const cursor = this.#runs.get(receipt.runId)
    if (cursor && admissionPhase(cursor) === 'refused') {
      // Refused before admission, as an in-process start rejects: no run is handed out.
      this.#runs.delete(receipt.runId)
      throw new DaemonRunRefusedError(cursor.failure)
    }
    if (cursor && bound !== undefined) cursor.handedOut = true
    return { ...receipt, runId: bound ?? receipt.runId, bound: bound !== undefined }
  }

  async follow(input: { runId: string }): Promise<{ runId: string; bound: boolean }> {
    this.#track(input.runId)
    const bound = await this.#awaitBound(input.runId)
    return { runId: bound ?? input.runId, bound: bound !== undefined }
  }

  #track(runId: string, context?: DesktopRemoteContext, stamp?: PerformanceTrace, userText?: string): void {
    // A duplicate submit is the same logical run: keep its existing cursor rather
    // than restarting the trace from zero.
    if (!this.#runs.has(runId)) {
      this.#runs.set(runId, {
        runId, context, lifecycle: 'recorded', output: 0,
        pushed: [], askedQuestions: new Set(), answerIds: new Map(), resyncRequired: false, stopped: false,
        ...(stamp ? { stamp } : {}), ...(userText !== undefined ? { userText } : {}), sawText: false
      })
    }
  }

  /**
   * W1: deliver one of the daemon pipeline's notices for a run only after the text the
   * daemon held when it sent it, as in process the trace is flushed before "turn done".
   * One read without waiting, then a full flush; a run this window does not follow, or
   * one that ended and flushed, is delivered at once.
   */
  async deliverAfterRead(runId: string | undefined, deliver: () => void): Promise<void> {
    const cursor = runId === undefined ? undefined : this.#cursorFor(runId)
    if (cursor && !cursor.stopped && !this.#disposed) {
      await this.#readTraceSerialized(cursor.runId)
      this.#bridge.flushAll()
    }
    deliver()
  }

  isTracking(runId: string): boolean { return this.#cursorFor(runId) !== undefined }

  /**
   * The last authoritative view of one run, finished or not; `null` means unseen.
   * Accepts either id: the window focuses a run by the canonical id its trace carries,
   * while this map is keyed by the ledger id the run was submitted under.
   */
  runView(runId: string): ActiveRun | null {
    const cursor = this.#cursorFor(runId)
    return cursor ? view(cursor) : null
  }

  #cursorFor(runId: string): RunCursor | undefined {
    for (const cursor of this.#runs.values()) {
      if (cursor.runId === runId || cursor.scryRunId === runId || cursor.latest?.runId === runId) return cursor
    }
    return undefined
  }

  activeRuns(): ActiveRun[] {
    return [...this.#runs.values()].flatMap((cursor) => {
      const current = view(cursor)
      return current && !current.done ? [current] : []
    })
  }

  /**
   * Subscribe to a run this window did not start (its own daemon restarted, or the
   * run came from another client). The Provider and directory are learned from the
   * daemon's bind, so one window is read before the trace can be addressed.
   */
  async adopt(runId: string): Promise<ActiveRun | null> {
    // The name may be the canonical id the live-run list reports for a run this window
    // already follows: that is the same run, not a second one over the same items.
    const cursor = this.#cursorFor(runId) ?? (() => {
      const created: RunCursor = {
        runId, lifecycle: null, output: 0, pushed: [], askedQuestions: new Set(), answerIds: new Map(),
        resyncRequired: false, stopped: false, sawText: false
      }
      this.#runs.set(runId, created)
      return created
    })()
    if (cursor.latest) return cursor.latest
    await this.#readTraceSerialized(cursor.runId)
    return cursor.latest ?? null
  }

  #awaitBound(runId: string): Promise<string | undefined> {
    return awaitSubscribeAdmission({
      runId, cursor: () => this.#runs.get(runId), wakes: this.#wakes,
      bindBudgetMs: this.#deps.bindBudgetMs ?? DEFAULT_BIND_BUDGET_MS, admitBudgetMs: this.#deps.admitBudgetMs ?? DEFAULT_ADMIT_BUDGET_MS
    })
  }

  async snapshot(runId: string, context: DesktopRemoteContext): Promise<ActiveRun | null> {
    const read = await this.#deps.transport.trace({ context, runId })
    if (read.kind !== 'snapshot') return null
    const run = read.run
    const cursor = this.#runs.get(runId)
    if (cursor) {
      // The snapshot is the new base: later deltas apply to it, and nothing is
      // reported as appended until it has been delivered.
      cursor.after = read.cursor
      cursor.pushed = [...(run?.items ?? [])]
      cursor.resyncRequired = false
    }
    return run
  }

  async stop(runId: string): Promise<boolean> {
    const cursor = this.#cursorFor(runId)
    await this.#deps.transport.stop(cursor?.runId ?? runId)
    if (cursor) cursor.lifecycle = 'stopping'
    return true
  }

  async answerQuestion(response: AgentQuestionResponse): Promise<boolean> {
    return await answerQuestion(this.#cursorFor(response.runId), response, this.#deps.transport)
  }

  // The stamp ends when text first reaches the renderer; that is the number the user
  // waits for, and the stages before it say which hop spent the time.
  #delivered(cursor: RunCursor, event: TraceEvent): void {
    if (!usesScopedRunDelivery(cursor)) this.#bridge.push(event)
    this.#deps.runTraces?.route(event)
    if (cursor.sawText || cursor.stamp === undefined) return
    if (event.stage !== 'text' && event.stage !== 'text_delta') return
    cursor.sawText = true
    cursor.stamp.mark('firstText')
    cursor.stamp.finish()
  }

  #apply(read: Awaited<ReturnType<DaemonRunTransport['trace']>>, cursor: RunCursor): boolean {
    if (read.run?.conversationId) cursor.scopedDelivery = true
    if (read.kind === 'snapshot' && read.run) cursor.latest = read.run
    const plan = planDelivery(cursor.pushed, read)
    for (const event of plan.events) this.#delivered(cursor, event)
    cursor.pushed = plan.pushed
    cursor.after = read.cursor
    if (plan.resyncRequired) {
      // One health note per divergence, not one per poll: the renderer answers by
      // re-reading a snapshot, which clears it.
      if (!cursor.resyncRequired) this.#deps.send('agent:traceHealth', this.#bridge.snapshot())
      cursor.resyncRequired = true
      return plan.events.length > 0
    }
    cursor.resyncRequired = false
    return plan.events.length > 0
  }

  #publishQuestions(cursor: RunCursor, projected: AgentQuestionRequest[]): Promise<void> {
    return publishQuestions(cursor, projected, {
      send: this.#deps.send, ...(this.#deps.runTraces ? { subscription: this.#deps.runTraces } : {})
    })
  }

  /** Forget one run's cursor, e.g. after the view moved to another session. */
  release(runId: string): void {
    const cursor = this.#runs.get(runId)
    if (cursor) cursor.stopped = true
    this.#wakes.wake(runId)
  }

  dispose(): void {
    this.#disposed = true
    for (const cursor of this.#runs.values()) cursor.stopped = true
    this.#wakes.wakeAll()
    this.#bridge.close()
  }
}

export function traceEventItemCount(run: ActiveRun | null): number {
  return run ? run.items.length : 0
}

export type { TraceEvent }
