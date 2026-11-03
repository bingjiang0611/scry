import type { AgentQuestionRequest } from '../../shared/runtime'
import type { RemoteHistoryQuery, RemoteHistoryVersion } from './remote-gateway'
import { createHash } from 'node:crypto'
import type { RunLifecycle, SessionLedger } from './session-ledger'
import type { RemoteGateway } from './remote-gateway'
import type { RemoteInteractionBroker } from './remote-interaction-broker'
import type { RunOutputPage } from './run-output-log'
import { MAC_RUN_ID } from './host-controller-routing'
import type { RemoteIntentRouting, MacRunSource, LiveRunRef } from './host-controller-types'

// Long polls over one run and over every live run: the device waits here instead
// of ticking. Every pass re-runs the authorized readers, so a revoked grant fails
// the next wake-up rather than being remembered for the whole wait.
const LIVE_RUNS_MAX_WAIT_MS = 20_000
// Mac runs are in-memory state without a change signal into this controller;
// a long-poll re-checks them on this bounded tick. The re-check is one in-memory
// snapshot and a hash, so the tick is short enough that a Mac-side change reaches
// the device in well under a second.
const LIVE_RUNS_TICK_MS = 250
const LIVE_RUN_PROMPT_CHARS = 200
// Below the inner host's 30-second idle timer and the device's response deadline.
const WATCH_MAX_WAIT_MS = 20_000

export interface LiveWatcherDeps {
  authorizeDevice(peer: string): void
  authorizedCwd(cwd: string): string | undefined
  ledger: SessionLedger
  gateway: RemoteGateway
  interactions: RemoteInteractionBroker
  stops: Map<string, AbortController>
  live: Map<string, { routing: RemoteIntentRouting; externalSessionId?: string }>
  macRuns?: MacRunSource
  // The controller's own readers, so a substituted read (tests, or a narrower
  // host) is what the long poll actually uses.
  poll(peer: string, input: { cursor: number }): ReturnType<SessionLedger['since']>
  pendingQuestions(peer: string, input: { runId: string }): AgentQuestionRequest[]
  runOutput(peer: string, input: { runId: string; cursor: number }): Promise<RunOutputPage>
}

export interface WatchInput { runId: string; cursor: number; outputCursor: number; waitMs: number }
// Ledger evidence, pending questions and lifecycle. No shadow output: a device
// that reads content from canonical traces never depends on the output spool.
export interface WatchLifecycle {
  poll: ReturnType<SessionLedger['since']>
  questions: AgentQuestionRequest[]
  state: RunLifecycle | null
}
export interface WatchResult extends WatchLifecycle { output: RunOutputPage }

export class LiveWatchers {
  readonly #deps: LiveWatcherDeps
  // Wake-up signal. Ledger events and output appends bump it; a watcher always
  // re-reads through the normal authorized readers.
  #seq = 0
  #waiters = new Set<() => void>()

