import { SessionLedger } from './session-ledger'

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
//   - The executor's observed outcome, not the client, drives settled/failed.

// The content channel: the assistant's REAL trace output (masked, bounded) is
// streamed here for the device to render, distinct from the opaque lifecycle
// `progress` markers on the ledger. 'truncated' is appended by the log itself,
// never by an executor, so it is not part of the sink's input union.
export interface RemoteOutputSink {
  append(runId: string, chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  flush?(runId: string): void
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

export interface RemoteExecutor {
  // Resolve on observed success, reject on observed failure. Must be idempotent
  // per runId in case a retry policy calls it again after an ambiguous crash.
  execute(input: RemoteExecutorInput): Promise<void>
}

export interface RemoteDispatcherDependencies {
  ledger: SessionLedger
  executor: RemoteExecutor
  // Absent => the output callback is a no-op and only the lifecycle is observable.
  outputSink?: RemoteOutputSink
}

export class RemoteDispatcher {
  #ledger: SessionLedger
  #executor: RemoteExecutor
  #outputSink?: RemoteOutputSink
  #inflight = new Set<string>()

  constructor(deps: RemoteDispatcherDependencies) {
    this.#ledger = deps.ledger
    this.#executor = deps.executor
    this.#outputSink = deps.outputSink
  }

  // Dispatch every intent still awaiting its first dispatch, exactly once.
  // Returns the runIds newly dispatched by this call. Safe to call repeatedly
  // (e.g. after each recordIntent and once at startup for crash recovery).
  pump(): string[] {
    const started: string[] = []
    for (const intent of this.#ledger.recordedIntents()) {
      if (this.#inflight.has(intent.runId)) continue
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
    const flushOutput = (): void => {
      try { this.#outputSink?.flush?.(runId) } catch { markOutputCaptureFailed() }
    }
    // Invoke synchronously so the dispatch is observably in flight when pump()
    // returns; a synchronous throw is mapped to failure like a rejection.
    let pending: Promise<void>
    try {
      pending = this.#executor.execute({ runId, detail, progress, output })
    } catch (error) {
      flushOutput()
      this.#settle(runId, false, String((error as Error)?.message ?? error).slice(0, 4096))
      return
    }
    void Promise.resolve(pending).then(
      () => { flushOutput(); this.#settle(runId, true) },
      (error) => { flushOutput(); this.#settle(runId, false, String((error as Error)?.message ?? error).slice(0, 4096)) }
    )
  }

  #settle(runId: string, ok: boolean, detail?: string): void {
    this.#inflight.delete(runId)
    try {
      if (ok) this.#ledger.markSettled(runId)
      else this.#ledger.markFailed(runId, detail)
    } catch { /* already terminal (e.g. cancelled by the host) */ }
  }

  // Drain to quiescence for deterministic tests/shutdown ordering.
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
