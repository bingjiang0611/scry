import { admissionPhase, awaitAdmission, DaemonRunRefusedError, DEFAULT_ADMIT_BUDGET_MS, lateRefusalNotice } from './daemon-run-admission'
import { planDelivery } from './daemon-run-delivery'
import { PerformanceTrace } from './performance-timing'
import { TraceOutputBridge } from './trace-output'
import type { AgentQuestionResponse, AgentStopState } from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { DesktopRemoteContext } from '../shared/desktop-remote'
import type { SubscribeActiveRunRow, SubscribeEventItem, SubscribeHint } from '../shared/orchestration-subscribe'
import { resume, view, type RunCursor } from './daemon-run-cursor'
import { DaemonRunTransport } from './daemon-run-transport'
import { RunWakes } from './daemon-run-wakes'
import { answerQuestion, publishQuestions, type QuestionSinks } from './daemon-run-questions'
import type { RunTraceRouter } from './run-trace-router'
import { applyRunHintToRuntime, applySubscribeEventToRuntime, applySubscribeSnapshotToRuntime, awaitSubscribeAdmission, readSubscribeTraceOnce, type SubscribeRuntimeContext } from './daemon-run-subscribe'
import { DEFAULT_WATCH_WAIT_MS, stepLegacyWatchRun } from './daemon-run-watch'

// The App's run view driven by the daemon: turns daemon frames into renderer trace,
// question, and lifecycle events without inventing progress.

const DEFAULT_WAIT_MS = 15_000
// How long a start waits for the daemon to bind a canonical run id. A run that has
// not bound by then is still recorded; the caller gets the ledger id and `bound:
// false`, and the window resynchronises from `agent:activeRun`.
const DEFAULT_BIND_BUDGET_MS = 3_000
const TERMINAL = new Set(['settled', 'failed', 'cancelled'])

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
  /** Whether `runId` is the canonical id the trace events carry. */
  bound: boolean
}

export interface DaemonRunRuntimeDeps {
  transport: DaemonRunTransport
  send: (channel: string, payload: unknown) => void
  /** P4-3: event-driven lifecycle from `subscribe` with zero per-run `watch` or `settledTail`. */
  subscribeMode?: boolean
  // Long-poll window. The daemon answers earlier when something changes.
  waitMs?: number
  bindBudgetMs?: number
  admitBudgetMs?: number
  bridge?: TraceOutputBridge
  onWarn?: (message: string, detail?: unknown) => void
  // P3f W2: the App's run-level subscriptions (RunTraceRouter). A view that subscribes to
  // one run (the conversation view) reads this, not the window-wide trace stream.
  runTraces?: Pick<RunTraceRouter, 'route' | 'settle'> & Partial<Pick<RunTraceRouter, 'publishStopState'>> & NonNullable<QuestionSinks['subscription']>
}

export class DaemonRunRuntime {
  readonly #deps: DaemonRunRuntimeDeps
  readonly #runs = new Map<string, RunCursor>()
  readonly #locks = new Map<string, Promise<void>>()
  readonly #bridge: TraceOutputBridge
  // The newest ledger position any watch on this connection has read. A run this window
  // did not submit can only start from the session's beginning, but a run it did submit
  // starts at its own intent.
  #seen = 0
  #disposed = false
  #onSessionBound?: (payload: Record<string, unknown>) => void

  setOnSessionBound(listener: ((payload: Record<string, unknown>) => void) | undefined): void { this.#onSessionBound = listener }

  #subCtx(): SubscribeRuntimeContext {
    return {
      runs: this.#runs, wakes: this.#wakes, cursorFor: (id) => this.#cursorFor(id), send: this.#deps.send,
      onSessionBound: (payload) => this.#onSessionBound?.(payload),
      publishStopState: (state: AgentStopState) => this.#deps.runTraces?.publishStopState?.(state),
      settleRunTrace: (id) => this.#deps.runTraces?.settle(id), flushBridge: () => this.#bridge.flushAll(),
      scheduleTraceRead: (id, opts) => this.#readTraceSerialized(id, opts), syncQuestions: (cursor) => this.#publishQuestions(cursor),
      probeRunState: (id) => this.#deps.transport.runState(id)
    }
  }