  constructor(deps: LiveWatcherDeps) { this.#deps = deps }

  async watchRun(peerCertSHA256: string, input: WatchInput): Promise<WatchResult> {
    return await this.#watch(peerCertSHA256, input, true) as WatchResult
  }

  async watchLifecycle(peerCertSHA256: string, input: WatchInput): Promise<WatchLifecycle> {
    return await this.#watch(peerCertSHA256, input, false)
  }

  // One long poll, read output only when the caller wants it. Its overflow or
  // I/O failure must not block authoritative lifecycle, so content reads stay
  // separate (the device uses canonical trace reads).
  async #watch(peerCertSHA256: string, input: WatchInput, includeOutput: boolean): Promise<WatchResult | WatchLifecycle> {
    const waitMs = Math.min(Math.max(0, input.waitMs), WATCH_MAX_WAIT_MS)
    const deadline = Date.now() + waitMs
    while (true) {
      const seen = this.#seq
      const output = includeOutput ? await this.#deps.runOutput(peerCertSHA256, { runId: input.runId, cursor: input.outputCursor }) : undefined
      // Read lifecycle and its ledger evidence together after the async output
      // read. Otherwise a newly terminal state can omit its failure/result event.
      const poll = this.#deps.poll(peerCertSHA256, { cursor: input.cursor })
      const questions = this.#deps.pendingQuestions(peerCertSHA256, { runId: input.runId })
      const state = this.#deps.ledger.runState(input.runId) ?? null
      const terminal = state === 'settled' || state === 'failed' || state === 'cancelled'
      const remaining = deadline - Date.now()
      if (poll.events.length > 0 || poll.reset || (output?.chunks.length ?? 0) > 0 || terminal || remaining <= 0) {
        return { poll, questions, ...(output ? { output } : {}), state }
      }
      if (seen === this.#seq) await this.#waitForChange(remaining)
    }
  }

  async liveRuns(peerCertSHA256: string, input: { revision?: string; waitMs: number; history?: { query: RemoteHistoryQuery; known?: string } }): Promise<{ revision: string; runs: LiveRunRef[]; historyVersion?: RemoteHistoryVersion }> {
    const deadline = Date.now() + Math.min(Math.max(0, input.waitMs), LIVE_RUNS_MAX_WAIT_MS)
    while (true) {
      this.#deps.authorizeDevice(peerCertSHA256)
      const runs = this.#listLiveRuns()
      const revision = createHash('sha256').update(JSON.stringify(runs)).digest('hex').slice(0, 32)
      const historyVersion = input.history ? await this.#deps.gateway.readHistoryVersion(peerCertSHA256, input.history.query) : undefined
      const remaining = deadline - Date.now()
      if (revision !== input.revision || (historyVersion && historyVersion.version !== input.history?.known) || remaining <= 0) {
        return { revision, runs, ...(historyVersion ? { historyVersion } : {}) }
      }
      await this.#waitForChange(Math.min(remaining, LIVE_RUNS_TICK_MS))
    }
}

  #listLiveRuns(): LiveRunRef[] {
    const runs: LiveRunRef[] = []
    for (const [runId, live] of this.#deps.live) {
      const cwd = this.#deps.authorizedCwd(live.routing.cwd)
      if (!cwd) continue
      const questions = this.#deps.interactions.list(runId)
      runs.push({
        origin: 'remote', runId, providerId: live.routing.providerId,
        ...(live.routing.agentProfileId ? { agentProfileId: live.routing.agentProfileId } : {}),
        cwd,
        ...(live.externalSessionId ? { externalSessionId: live.externalSessionId } : {}),
        prompt: (live.routing.prompt ?? '').slice(0, LIVE_RUN_PROMPT_CHARS),
        state: this.#deps.stops.get(runId)?.signal.aborted ? 'stopping' : questions.length > 0 ? 'waiting' : 'running',
        questions
      })
    }
    for (const run of this.#deps.macRuns?.list() ?? []) {
      const cwd = this.#deps.authorizedCwd(run.cwd)
      if (!cwd || !MAC_RUN_ID.test(run.runId)) continue
      runs.push({
        origin: 'mac', runId: run.runId, providerId: run.providerId,
        ...(run.agentProfileId ? { agentProfileId: run.agentProfileId } : {}),
        cwd,
        ...(run.externalSessionId ? { externalSessionId: run.externalSessionId } : {}),
        prompt: run.prompt.slice(0, LIVE_RUN_PROMPT_CHARS),
        state: run.stopping ? 'stopping' : run.questions.length > 0 ? 'waiting' : 'running',
        questions: run.questions
      })
    }
    return runs.sort((a, b) => a.runId.localeCompare(b.runId))
  }

  notify(): void {
    this.#seq++
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const wake of waiters) wake()
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => { clearTimeout(timer); this.#waiters.delete(wake); resolve() }
      const timer = setTimeout(wake, timeoutMs)
      this.#waiters.add(wake)
    })
  }
}
