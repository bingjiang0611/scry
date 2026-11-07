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
  context: DesktopRemoteContext
  lifecycle: string | null
  after?: DesktopTraceCursor
  // Canonical run id the daemon bound to this ledger run, once it said so.
  scryRunId?: string
  latest?: ActiveRun
  pushedItems: number
  askedQuestions: Set<string>
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
function boundRunId(detail: string): string | undefined {
  try {
    const marker = JSON.parse(detail) as { event?: unknown; scryRunId?: unknown }
    if (marker.event !== 'bound' || typeof marker.scryRunId !== 'string') return undefined
    return /^run-[0-9a-z]{1,16}-[0-9]{1,12}$/.test(marker.scryRunId) ? marker.scryRunId : undefined
  } catch { return undefined }
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
        runId: receipt.runId, context: input.context, lifecycle: 'recorded',
        pushedItems: 0, askedQuestions: new Set(), resyncRequired: false, pumping: false, stopped: false
      })
    }
    void this.pump(receipt.runId)
    // The window identifies a run by the canonical id its trace events carry, not
    // by the ledger id it submitted. Wait for the daemon's bind, and say so when it
    // did not arrive instead of handing back an id the trace will never match.
    const bound = await this.#awaitBound(receipt.runId)
    return { ...receipt, runId: bound ?? receipt.runId, bound: bound !== undefined }
  }

  /** The latest authoritative run state this window has read, per run id. */
  activeRuns(): ActiveRun[] {
    return [...this.#runs.values()].flatMap((cursor) => cursor.latest && !cursor.latest.done ? [cursor.latest] : [])
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
      cursor.pushedItems = run?.items.length ?? 0
      cursor.resyncRequired = false
    }
    return run
  }

  async stop(runId: string): Promise<boolean> {
    await this.#deps.transport.stop(runId)
    const cursor = this.#runs.get(runId)
    if (cursor) cursor.lifecycle = 'stopping'
    return true
  }

  async answerQuestion(response: AgentQuestionResponse): Promise<boolean> {
    // The daemon names a pending question by its own id; the renderer's answer
    // carries exactly that id and never invents one.
    const answered = await this.#deps.transport.answerQuestion({ runId: response.runId, answerId: response.questionId, response })
    const cursor = this.#runs.get(response.runId)
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
    const trace = new PerformanceTrace('daemon.run.pump', { provider: cursor.context.providerId })
    let changed = false
    try {
      const watch = await this.#deps.transport.watch({
        runId, cursor: 0, outputCursor: 0,
        waitMs: options.waitMs ?? this.#deps.waitMs ?? DEFAULT_WAIT_MS, output: false
      })
      if (watch.state !== cursor.lifecycle) { cursor.lifecycle = watch.state; changed = true }
      for (const entry of watch.events) {
        if (entry.kind !== 'run_progress' || entry.detail === undefined) continue
        const bound = boundRunId(entry.detail)
        if (bound !== undefined && cursor.scryRunId === undefined) cursor.scryRunId = bound
      }
      const read = await this.#deps.transport.trace({ context: cursor.context, runId, ...(cursor.after ? { after: cursor.after } : {}) })
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
      const fresh = items.slice(cursor.pushedItems)
      cursor.pushedItems = items.length
      for (const event of fresh) this.#bridge.push(event)
      return fresh.length > 0
    }
    // A delta only appends when every change lands at or after what the renderer
    // already holds. Anything else rewrites history and must not be replayed as an
    // append: mark the run for resynchronisation instead.
    const appended = read.changes.filter((change) => change.index >= cursor.pushedItems)
    if (appended.length !== read.changes.length) cursor.resyncRequired = true
    for (const change of appended.sort((a, b) => a.index - b.index)) this.#bridge.push(change.item)
    cursor.after = read.cursor
    cursor.pushedItems = Math.max(cursor.pushedItems, read.cursor.count)
    if (cursor.resyncRequired) this.#deps.send('agent:traceHealth', this.#bridge.snapshot())
    return appended.length > 0
  }

  async #publishQuestions(cursor: RunCursor): Promise<void> {
    const pending = await this.#deps.transport.questions(cursor.runId)
    for (const request of pending) {
      if (cursor.askedQuestions.has(request.questionId)) continue
      cursor.askedQuestions.add(request.questionId)
      this.#deps.send('agent:question', request)
    }
    for (const asked of [...cursor.askedQuestions]) {
      if (pending.some((request) => request.questionId === asked)) continue
      cursor.askedQuestions.delete(asked)
      this.#deps.send('agent:questionClosed', { runId: cursor.runId, questionId: asked })
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
