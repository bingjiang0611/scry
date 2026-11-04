import { createHash } from 'node:crypto'
import type { AgentQuestionRequest } from '../../shared/runtime'
import type { SessionLedger, RunLifecycle } from './session-ledger'
import type { RemoteSessionRef, RemoteSessionPage, RemoteSessionPageQuery, RemoteHistoryTurn, RemoteHistoryQuery, RemoteHistoryPage, RemoteHistoryPageQuery, RemoteHistoryPreview, RemoteHistoryVersion, RemoteHistoryTurnsPage, RemoteHistoryTurnsPageQuery } from './remote-gateway'
import type { RunOutputPage } from './run-output-log'
import { RemoteRunDenied } from './remote-run-policy'
import type { DesktopAttachmentReference } from './desktop-attachments'
import type { RemoteIntentAttachment, RemoteIntentRouting, MacRunView, LiveRunRef } from './host-controller-contracts'
import { RemoteInteractionError } from './remote-interaction-broker'
import { HostControllerOperations } from './host-controller-operations'
import { WATCH_MAX_WAIT_MS, MAC_RUN_ID, REMOTE_RUN_ID } from './host-controller'
import { LIVE_RUNS_MAX_WAIT_MS, LIVE_RUNS_TICK_MS, LIVE_RUN_PROMPT_CHARS } from './host-controller-contracts'

export class HostController extends HostControllerOperations {

  // Device-facing: the host session catalog this device may browse, authorized
  // by the same verified peer certificate as every method.
  listSessions(peerCertSHA256: string): RemoteSessionRef[] {
    return this.gateway.listSessions(peerCertSHA256)
  }

  listSessionsPage(peerCertSHA256: string, input: RemoteSessionPageQuery): RemoteSessionPage {
    return this.gateway.listSessionsPage(peerCertSHA256, input)
  }

  // Device-facing: one session's real conversation content, authorized by the
  // same verified peer certificate. Async (reads the trace archive/transcript).
  readWorkspace(peerCertSHA256: string, query: unknown) {
    return this.gateway.readWorkspace(peerCertSHA256, query)
  }

  readFileDownload(peerCertSHA256: string, query: unknown) {
    return this.gateway.readFileDownload(peerCertSHA256, query)
  }

  closeReadResources(): void {
    this.fileDownloads.dispose()
  }

