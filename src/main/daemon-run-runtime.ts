import { randomUUID } from 'node:crypto'
import { boundMarker } from './daemon-run-evidence'
import { planDelivery } from './daemon-run-delivery'
import { PerformanceTrace } from './performance-timing'
import { TraceOutputBridge } from './trace-output'
import type { AgentQuestionResponse } from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { DesktopRemoteContext, DesktopTraceCursor } from '../shared/desktop-remote'
import { DaemonRunTransport } from './daemon-run-transport'

// The App's own run view, driven by the daemon instead of by an in-process
// pipeline. The daemon owns execution, the ledger and the canonical run state;
// this module owns exactly one thing: turning its frames into the trace, question
// and lifecycle events this window already renders.
//
// It never invents progress. A delta that rewrites earlier items cannot be
// expressed as an append, so the run is marked for resynchronisation and the
// renderer re-reads the authoritative snapshot; a run whose lifecycle the daemon
// no longer knows is reported as unknown, not as finished.

export interface DaemonRunRuntimeDeps {
  transport: DaemonRunTransport
  send: (channel: string, payload: unknown) => void
  // Long-poll window. The daemon answers earlier when something changes.
  waitMs?: number
  bindBudgetMs?: number
  bridge?: TraceOutputBridge
  onWarn?: (message: string, detail?: unknown) => void
}

interface RunCursor {
  runId: string
  // Unknown until the daemon reports the bind, which is the only place it names the
  // Provider and directory of a run this window did not start.
  context?: DesktopRemoteContext
  lifecycle: string | null
  after?: DesktopTraceCursor
  // Canonical run id the daemon bound to this ledger run, once it said so.
  scryRunId?: string
  // Last ledger position this run's watch has read. The ledger answers with one page
  // at a time from a global sequence, so a watch that keeps asking from 0 only ever
  // re-reads the session's first page; this is what lets it walk forward to its own
  // evidence (and past a page boundary at all).
  watch: number
  // How much run content this watch has seen. Content is what actually moves while the
  // Provider streams; the ledger only moves at lifecycle points.
  output: number
  latest?: ActiveRun
  // The item last delivered at each index: a text block the daemon rewrites as it
  // streams is an append of that item, not a rewrite of history.
  pushed: TraceEvent[]
  askedQuestions: Set<string>
  // The daemon dedupes an answer by its own id, so one is minted per question and
  // reused when the same answer is retried.
  answerIds: Map<string, string>
  resyncRequired: boolean
  pumping: boolean
  stopped: boolean
  // Where the wait before the first token actually goes. Only recorded when perf
  // logging is on; it answers "which hop?" instead of guessing.
  stamp?: PerformanceTrace
  sawText: boolean
}

const DEFAULT_WAIT_MS = 15_000
// How long a start waits for the daemon to bind a canonical run id. A run that has
// not bound by then is still recorded; the caller gets the ledger id and `bound:
// false`, and the window resynchronises from `agent:activeRun`.
const DEFAULT_BIND_BUDGET_MS = 3_000
const BIND_WAIT_MS = 250

export interface DaemonStartInput {
  intentId: string
  detail: string
  context: DesktopRemoteContext
}

export interface DaemonStartReceipt {
  intentId: string
  runId: string
  status: 'recorded' | 'duplicate'
  /** Whether `runId` is the canonical id the trace events carry. */
  bound: boolean
}

