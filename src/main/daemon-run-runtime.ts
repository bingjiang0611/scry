import { randomUUID } from 'node:crypto'
import { MAC_RUN_ID } from './remote/desktop-client-validation'
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
function boundMarker(detail: string): { ledgerRunId?: string; scryRunId: string; cwd?: string; providerId?: string; agentProfileId?: string } | undefined {
  try {
    const marker = JSON.parse(detail) as Record<string, unknown>
    if (marker.event !== 'bound' || typeof marker.scryRunId !== 'string') return undefined
    // The daemon's canonical id for a run it dispatches itself (a device's, or the
    // App's) is `remote-run-...`; a locally started one is `run-...`. Both are the
    // same shape the device client accepts, so that pattern decides here too.
    if (!MAC_RUN_ID.test(marker.scryRunId)) return undefined
    return {
      ...(typeof marker.ledgerRunId === 'string' && marker.ledgerRunId.length > 0 ? { ledgerRunId: marker.ledgerRunId } : {}),
      scryRunId: marker.scryRunId,
      ...(typeof marker.cwd === 'string' && marker.cwd.length > 0 ? { cwd: marker.cwd } : {}),
      ...(typeof marker.providerId === 'string' && marker.providerId.length > 0 ? { providerId: marker.providerId } : {}),
      ...(typeof marker.agentProfileId === 'string' && marker.agentProfileId.length > 0 ? { agentProfileId: marker.agentProfileId } : {})
    }
  } catch { return undefined }
}

/**
 * The text a run-view item appended since the copy that was delivered, when the item is
 * the same event and the new text only extends it. `undefined` means "not an append":
 * a different event, a shorter text, or a stage that does not grow.
 */
function appendedText(previous: TraceEvent | undefined, next: TraceEvent): { text: string; at: number } | undefined {
  if (!previous || previous.id !== next.id) return undefined
  if (previous.stage !== 'text_delta' && previous.stage !== 'text') return undefined
  const before = previous.text ?? ''
  const after = next.text ?? ''
  if (after.length <= before.length || !after.startsWith(before)) return undefined
  return { text: after.slice(before.length), at: after.length }
}

export class DaemonRunRuntime {
  readonly #deps: DaemonRunRuntimeDeps
  readonly #runs = new Map<string, RunCursor>()
  readonly #locks = new Map<string, Promise<void>>()
  readonly #bridge: TraceOutputBridge
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
    const receipt = await this.#deps.transport.submit({ intentId: input.intentId, detail: input.detail })
    // A duplicate submit is the same logical run: keep its existing cursor rather
    // than restarting the trace from zero.
    if (!this.#runs.has(receipt.runId)) {
      this.#runs.set(receipt.runId, {
        runId: receipt.runId, context: input.context, lifecycle: 'recorded', watch: 0,
        pushed: [], askedQuestions: new Set(), answerIds: new Map(), resyncRequired: false, pumping: false, stopped: false
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
  runView(runId: string): ActiveRun | null { return this.#cursorFor(runId)?.latest ?? null }

  #cursorFor(runId: string): RunCursor | undefined {
    for (const cursor of this.#runs.values()) {
      if (cursor.runId === runId || cursor.scryRunId === runId || cursor.latest?.runId === runId) return cursor
    }
    return undefined
  }

  /** The latest authoritative run state this window has read, per run id. */
  activeRuns(): ActiveRun[] {
    return [...this.#runs.values()].flatMap((cursor) => cursor.latest && !cursor.latest.done ? [cursor.latest] : [])
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
        runId, lifecycle: null, watch: 0, pushed: [], askedQuestions: new Set(), answerIds: new Map(),
        resyncRequired: false, pumping: false, stopped: false
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
      const watch = await this.#deps.transport.watch({
        runId, cursor: cursor.watch, outputCursor: 0,
        waitMs: options.waitMs ?? this.#deps.waitMs ?? DEFAULT_WAIT_MS, output: false
      })
      cursor.watch = Math.max(cursor.watch, watch.cursor)
      if (watch.state !== cursor.lifecycle) { cursor.lifecycle = watch.state; changed = true }
      for (const entry of watch.events) {
        if (entry.kind !== 'run_progress' || entry.detail === undefined) continue
        const bound = boundMarker(entry.detail)
        if (!bound) continue
        // The watch is per context, so it also replays how other runs in this workspace
        // were bound. A marker decides the binding of the run it names, or the window
        // ends up showing, answering and stopping a run it never started.
        if (bound.ledgerRunId !== undefined && bound.ledgerRunId !== cursor.runId) continue
        if (cursor.scryRunId === undefined) cursor.scryRunId = bound.scryRunId
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

  #apply(read: Awaited<ReturnType<DaemonRunTransport['trace']>>, cursor: RunCursor): boolean {
    if (read.kind === 'snapshot') {
      cursor.after = read.cursor
      if (read.run) cursor.latest = read.run
      const items = read.run?.items ?? []
      // The first snapshot of a run this window just started is the whole history:
      // deliver it, then only the appended tail from then on.
      const fresh = items.slice(cursor.pushed.length)
      for (const event of fresh) this.#bridge.push(event)
      cursor.pushed = [...items]
      return fresh.length > 0
    }
    // A delta only appends when every change lands at or after what the renderer
    // already holds. Anything else rewrites history and must not be replayed as an
    // append: mark the run for resynchronisation instead.
    let changed = false
    for (const change of [...read.changes].sort((a, b) => a.index - b.index)) {
      const tail = appendedText(cursor.pushed[change.index], change.item)
      if (tail !== undefined) {
        // Same event, longer text: the renderer appends the tail to the block it holds.
        this.#bridge.push({ ...change.item, id: `${change.item.id}#${tail.at}`, stage: 'text_delta', text: tail.text })
        cursor.pushed[change.index] = change.item
        changed = true
        continue
      }
      if (change.index < cursor.pushed.length) {
        // A different event at an index the renderer already has: its copy is stale.
        cursor.resyncRequired = true
        continue
      }
      this.#bridge.push(change.item)
      cursor.pushed[change.index] = change.item
      changed = true
    }
    cursor.after = read.cursor
    if (cursor.resyncRequired) this.#deps.send('agent:traceHealth', this.#bridge.snapshot())
    return changed
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