  readHistoryPreview(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryPreview> {
    return this.gateway.readHistoryPreview(peerCertSHA256, query)
  }

  readHistoryVersion(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryVersion> {
    return this.gateway.readHistoryVersion(peerCertSHA256, query)
  }

  readHistory(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]> {
    return this.gateway.readHistory(peerCertSHA256, query)
  }

  readHistoryPage(peerCertSHA256: string, query: RemoteHistoryPageQuery): Promise<RemoteHistoryPage> {
    return this.gateway.readHistoryPage(peerCertSHA256, query)
  }

  readHistoryTurnsPage(peerCertSHA256: string, query: RemoteHistoryTurnsPageQuery): Promise<RemoteHistoryTurnsPage> {
    return this.gateway.readHistoryTurnsPage(peerCertSHA256, query)
  }

  // Device-facing: the assistant's real streamed output CONTENT for one run,
  // strictly after the caller's cursor, authorized by the verified peer cert.
  runOutput(peerCertSHA256: string, input: { runId: string; cursor: number }): Promise<RunOutputPage> {
    return this.gateway.pollOutput(peerCertSHA256, input)
  }

  // Device-facing: ask the Provider running this remote intent to stop. This is
  // a request, not a lifecycle: the ledger records `stop_requested` and the run
  // settles only when the Provider adapter reports its real result.
  stopRun(peerCertSHA256: string, input: { runId: string }): { status: 'requested' | 'already_requested' | 'not_running' } {
    this.authorizeDevice(peerCertSHA256)
    if (!this.isRemoteRun(input.runId)) {
      const run = this.macRun(input.runId)
      if (run.stopping) return { status: 'already_requested' }
      return { status: this.macRuns!.stop(input.runId) ? 'requested' : 'not_running' }
    }
    const stop = this.stops.get(input.runId)
    if (!stop) return { status: 'not_running' }
    if (stop.signal.aborted) return { status: 'already_requested' }
    this.ledger.markProgress(input.runId, JSON.stringify({ event: 'stop_requested' }))
    stop.abort()
    return { status: 'requested' }
  }

  // Device-facing long-poll: one authorized read of ledger events, pending
  // questions, output and lifecycle for a run. It returns as soon as anything
  // new exists (or the run is terminal), otherwise after at most WATCH_MAX_WAIT_MS.
  // Every loop re-runs the same authorized readers, so a revoked grant fails the
  // next wake-up instead of being remembered for the whole wait.
  async watchRun(peerCertSHA256: string, input: { runId: string; cursor: number; outputCursor: number; waitMs: number }): Promise<{
    poll: ReturnType<SessionLedger['since']>
    questions: AgentQuestionRequest[]
    output: RunOutputPage
    state: RunLifecycle | null
  }> {
    const waitMs = Math.min(Math.max(0, input.waitMs), WATCH_MAX_WAIT_MS)
    const deadline = Date.now() + waitMs
    while (true) {
      const seen = this.changeSeq
      const output = await this.runOutput(peerCertSHA256, { runId: input.runId, cursor: input.outputCursor })
      // Read lifecycle and its ledger evidence together after the async output
      // read. Otherwise a newly terminal state can omit its failure/result event.
      const poll = this.poll(peerCertSHA256, { cursor: input.cursor })
      const questions = this.pendingQuestions(peerCertSHA256, { runId: input.runId })
      const state = this.ledger.runState(input.runId) ?? null
      const terminal = state === 'settled' || state === 'failed' || state === 'cancelled'
      const remaining = deadline - Date.now()
      if (poll.events.length > 0 || poll.reset || output.chunks.length > 0 || terminal || remaining <= 0) {
        return { poll, questions, output, state }
      }
      if (seen === this.changeSeq) await this.waitForChange(remaining)
    }
  }

  // Device-facing long-poll over every live run the device may see, optionally
  // joined with one opened session's history version. Returns when either
  // differs from what the device holds, or after at most LIVE_RUNS_MAX_WAIT_MS.
  // Authorization and workspace containment are re-checked on every pass; Mac
  // runs and transcripts have no change signal here, so passes also tick.
  async liveRuns(peerCertSHA256: string, input: {
    revision?: string
    waitMs: number
    history?: { query: RemoteHistoryQuery; known?: string }
  }): Promise<{ revision: string; runs: LiveRunRef[]; historyVersion?: RemoteHistoryVersion }> {
    const deadline = Date.now() + Math.min(Math.max(0, input.waitMs), LIVE_RUNS_MAX_WAIT_MS)
    while (true) {
      this.authorizeDevice(peerCertSHA256)
      const runs = this.listLiveRuns()
      const revision = createHash('sha256').update(JSON.stringify(runs)).digest('hex').slice(0, 32)
      const historyVersion = input.history ? await this.gateway.readHistoryVersion(peerCertSHA256, input.history.query) : undefined
      const remaining = deadline - Date.now()
      if (revision !== input.revision || (historyVersion && historyVersion.version !== input.history?.known) || remaining <= 0) {
        return { revision, runs, ...(historyVersion ? { historyVersion } : {}) }
      }
      await this.waitForChange(Math.min(remaining, LIVE_RUNS_TICK_MS))
    }
  }

  listLiveRuns(): LiveRunRef[] {
    const runs: LiveRunRef[] = []
    for (const [runId, live] of this.live) {
      const cwd = this.authorizedCwd(live.routing.cwd)
      if (!cwd) continue
      const questions = this.interactions.list(runId)
      runs.push({
        origin: 'remote', runId, providerId: live.routing.providerId,
        ...(live.routing.agentProfileId ? { agentProfileId: live.routing.agentProfileId } : {}),
        cwd,
        ...(live.externalSessionId ? { externalSessionId: live.externalSessionId } : {}),
        prompt: (live.routing.prompt ?? '').slice(0, LIVE_RUN_PROMPT_CHARS),
        state: this.stops.get(runId)?.signal.aborted ? 'stopping' : questions.length > 0 ? 'waiting' : 'running',
        questions
      })
    }
    for (const run of this.macRuns?.list() ?? []) {
      const cwd = this.authorizedCwd(run.cwd)
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

  async resolveAttachments(routing: RemoteIntentRouting): Promise<RemoteIntentRouting> {
    const references = (routing.attachments ?? []).filter((item): item is RemoteIntentAttachment & { attachmentId: string; sha256: string } => typeof item.attachmentId === 'string' && typeof item.sha256 === 'string')
    if (references.length === 0) return routing
    if (!this.attachmentStore || typeof routing.attachmentPeer !== 'string') throw new RemoteRunDenied('invalid_target')
    const hydrated = await Promise.all((routing.attachments ?? []).map(async (item) => {
      if (!item.attachmentId || !item.sha256) return item
      const loaded = await this.attachmentStore!.read({ ...item, peer: routing.attachmentPeer! } as unknown as DesktopAttachmentReference)
      return { ...item, ...loaded } as unknown as RemoteIntentAttachment
    }))
    return { ...routing, attachments: hydrated as RemoteIntentAttachment[] }
  }

  async releaseAttachments(routing: RemoteIntentRouting): Promise<void> {
    if (!this.attachmentStore || typeof routing.attachmentPeer !== 'string') return
    await Promise.all((routing.attachments ?? []).filter((item): item is RemoteIntentAttachment & { attachmentId: string } => typeof item.attachmentId === 'string').map((item) => this.attachmentStore!.remove(routing.attachmentPeer!, item.attachmentId)))
  }

  protected authorizedCwd(cwd: string): string | undefined {
    try { return this.workspace.authorize(cwd) } catch { return undefined }
  }

  protected isRemoteRun(runId: string): boolean {
    return REMOTE_RUN_ID.test(runId) && this.ledger.runState(runId) !== undefined
  }

  // A Mac run the device may control: listed now and inside an authorized project.
  protected macRun(runId: string): MacRunView {
    const run = MAC_RUN_ID.test(runId) ? this.macRuns?.list().find((item) => item.runId === runId) : undefined
    if (!run || !this.authorizedCwd(run.cwd)) throw new RemoteInteractionError('unknown_run')
    return run
  }

  notifyChange(): void {
    this.changeSeq++
    const waiters = [...this.changeWaiters]
    this.changeWaiters.clear()
    for (const wake of waiters) wake()
  }

  waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => { clearTimeout(timer); this.changeWaiters.delete(wake); resolve() }
      const timer = setTimeout(wake, timeoutMs)
      this.changeWaiters.add(wake)
    })
  }

  // Test/shutdown aid: wait for in-flight executor work to settle.
  async idle(): Promise<void> {
    await this.dispatcher.idle()
  }
}
