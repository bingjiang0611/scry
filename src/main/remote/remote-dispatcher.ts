import { SessionLedger, type RunLifecycle } from './session-ledger'
import { recordRunStage } from '../run-stage-timing'

// G1->G2 bridge: turns a durably-recorded remote intent into exactly one
// executor invocation and maps its outcome back to truthful ledger lifecycle
// events. This is the seam where the real host executor (RunRegistry + a
// Provider adapter) plugs in; here it is an injected interface so the invariants
// are testable without the production Electron surface.
//
// Invariants (CLAUDE.md 生命周期 / truthful state):
//   - Exactly one dispatch per intent. The durable recorded->dispatched ledger
//     transition IS the fence: markDispatched is strictly-once, so a concurrent
//     pump or a crash-replay cannot double-invoke the executor.
//   - The dispatch record is durable BEFORE the executor side effect. If the
//     process dies mid-execution the run stays 'dispatched' (ambiguous) and is
//     never silently re-run or marked settled — unknown is not success.
//   - The executor's observed outcome, not the client, drives the terminal state.

// The content channel: the assistant's REAL trace output (raw, bounded) is
// streamed here for the device to render, distinct from the opaque lifecycle
// `progress` markers on the ledger. 'truncated' is appended by the log itself,
// never by an executor, so it is not part of the sink's input union.
export interface RemoteOutputSink {
  append(runId: string, chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  flush?(runId: string): void | Promise<void>
}

export interface RemoteExecutorInput {
  runId: string
  detail?: string
  // Report an intermediate, non-terminal progress marker (opaque, non-secret).
  progress(detail?: string): void
  // Stream real output content for the device. Always defined; a no-op when no
  // output sink is configured.
  output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
}

export type RemoteExecutionOutcome = 'cancelled' | void
type TerminalRunLifecycle = Exclude<RunLifecycle, 'recorded' | 'dispatched'>

export interface RemoteExecutor {
  // Resolve on observed completion or cancellation, reject on observed failure. Must be idempotent
  // per runId in case a retry policy calls it again after an ambiguous crash.
  execute(input: RemoteExecutorInput): Promise<RemoteExecutionOutcome>
}

/**
 * B1: the durable outbox owns dispatch ordering. When provided, `pump()` claims from
 * `orch_outbox` instead of scanning every recorded intent, so attempts, leases and
 * per-session FIFO are enforced by the store rather than by in-memory bookkeeping.
 */
export interface RemoteDispatcherOutbox {
  /** Expired rows are reported with the claim so their runs can be cancelled, never dropped. */
  claim(owner: string, now: number): {
    expired: Array<{ effectId: string; runId: string | null }>
    effect?: { effectId: string; kind: string; runId: string | null; payload: string; attempts: number }
  }
  succeed(effectId: string, owner: string, now: number): boolean
  fail(effectId: string, owner: string, now: number, reason: string): boolean
  /** Policy deferral: back to pending without spending an attempt, claimable again at `now + delayMs`. */
  defer(effectId: string, owner: string, reason: string, now: number, delayMs: number): boolean
  wake?(): void
  retry(effectId: string, owner: string, now: number, reason: string): { status: string; delayMs?: number }
}

/**
 * B1/A4: effects that are not a run start (stop, answer, writeback, catalog) are executed by the
 * daemon through this hook. Returning `undefined` means this build cannot run that kind, so the
 * row is failed with a reason instead of blocking its session queue forever.
 */
export type RemoteEffectExecutor = (effect: {
  effectId: string
  kind: string
  runId: string | null
  payload: string
  attempts: number
}) => 'done' | 'retry' | 'failed'

export interface RemoteDispatcherDependencies {
  ledger: SessionLedger
  outbox?: RemoteDispatcherOutbox
  effectExecutor?: RemoteEffectExecutor
  executor: RemoteExecutor
  // Absent => the output callback is a no-op and only the lifecycle is observable.
  outputSink?: RemoteOutputSink
  /** P4-2 authoritative pre-dispatch recheck + fence commit before executor runs. */
  beforeDispatch?(
    runId: string,
    detail?: string
  ):
    | { ok: true }
    | { ok: false; action: 'fail'; reason: string; detail?: string }
    | { ok: false; action: 'requeue'; reason: string; retryAfterMs?: number }
  /** P4-2 authoritative terminal settlement hook after executor finishes. */
  onSettled?(runId: string, lifecycle: TerminalRunLifecycle, detail?: string): void
  /**
   * R5: the ledger is keyed by a v4 run id, which differs from the canonical id an outbox row carries.
   * Every ledger read/write goes through this mapping; the executor and the authority keep the
   * canonical id.
   */
  ledgerIdForRun?(runId: string): string
  /**
   * C4: a turn that continues a session after a daemon restart is told which background work the
   * previous process cancelled. The hook returns the detail to execute, or the original one.
   */
  rewriteDetail?(runId: string, detail: string | undefined): string | undefined
}

export class RemoteDispatcher {
  #ledger: SessionLedger
  #executor: RemoteExecutor
  #outputSink?: RemoteOutputSink
  #outbox?: RemoteDispatcherOutbox
  #effectExecutor?: RemoteEffectExecutor
  #leaseOwner = `dispatcher:${process.pid}`
  #beforeDispatch?: RemoteDispatcherDependencies['beforeDispatch']
  #onSettled?: RemoteDispatcherDependencies['onSettled']
  #rewriteDetail?: RemoteDispatcherDependencies['rewriteDetail']
  #ledgerIdForRun?: RemoteDispatcherDependencies['ledgerIdForRun']
  #inflight = new Set<string>()
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(deps: RemoteDispatcherDependencies) {
    this.#ledger = deps.ledger
    this.#executor = deps.executor
    this.#outputSink = deps.outputSink
    this.#outbox = deps.outbox
    this.#effectExecutor = deps.effectExecutor
    this.#beforeDispatch = deps.beforeDispatch
    this.#onSettled = deps.onSettled
    this.#rewriteDetail = deps.rewriteDetail
    this.#ledgerIdForRun = deps.ledgerIdForRun
  }

