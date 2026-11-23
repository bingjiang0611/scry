import { SessionLedger, type RunLifecycle } from './session-ledger'
import { recordRunStage } from '../run-stage-timing'

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

export interface RemoteDispatcherDependencies {
  ledger: SessionLedger
  executor: RemoteExecutor
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
}

export class RemoteDispatcher {
  #ledger: SessionLedger
  #executor: RemoteExecutor
  #outputSink?: RemoteOutputSink
  #beforeDispatch?: RemoteDispatcherDependencies['beforeDispatch']
  #onSettled?: RemoteDispatcherDependencies['onSettled']
  #inflight = new Set<string>()
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(deps: RemoteDispatcherDependencies) {
    this.#ledger = deps.ledger
    this.#executor = deps.executor
    this.#outputSink = deps.outputSink
    this.#beforeDispatch = deps.beforeDispatch
    this.#onSettled = deps.onSettled
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

  // Dispatch every intent still awaiting its first dispatch, exactly once.
  // Returns the runIds newly dispatched by this call. Safe to call repeatedly
  // (e.g. after each recordIntent and once at startup for crash recovery).
  pump(): string[] {
    if (this.#disposed) return []
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

  #run(runId: string, detail?: string): void {
    const progress = (mark?: string): void => {
      // Best-effort progress: never fail execution because a marker could not
      // be recorded, but never fabricate one either.
      try { this.#ledger.markProgress(runId, mark) } catch { /* run already terminal */ }
    }
    let outputCaptureFailed = false
    const markOutputCaptureFailed = (): void => {
      if (outputCaptureFailed) return
      outputCaptureFailed = true
      try { this.#ledger.markProgress(runId, 'output_capture_failed') } catch { /* run already terminal */ }
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
    try {
      pending = this.#executor.execute({ runId, detail, progress, output })
    } catch (error) {
      void flushOutput().finally(() => {
        this.#settle(runId, 'failed', String((error as Error)?.message ?? error).slice(0, 4096))
      })
      return
    }
    void Promise.resolve(pending).then(
      async (outcome) => { await flushOutput(); this.#settle(runId, outcome ?? 'settled') },
      async (error) => { await flushOutput(); this.#settle(runId, 'failed', String((error as Error)?.message ?? error).slice(0, 4096)) }
    )
  }

  #settle(runId: string, lifecycle: TerminalRunLifecycle, detail?: string): void {
    this.#inflight.delete(runId)
    try {
      this.#onSettled?.(runId, lifecycle, detail)
    } catch { /* preserve ledger update */ }
    try {
      // The v2 Desktop watch maps the H1 cancellation event to a failed run.
      // Keep the existing settlement and status progress marker on that wire.
      if (lifecycle === 'failed') this.#ledger.markFailed(runId, detail)
      else this.#ledger.markSettled(runId)
    } catch { /* already terminal (e.g. cancelled by the host) */ }
  }

  // Drain to quiescence for deterministic tests/shutdown ordering.
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