// `bound` is the daemon's own marker, not a client guess; anything else in the
// progress detail stays opaque.
// The trace only reports `done` when a snapshot happens to be the read that carries
// it; after the first snapshot every read is a delta, so a run that stops would look
// alive forever. The ledger's terminal state is the authority on whether a daemon run
// finished, and it is what the window's stop control waits for.
function view(cursor: RunCursor): ActiveRun | null {
  if (!cursor.latest) return null
  const terminal = cursor.lifecycle === 'settled' || cursor.lifecycle === 'failed' || cursor.lifecycle === 'cancelled'
  return terminal && !cursor.latest.done ? { ...cursor.latest, done: true } : cursor.latest
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

  constructor(deps: DaemonRunRuntimeDeps) {
    this.#deps = deps
    this.#bridge = deps.bridge ?? new TraceOutputBridge({
      canSend: () => true,
      send: (payload) => this.#deps.send('agent:trace', payload),
      publishHealth: (state) => this.#deps.send('agent:traceHealth', state)
    })
  }

  /** The batching bridge, so `agent:traceAck` credits the same delivery state. */
  get bridge(): TraceOutputBridge { return this.#bridge }

  async start(input: DaemonStartInput): Promise<DaemonStartReceipt> {
    const stamp = new PerformanceTrace('daemon.run.firstText', input.context ? { provider: input.context.providerId } : {})
    const receipt = await this.#deps.transport.submit({ intentId: input.intentId, detail: input.detail })
    stamp.mark('submitted')
    // A duplicate submit is the same logical run: keep its existing cursor rather
    // than restarting the trace from zero.
    if (!this.#runs.has(receipt.runId)) {
      this.#runs.set(receipt.runId, {
        // A run's own evidence cannot predate its submit, so its watch starts at the
        // intent instead of the session's first page.
        runId: receipt.runId, context: input.context, lifecycle: 'recorded',
        watch: receipt.seq !== undefined ? Math.max(0, receipt.seq - 1) : this.#seen, output: 0,
        pushed: [], askedQuestions: new Set(), answerIds: new Map(), resyncRequired: false, pumping: false, stopped: false,
        stamp, sawText: false
      })
    }
    void this.pump(receipt.runId)
    // The window identifies a run by the canonical id its trace events carry, not
    // by the ledger id it submitted. Wait for the daemon's bind, and say so when it
    // did not arrive instead of handing back an id the trace will never match.
    const bound = await this.#awaitBound(receipt.runId)
    return { ...receipt, runId: bound ?? receipt.runId, bound: bound !== undefined }
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
    // One bounded read: the caller is answering a UI request, so it must not wait
    // for a long poll to find out whether the run is still there.
    await this.step(cursor.runId, { waitMs: 0 })
    return cursor.latest ?? null
  }

  async #awaitBound(runId: string): Promise<string | undefined> {
    const budgetMs = this.#deps.bindBudgetMs ?? DEFAULT_BIND_BUDGET_MS
    const deadline = Date.now() + budgetMs
    for (;;) {
      const cursor = this.#runs.get(runId)
      if (!cursor) return undefined
      if (cursor.scryRunId) return cursor.scryRunId
      if (cursor.stopped || Date.now() >= deadline) return undefined
      try {
        await this.step(runId, { waitMs: Math.min(BIND_WAIT_MS, Math.max(0, deadline - Date.now())) })
      } catch {
        // The intent is already recorded. A denied or broken read must not turn a
        // recorded submit into a failed start; the pump reports the reason.
        return undefined
      }
    }
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
    // The daemon names a pending question by its own id; the renderer's answer
    // carries exactly that id and never invents one.
    // The renderer answers with the id it was shown, which is the canonical run id the
    // Provider used; the daemon names pending questions by its own ledger run.
    const cursor = this.#cursorFor(response.runId)
    // The answer travels inside the request, so it speaks the same id the daemon knows:
    // its broker refuses a response naming a different run.
    const ledgerRunId = cursor?.runId ?? response.runId
    const answerId = cursor?.answerIds.get(response.questionId) ?? randomUUID()
    const answered = await this.#deps.transport.answerQuestion({
      runId: ledgerRunId, answerId, response: { ...response, runId: ledgerRunId }
    })
    cursor?.askedQuestions.delete(response.questionId)
    return answered
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
    const trace = new PerformanceTrace('daemon.run.pump', cursor.context ? { provider: cursor.context.providerId } : {})
    let changed = false
    try {
      // `output: 'wake'` is the wake, not the delivery: the daemon reports that the run
      // produced something without sending that content, and the text still arrives on
      // the trace. Without a content wake a fifteen second poll is a fifteen second
      // freeze between the first chunk and the end of the message; with the page itself
      // every chunk would cross the socket twice.
      const watch = await this.#deps.transport.watch({
        runId, cursor: cursor.watch, outputCursor: cursor.output,
        waitMs: options.waitMs ?? this.#deps.waitMs ?? DEFAULT_WAIT_MS, output: 'wake'
      })
      cursor.watch = Math.max(cursor.watch, watch.cursor)
      this.#seen = Math.max(this.#seen, watch.cursor)
      if (watch.output.count > 0) {
        cursor.output = Math.max(cursor.output, watch.output.cursor)
        changed = true
      }
      if (watch.state !== cursor.lifecycle) { cursor.lifecycle = watch.state; changed = true }
      for (const entry of watch.events) {
        if (entry.kind !== 'run_progress' || entry.detail === undefined) continue
        const bound = boundMarker(entry.detail)
        if (!bound) continue
        // The watch is per context, so it also replays how other runs in this workspace
        // were bound. A marker decides the binding of the run it names, or the window
        // ends up showing, answering and stopping a run it never started.
        if (bound.ledgerRunId !== undefined && bound.ledgerRunId !== cursor.runId) continue
        if (cursor.scryRunId === undefined) {
          cursor.scryRunId = bound.scryRunId
          cursor.stamp?.mark('bound')
        }
        // A run this window adopted has no context of its own; the daemon states it
        // once, and only then can the trace be addressed.
        if (cursor.context === undefined && bound.cwd !== undefined && bound.providerId !== undefined) {
          cursor.context = {
            cwd: bound.cwd, providerId: bound.providerId,
            ...(bound.agentProfileId ? { agentProfileId: bound.agentProfileId } : {})
          }
        }
      }
      if (cursor.context === undefined) return { changed, lifecycle: cursor.lifecycle }
      // The trace is addressed by the canonical id its events carry. The ledger id the
      // watch polls uses is a different id and finds no run there.
      const read = await this.#deps.transport.trace({
        context: cursor.context, runId: cursor.scryRunId ?? runId, ...(cursor.after ? { after: cursor.after } : {})
      })
      if (cursor.stamp && cursor.latest === undefined && read.kind === 'snapshot' && read.run) cursor.stamp.mark('firstTrace')
      if (this.#apply(read, cursor)) changed = true
      await this.#publishQuestions(cursor)
      if (watch.state === 'settled' || watch.state === 'failed' || watch.state === 'cancelled') cursor.stopped = true
      return { changed, lifecycle: cursor.lifecycle }
    } finally {
      trace.finish({ bufferedEvents: changed ? 1 : 0 })
    }
  }

  async pump(runId: string): Promise<void> {
    const cursor = this.#runs.get(runId)
    if (!cursor || cursor.pumping || this.#disposed) return
    cursor.pumping = true
    try {
      while (!cursor.stopped && !this.#disposed) {
        const result = await this.step(runId)
        // A lifecycle the daemon no longer reports and a settled run both end the
        // loop; the renderer re-reads the snapshot to learn the terminal state.
        if (result.lifecycle === null) break
        if (!cursor.stopped && !result.changed) continue
      }
    } catch (error) {
      // A revoked grant or a dead daemon is not a run outcome. Keep the reason and
      // stop pumping: continuing would burn the poll budget on a closed socket.
      this.#deps.onWarn?.('daemon run pump stopped', error)
      cursor.stopped = true
    } finally {
      cursor.pumping = false
      if (cursor.stopped) this.#bridge.flushAll()
    }
  }

  // The stamp ends when text first reaches the renderer; that is the number the user
  // waits for, and the stages before it say which hop spent the time.
  #delivered(cursor: RunCursor, event: TraceEvent): void {
    this.#bridge.push(event)
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

  async #publishQuestions(cursor: RunCursor): Promise<void> {
    const pending = await this.#deps.transport.questions(cursor.runId)
    for (const request of pending) {
      if (cursor.askedQuestions.has(request.questionId)) continue
      cursor.askedQuestions.add(request.questionId)
      if (!cursor.answerIds.has(request.questionId)) cursor.answerIds.set(request.questionId, randomUUID())
      // The channel the preload subscribes to (`onQuestion` = agent:userQuestion); a
      // question sent on a name nobody listens for leaves the run waiting forever.
      this.#deps.send('agent:userQuestion', request)
    }
    for (const asked of [...cursor.askedQuestions]) {
      if (pending.some((request) => request.questionId === asked)) continue
      cursor.askedQuestions.delete(asked)
      cursor.answerIds.delete(asked)
      this.#deps.send('agent:userQuestionClosed', { runId: cursor.runId, questionId: asked })
    }
  }

  /** Forget one run's cursor, e.g. after the view moved to another session. */
  release(runId: string): void {
    const cursor = this.#runs.get(runId)
    if (cursor) cursor.stopped = true
  }

  dispose(): void {
    this.#disposed = true
    for (const cursor of this.#runs.values()) cursor.stopped = true
    this.#bridge.close()
  }
}

export function traceEventItemCount(run: ActiveRun | null): number {
  return run ? run.items.length : 0
}

export type { TraceEvent }