  /** The ledger's key for a canonical run id. Identity when no mapping is configured or readable. */
  #ledgerKey(runId: string): string {
    if (!this.#ledgerIdForRun) return runId
    try { return this.#ledgerIdForRun(runId) } catch { return runId }
  }

  dispose(): void {
    this.#disposed = true
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
  }

  #scheduleRetry(delayMs: number): void {
    if (this.#disposed) return
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    const timer = setTimeout(() => {
      this.#retryTimer = null
      if (!this.#disposed) this.pump()
    }, Math.max(10, delayMs))
    timer.unref?.()
    this.#retryTimer = timer
  }

  /** The ledger's own view of the run, read without mutating it. */
  #ledgerSettledOrDispatched(runId: string): boolean {
    let state: string | undefined
    try { state = this.#ledger.runState(runId) } catch { return false }
    return state === 'dispatched' || state === 'settled' || state === 'failed' || state === 'cancelled'
  }

  /** Whether the ledger holds any state for the run at all (as opposed to refusing a transition). */
  #ledgerKnows(runId: string): boolean {
    try { return this.#ledger.runState(runId) !== undefined } catch { return false }
  }

  /** Clears backoffs so a "conditions changed" pump sees rows it deferred earlier. */
  wake(): void {
    this.#outbox?.wake?.()
  }

  // Dispatch every intent still awaiting its first dispatch, exactly once.
  // Returns the runIds newly dispatched by this call. Safe to call repeatedly
  // (e.g. after each recordIntent and once at startup for crash recovery).
  pump(): string[] {
    if (this.#disposed) return []
    if (this.#outbox) return this.#pumpOutbox()
    const started: string[] = []
    let nextRetryMs: number | undefined
    for (const intent of this.#ledger.recordedIntents()) {
      if (this.#inflight.has(intent.runId)) continue
      if (this.#beforeDispatch) {
        const gate = this.#beforeDispatch(intent.runId, intent.detail)
        if (!gate.ok) {
          if (gate.action === 'fail') {
            try {
              if (gate.reason === 'pending_expired' || gate.reason === 'stop_requested') {
                this.#ledger.markCancelled(intent.runId)
              } else {
                this.#ledger.markFailed(intent.runId, gate.detail ?? gate.reason)
              }
            } catch { /* already terminal */ }
          } else if (gate.retryAfterMs !== undefined) {
            nextRetryMs = nextRetryMs === undefined ? gate.retryAfterMs : Math.min(nextRetryMs, gate.retryAfterMs)
          }
          continue
        }
      }
      // The durable transition is the fence. If another pump already advanced
      // this run, markDispatched throws and we skip without invoking anything.
      try {
        this.#ledger.markDispatched(intent.runId)
      } catch {
        continue
      }
      this.#inflight.add(intent.runId)
      started.push(intent.runId)
      this.#run(intent.runId, intent.detail)
    }
    if (nextRetryMs !== undefined) this.#scheduleRetry(nextRetryMs)
    return started
  }

  /**
   * B1: claims effects from the durable outbox. The claim itself is the exactly-once fence, so
   * this replaces the "scan every recorded intent" loop; the ledger still owns intent detail.
   */
  #pumpOutbox(): string[] {
    const started: string[] = []
    const outbox = this.#outbox!
    for (let i = 0; i < 32; i += 1) {
      const { expired, effect } = outbox.claim(this.#leaseOwner, Date.now())
      for (const row of expired) {
        if (!row.runId) continue
        // The authority records the terminal cancellation (with evidence); the ledger mirrors it.
        if (this.#beforeDispatch) this.#beforeDispatch(row.runId, undefined)
        try { this.#ledger.markCancelled(this.#ledgerKey(row.runId)) } catch { /* already terminal */ }
      }
      if (!effect) break
      if (effect.kind !== 'provider.run.start') {
        this.#runNonStartEffect(outbox, effect)
        continue
      }
      if (!effect.runId) {
        // A run-start effect without a run cannot be executed; park it instead of leaking a lease.
        outbox.fail(effect.effectId, this.#leaseOwner, Date.now(), 'run_start_without_run')
        continue
      }
      const runId = effect.runId
      if (this.#inflight.has(runId)) {
        outbox.retry(effect.effectId, this.#leaseOwner, Date.now(), 'already_inflight')
        continue
      }
      const ledgerRunId = this.#ledgerKey(runId)
      let detail: string | undefined
      try {
        detail = this.#ledger.intentDetail?.(ledgerRunId)
      } catch { detail = undefined }
      if (this.#beforeDispatch) {
        // R6: the row is already claimed here. A throwing authority used to escape pump() and leave
        // the claim `running` under a lease nothing would ever settle, so the intent vanished.
        let gate: ReturnType<NonNullable<RemoteDispatcherDependencies['beforeDispatch']>>
        try {
          gate = this.#beforeDispatch(runId, detail)
        } catch {
          // A failed admission check has made no decision. Do not spend the effect's retry budget
          // while the authority is unable to record a terminal outcome.
          const delay = 100
          outbox.defer(effect.effectId, this.#leaseOwner, 'before_dispatch_failed', Date.now(), delay)
          this.#scheduleRetry(delay)
          continue
        }
        if (!gate.ok) {
          if (gate.action === 'fail') {
            outbox.fail(effect.effectId, this.#leaseOwner, Date.now(), gate.reason)
            try {
              if (gate.reason === 'pending_expired' || gate.reason === 'stop_requested') this.#ledger.markCancelled(ledgerRunId)
              else this.#ledger.markFailed(ledgerRunId, gate.detail ?? gate.reason)
            } catch { /* already terminal */ }
            continue
          }
          // A held gate is not a failure, so it must not consume the attempt budget. The backoff
          // also keeps this row from being the head of every other session's queue.
          const retryAfterMs = gate.retryAfterMs ?? 100
          outbox.defer(effect.effectId, this.#leaseOwner, gate.reason, Date.now(), retryAfterMs)
          this.#scheduleRetry(retryAfterMs)
          continue
        }
      }
      // The durable ledger transition is the second fence. It only throws when this ledger refuses
      // the transition, so the reason decides the outcome: another dispatch already won (nothing to
      // do) versus a ledger that thinks the run is still recorded while the authority admitted it —
      // the restart case (R2). Succeeding on that second case left the run in `dispatched` forever.
      try {
        this.#ledger.markDispatched(ledgerRunId)
      } catch {
        // R5: the outbox row is committed before the submit writes the ledger intent. A ledger that
        // has never heard of this run is not a fence conflict — the submit is still landing — so the
        // row goes back to pending instead of being failed and losing the intent.
        if (!this.#ledgerKnows(ledgerRunId)) {
          const retried = outbox.retry(effect.effectId, this.#leaseOwner, Date.now(), 'ledger_intent_pending')
          this.#scheduleRetry(retried.delayMs ?? 100)
          continue
        }
        if (this.#ledgerSettledOrDispatched(ledgerRunId)) {
          outbox.succeed(effect.effectId, this.#leaseOwner, Date.now())
          continue
        }
        // The authority already wrote `admitted_and_dispatched`; make the run terminal instead of
        // leaving a dispatch nobody will execute.
        try { this.#onSettled?.(runId, 'failed', 'dispatch_fence_conflict') } catch { /* recorded below */ }
        outbox.fail(effect.effectId, this.#leaseOwner, Date.now(), 'dispatch_fence_conflict')
        continue
      }
      this.#inflight.add(runId)
      started.push(runId)
      this.#run(runId, detail, ledgerRunId)
      outbox.succeed(effect.effectId, this.#leaseOwner, Date.now())
    }
    return started
  }

  /**
   * B1: stop/answer/writeback effects never mark a run dispatched. Their outcome is the worker's,
   * and an unhandled kind fails loudly instead of retrying forever.
   */
  #runNonStartEffect(
    outbox: RemoteDispatcherOutbox,
    effect: { effectId: string; kind: string; runId: string | null; payload: string; attempts: number }
  ): void {
    const outcome = this.#effectExecutor?.(effect) ?? 'failed'
    const now = Date.now()
    if (outcome === 'done') {
      outbox.succeed(effect.effectId, this.#leaseOwner, now)
      return
    }
    if (outcome === 'retry') {
      const retried = outbox.retry(effect.effectId, this.#leaseOwner, now, 'effect_retry')
      if (retried.delayMs !== undefined) this.#scheduleRetry(retried.delayMs)
      return
    }
    outbox.fail(
      effect.effectId,
      this.#leaseOwner,
      now,
      this.#effectExecutor ? 'effect_failed' : `unhandled_effect_kind:${effect.kind}`
    )
  }

  #run(runId: string, detail?: string, ledgerRunId = runId): void {
    const progress = (mark?: string): void => {
      // Best-effort progress: never fail execution because a marker could not
      // be recorded, but never fabricate one either.
      try { this.#ledger.markProgress(ledgerRunId, mark) } catch { /* run already terminal */ }
    }
    let outputCaptureFailed = false
    const markOutputCaptureFailed = (): void => {
      if (outputCaptureFailed) return
      outputCaptureFailed = true
      try { this.#ledger.markProgress(ledgerRunId, 'output_capture_failed') } catch { /* run already terminal */ }
    }
    const output = (chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void => {
      // Output persistence must never fail the Agent, but the durable lifecycle must expose
      // the first evidence gap instead of letting consumers infer that a partial stream is complete.
      try { this.#outputSink?.append(runId, chunk) } catch { markOutputCaptureFailed() }
    }
    const flushOutput = async (): Promise<void> => {
      try { await this.#outputSink?.flush?.(runId) } catch { markOutputCaptureFailed() }
    }
    // Invoke synchronously so the dispatch is observably in flight when pump()
    // returns; a synchronous throw is mapped to failure like a rejection.
    let pending: Promise<RemoteExecutionOutcome>
    recordRunStage(runId, 'dispatch')
    // The note is consumed once, before execution, so a retry of the same turn still carries it and a
    // later turn does not.
    let effectiveDetail = detail
    if (this.#rewriteDetail) {
      try { effectiveDetail = this.#rewriteDetail(runId, detail) } catch { /* a note never blocks dispatch */ }
    }
    try {
      pending = this.#executor.execute({ runId, detail: effectiveDetail, progress, output })
    } catch (error) {
      void flushOutput().finally(() => {
        this.#settle(runId, ledgerRunId, 'failed', String((error as Error)?.message ?? error).slice(0, 4096))
      })
      return
    }
    void Promise.resolve(pending).then(
      async (outcome) => { await flushOutput(); this.#settle(runId, ledgerRunId, outcome ?? 'settled') },
      async (error) => { await flushOutput(); this.#settle(runId, ledgerRunId, 'failed', String((error as Error)?.message ?? error).slice(0, 4096)) }
    )
  }

  #settle(runId: string, ledgerRunId: string, lifecycle: TerminalRunLifecycle, detail?: string): void {
    this.#inflight.delete(runId)
    try {
      this.#onSettled?.(runId, lifecycle, detail)
    } catch { /* preserve ledger update */ }
    try {
      // The v2 Desktop watch maps the H1 cancellation event to a failed run.
      // Keep the existing settlement and status progress marker on that wire.
      if (lifecycle === 'failed') this.#ledger.markFailed(ledgerRunId, detail)
      else this.#ledger.markSettled(ledgerRunId)
    } catch { /* already terminal (e.g. cancelled by the host) */ }
  }

  // Drain to quiescence for deterministic tests/shutdown ordering.
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