  async applySubscribeSnapshot(rows: SubscribeActiveRunRow[]): Promise<void> { if (!this.#disposed) await applySubscribeSnapshotToRuntime(this.#subCtx(), rows) }
  async applySubscribeEvent(event: SubscribeEventItem): Promise<void> { if (!this.#disposed) await applySubscribeEventToRuntime(this.#subCtx(), event) }
  applyRunHint(hint: Extract<SubscribeHint, { kind: 'run' }>): void { if (!this.#disposed) applyRunHintToRuntime(this.#subCtx(), hint) }

  #readTraceSerialized(runId: string, options?: { terminal?: boolean }): Promise<void> {
    const previous = this.#locks.get(runId) ?? Promise.resolve()
    const next = previous.then(() => readSubscribeTraceOnce({
      cursor: this.#runs.get(runId), runId, disposed: this.#disposed, terminal: options?.terminal,
      transport: this.#deps.transport, apply: (read, cursor) => this.#apply(read, cursor),
      syncQuestions: (cursor) => this.#publishQuestions(cursor), flush: () => this.#bridge.flush(), onWarn: this.#deps.onWarn
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

  // P3f E2: the App event feed's run notices. While it is live a run reads when woken
  // instead of holding a long poll on the one watch lane other runs need too.
  readonly #wakes = new RunWakes()
  wake(runId: string): void { this.#wakes.wake(runId) }
  // Every run re-reads, including one whose pump ended on the outage that lost them.
  wakeAll(): void {
    this.#wakes.wakeAll()
    for (const cursor of this.#runs.values()) if (!this.#disposed && resume(cursor)) void this.pump(cursor.runId)
  }
  setWakesLive(live: boolean): void { this.#wakes.setLive(live) }

  /** The batching bridge, so `agent:traceAck` credits the same delivery state. */
  get bridge(): TraceOutputBridge { return this.#bridge }

  async start(input: DaemonStartInput): Promise<DaemonStartReceipt> {
    const stamp = new PerformanceTrace('daemon.run.firstText', input.context ? { provider: input.context.providerId } : {})
    const receipt = await this.#deps.transport.submit({ intentId: input.intentId, detail: input.detail })
    stamp.mark('submitted')
    this.#track(receipt.runId, input.context, receipt.seq, stamp, input.userText)
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

  /**
   * Follow a run the daemon recorded on this window's behalf (a conversation send): the
   * same cursor, pump and bind as a run this window submitted. Its context is learned
   * from the daemon's bind.
   */
  async follow(input: { runId: string; seq?: number }): Promise<{ runId: string; bound: boolean }> {
    this.#track(input.runId, undefined, input.seq)
    const bound = await this.#awaitBound(input.runId)
    return { runId: bound ?? input.runId, bound: bound !== undefined }
  }

  // Synchronous on purpose: a start answers right after its bind, exactly as before
  // this was shared, so nothing it awaits moves.
  #track(runId: string, context: DesktopRemoteContext | undefined, seq: number | undefined, stamp?: PerformanceTrace, userText?: string): void {
    // A duplicate submit is the same logical run: keep its existing cursor rather
    // than restarting the trace from zero.
    if (!this.#runs.has(runId)) {
      this.#runs.set(runId, {
        // A run's own evidence cannot predate its intent, so its watch starts there
        // instead of at the session's first page.
        runId, context, lifecycle: 'recorded',
        watch: seq !== undefined ? Math.max(0, seq - 1) : this.#seen, output: 0,
        pushed: [], askedQuestions: new Set(), answerIds: new Map(), resyncRequired: false, pumping: false, stopped: false,
        ...(stamp ? { stamp } : {}), ...(userText !== undefined ? { userText } : {}), sawText: false
      })
    }
    if (!this.#deps.subscribeMode) void this.pump(runId)
  }

  /**
   * W1: deliver one of the daemon pipeline's notices for a run only after the text the
   * daemon held when it sent it, as in process the trace is flushed before "turn done".
   * One read without waiting, then a full flush; a run this window does not follow, or
   * one whose pump already ended (and flushed), is delivered at once.
   */
  async deliverAfterRead(runId: string | undefined, deliver: () => void): Promise<void> {
    const cursor = runId === undefined ? undefined : this.#cursorFor(runId)
    if (cursor && !cursor.stopped && !this.#disposed) {
      if (this.#deps.subscribeMode) await this.#readTraceSerialized(cursor.runId)
      else {
        try { await this.step(cursor.runId, { waitMs: 0 }) } catch (error) { this.#deps.onWarn?.('daemon run read before notice failed', error) }
      }
      this.#bridge.flushAll()
    }
    deliver()
  }

  /** Whether this window already follows this run, named by either id. */
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

  /** The latest authoritative run state this window has read, per run id. */
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
        runId, lifecycle: null, watch: 0, output: 0, pushed: [], askedQuestions: new Set(), answerIds: new Map(),
        resyncRequired: false, pumping: false, stopped: false, sawText: false
      }
      this.#runs.set(runId, created)
      return created
    })()
    if (cursor.latest) return cursor.latest
    if (this.#deps.subscribeMode) {
      await this.#readTraceSerialized(cursor.runId)
      return cursor.latest ?? null
    }
    // One bounded read: the caller is answering a UI request, so it must not wait
    // for a long poll to find out whether the run is still there.
    await this.step(cursor.runId, { waitMs: 0 })
    return cursor.latest ?? null
  }

  #awaitBound(runId: string): Promise<string | undefined> {
    if (this.#deps.subscribeMode) {
      return awaitSubscribeAdmission({
        runId, cursor: () => this.#runs.get(runId), wakes: this.#wakes,
        bindBudgetMs: this.#deps.bindBudgetMs ?? DEFAULT_BIND_BUDGET_MS, admitBudgetMs: this.#deps.admitBudgetMs ?? DEFAULT_ADMIT_BUDGET_MS
      })
    }
    return awaitAdmission({
      runId, cursor: () => this.#runs.get(runId), step: (waitMs) => this.step(runId, { waitMs }), wakes: this.#wakes,
      bindBudgetMs: this.#deps.bindBudgetMs ?? DEFAULT_BIND_BUDGET_MS, admitBudgetMs: this.#deps.admitBudgetMs ?? DEFAULT_ADMIT_BUDGET_MS
    })
  }

  /** The run ids the daemon reports as live, whether or not this window started them. */
  async liveRuns(): Promise<ReadonlyArray<{ runId: string; state: string }>> {
    const live = await this.#deps.transport.liveRuns({ waitMs: 0 })
    return live.runs
  }

  /** Authoritative snapshot for a resynchronising view. */
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
    // The window names the run it shows (the canonical id); the daemon stops and
    // questions the ledger run that id was dispatched under.
    const cursor = this.#cursorFor(runId)
    await this.#deps.transport.stop(cursor?.runId ?? runId)
    if (cursor) cursor.lifecycle = 'stopping'
    return true
  }

  async answerQuestion(response: AgentQuestionResponse): Promise<boolean> {
    // The renderer answers with the id it was shown, which is the canonical run id the
    // Provider used; the daemon names pending questions by its own ledger run.
    return await answerQuestion(this.#cursorFor(response.runId), response, this.#deps.transport)
  }

  // One window at a time per run. The pump and an explicit read share the same
  // cursor, so letting them overlap would push the same items twice.
  async step(runId: string, options: { waitMs?: number } = {}): Promise<{ changed: boolean; lifecycle: string | null }> {
    const previous = this.#locks.get(runId) ?? Promise.resolve()
    const next = previous.then(() => this.#stepOnce(runId, options))
    this.#locks.set(runId, next.then(() => undefined, () => undefined))
    return next
  }

  async #stepOnce(runId: string, options: { waitMs?: number } = {}): Promise<{ changed: boolean; lifecycle: string | null }> {
    const cursor = this.#runs.get(runId)
    if (!cursor) return { changed: false, lifecycle: null }
    return await stepLegacyWatchRun({
      cursor, runId, waitMs: options.waitMs ?? this.#deps.waitMs ?? DEFAULT_WATCH_WAIT_MS,
      transport: this.#deps.transport, onSeen: (pos) => { this.#seen = Math.max(this.#seen, pos) },
      apply: (read, cur) => this.#apply(read, cur), publishQuestions: (cur) => this.#publishQuestions(cur),
      flush: () => this.#bridge.flush()
    })
  }

  async pump(runId: string): Promise<void> {
    const cursor = this.#runs.get(runId)
    if (!cursor || cursor.pumping || this.#disposed) return
    cursor.pumping = true
    try {
      while (!cursor.stopped && !this.#disposed) {
        // With the event feed live, read without waiting at the daemon and then wait
        // here for this run's own notice; the fallback bounds a notice that was lost.
        // Without it, the daemon's long poll is the wait.
        const live = this.#wakes.live
        if (live) this.#wakes.consume(runId)
        const result = await this.step(runId, live ? { waitMs: 0 } : {})
        // A lifecycle the daemon no longer reports and a settled run both end the
        // loop; the renderer re-reads the snapshot to learn the terminal state.
        if (result.lifecycle === null) break
        if (live && !cursor.stopped && !result.changed) await this.#wakes.wait(runId, this.#deps.waitMs ?? DEFAULT_WAIT_MS)
      }
    } catch (error) {
      // A revoked grant or a dead daemon is not a run outcome. Keep the reason and
      // stop pumping: continuing would burn the poll budget on a closed socket. The
      // next wakeAll (notices resume) reads the run again, unless it was released.
      this.#deps.onWarn?.('daemon run pump stopped', error)
      cursor.interrupted = !cursor.stopped
      cursor.stopped = true
    } finally {
      cursor.pumping = false
      if (cursor.stopped) this.#bridge.flushAll()
      // The run ended: its subscription gets its end after the last text, as in process.
      if (cursor.stopped && TERMINAL.has(cursor.lifecycle ?? '')) this.#deps.runTraces?.settle(cursor.scryRunId ?? runId)
      // Refused after it was handed out: the window gets the in-process failure notice.
      const refused = cursor.stopped ? lateRefusalNotice(cursor) : undefined
      if (refused) this.#deps.send('agent:error', refused)
    }
  }

  // The stamp ends when text first reaches the renderer; that is the number the user
  // waits for, and the stages before it say which hop spent the time.
  #delivered(cursor: RunCursor, event: TraceEvent): void {
    this.#bridge.push(event)
    this.#deps.runTraces?.route(event)
    if (cursor.sawText || cursor.stamp === undefined) return
    if (event.stage !== 'text' && event.stage !== 'text_delta') return
    cursor.sawText = true
    cursor.stamp.mark('firstText')
    cursor.stamp.finish()
  }

  #apply(read: Awaited<ReturnType<DaemonRunTransport['trace']>>, cursor: RunCursor): boolean {
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

  #publishQuestions(cursor: RunCursor): Promise<void> {
    return publishQuestions(cursor, this.#deps.transport, {
      send: this.#deps.send, ...(this.#deps.runTraces ? { subscription: this.#deps.runTraces } : {})
    })
  }

  /** Forget one run's cursor, e.g. after the view moved to another session. */
  release(runId: string): void {
    const cursor = this.#runs.get(runId)
    if (cursor) { cursor.stopped = true; cursor.interrupted = false }
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
