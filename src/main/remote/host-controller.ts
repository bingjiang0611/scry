import { createHash } from 'node:crypto'
import { PairingAuthority, type PairingDependencies } from './pairing'
import { SessionLedger, type LedgerStore, type RunLifecycle } from './session-ledger'
import { RemoteGateway, type RemoteProjectRef, type RemoteDirectoryListing, type RemoteDirectoryPage, type RemoteDirectoryPageQuery, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteCommandSource, type RemoteSessionRef, type RemoteSessionPage, type RemoteSessionPageQuery, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPage, type RemoteHistoryPageQuery, type RemoteHistorySource, type RemoteHistoryPreview, type RemoteHistoryPreviewSource, type RemoteHistoryVersion, type RemoteHistoryVersionSource, type RemoteHistoryTurnsPage, type RemoteHistoryTurnsPageQuery, type RemoteHistoryTurnsPageSource } from './remote-gateway'
import { RunOutputLog, type RunOutputPage, type RunOutputStore } from './run-output-log'
export type { RemoteProjectRef, RemoteDirectoryListing, RemoteDirectoryPage, RemoteDirectoryPageQuery, RemoteProviderRef, RemoteCommandRef, RemoteCommandCatalog, RemoteCommandQuery, RemoteSessionRef, RemoteSessionPage, RemoteSessionPageQuery, RemoteHistoryTurn, RemoteHistoryQuery, RemoteHistoryPreview, RemoteHistoryVersion, RemoteHistoryTurnsPage, RemoteHistoryTurnsPageQuery } from './remote-gateway'
export type { RunOutputPage, OutputChunk } from './run-output-log'
import { RemoteDispatcher, type RemoteExecutor, type RemoteExecutorInput } from './remote-dispatcher'
import { RemoteRunPolicy, GatedExecutor, RemoteRunDenied, type WorkspaceAuthorizer, type RemoteRunTarget } from './remote-run-policy'
import { readRemoteWorkspace, type RemoteSessionStatus, type RemoteSessionStatusQuery } from './remote-workspace'
import { RemoteTerminalOwnership } from './remote-terminal-ownership'
import { ProviderOperationGate } from '../provider-operation-gate'
import { decodedBase64ByteLength, isSupportedImageMimeType, type AgentQuestionRequest, type AgentQuestionResponse } from '../../shared/runtime'
import { RemoteInteractionBroker, RemoteInteractionError, type RemoteQuestionAnswerReceipt } from './remote-interaction-broker'

// Trusted-local composition root for the remote subsystem. It wires the six
// modules proven in isolation (PairingAuthority, SessionLedger, RemoteGateway,
// RemoteDispatcher, RemoteRunPolicy/GatedExecutor, RemoteTerminalOwnership) into
// one object that Electron main constructs. Only trusted local UI calls the
// pairing/lifecycle methods; the device-facing surface is reached over
// inner-mTLS and always carries the VERIFIED peer certificate fingerprint.
//
// The controller adds no new security decisions — it composes the existing ones
// and keeps the truthful boundary intact: a device submission is a durable
// intent (recorded ≠ executed); the dispatcher drives exactly-once execution
// through the gated executor (workspace + provider-operation mutual exclusion);
// the base executor is the only injected leaf, where the real RunRegistry +
// Provider adapter will plug in.

// The structured routing a device intent must resolve to before any Provider
// run. Carried in the intent detail as JSON; malformed detail is denied.
export interface RemoteIntentAttachment {
  kind: 'image' | 'text'
  name: string
  mimeType: string
  dataBase64: string
  size: number
}

export interface RemoteIntentRouting extends RemoteRunTarget {
  prompt?: string
  modelId?: string
  modelProviderId?: string
  effort?: string
  permissionMode?: 'default' | 'auto_review' | 'full_access'
  // Bounded, encrypted attachment payloads from the paired device. Images are
  // forwarded as native Provider attachments; UTF-8 text/code files become
  // explicit context blocks. The parser below validates every byte before the
  // Provider can see it.
  attachments?: RemoteIntentAttachment[]
  // The Provider's own session id to CONTINUE (resume) instead of starting a
  // fresh conversation. Present when the device sends a follow-up into an opened
  // session; absent for a brand-new session. Authorization is unchanged (still by
  // cwd + provider); resume only selects which conversation the run continues.
  resume?: string
}

// A run the owner started in the Mac UI (RunRegistry), as the host proves it
// right now. Only not-yet-done runs are listed; absence is "not observed", never
// "completed".
export interface MacRunView {
  runId: string
  providerId: string
  agentProfileId?: string
  cwd: string
  externalSessionId?: string
  prompt: string
  questions: AgentQuestionRequest[]
  stopping: boolean
}

export interface MacRunSource {
  list(): MacRunView[]
  // Same bounded stop lifecycle as the Mac stop button; true = requested.
  stop(runId: string): boolean
  // Same broker as the Mac question dialog; false = no such pending question.
  answer(response: AgentQuestionResponse): boolean
}

// One live run visible to the device. `remote` runs were submitted by a paired
// device and are observed through watch; `mac` runs belong to the Mac UI.
export interface LiveRunRef {
  origin: 'remote' | 'mac'
  runId: string
  providerId: string
  agentProfileId?: string
  cwd: string
  externalSessionId?: string
  prompt: string
  state: 'running' | 'waiting' | 'stopping'
  // Open questions, so a device can answer a run it is not watching (answers
  // still go through answerQuestion and its per-origin broker).
  questions: AgentQuestionRequest[]
}

const LIVE_RUNS_MAX_WAIT_MS = 20_000
// Mac runs are in-memory state without a change signal into this controller;
// a long-poll re-checks them on this bounded tick.
const LIVE_RUNS_TICK_MS = 1_000
const LIVE_RUN_PROMPT_CHARS = 200

export interface HostControllerDependencies {
  // Pairing adapters (CSR verification + certificate issuance + persistence).
  pairing: PairingDependencies
  // Durable ledger backing store (JSONL file store in production).
  ledgerStore: LedgerStore
  // Production supplies a durable cursor store; omission keeps the explicit bounded fallback.
  outputStore?: RunOutputStore
  // Resolves and authorizes a workspace against the known-project authority.
  workspace: WorkspaceAuthorizer
  readSessionStatus?(query: RemoteSessionStatusQuery): RemoteSessionStatus
  // Mac UI runs the device may see and control. Absent => only remote runs.
  macRuns?: MacRunSource
  // The only injected leaf: performs the real Provider run for a routed intent.
  // `output` streams the assistant's real trace CONTENT (masked, bounded) to the
  // device; distinct from the opaque lifecycle `progress` markers.
  runProvider(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
    requestUserInput(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
    // Aborted only when the paired device explicitly asks to stop this run. The
    // binding forwards it to the Provider's own interrupt; the ledger lifecycle
    // still settles from the real Provider result, never from the request.
    stopSignal: AbortSignal
  }): Promise<void>
  // Snapshot of host-authorized project directories a device may target. Absent
  // => the device sees an honest empty list (never a fabricated one).
  listProjects?(): RemoteProjectRef[]
  // Immediate child folders under an authorized project path. The source must
  // canonicalize and reject paths outside the original host grant.
  listDirectories?(path?: string): RemoteDirectoryListing
  // Snapshot of the host's Providers a device may target. Absent => honest empty.
  listProviders?(): RemoteProviderRef[]
  // Provider-native slash commands for one authorized workspace context.
  listCommands?(query: RemoteCommandQuery): Promise<RemoteCommandCatalog>
  // Snapshot of the host session catalog a device may browse. Absent => empty.
  listSessions?(): RemoteSessionRef[]
  sessionCatalogRevision?(): string
  // Read one session's real conversation content. Absent => empty transcript.
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
  // Small recent evidence only; unlike full history, unavailable is explicit.
  readHistoryPreview?(query: RemoteHistoryQuery): Promise<RemoteHistoryPreview>
  // Metadata-only source stamp used by refresh; it must not materialize history.
  readHistoryVersion?(query: RemoteHistoryQuery): Promise<RemoteHistoryVersion>
  readHistoryTurnsPage?(query: RemoteHistoryTurnsPageQuery): Promise<RemoteHistoryTurnsPage>
  // Optional shared operation gate (auth vs run mutual exclusion). A fresh one
  // is created when omitted; production passes the app-wide gate.
  gate?: ProviderOperationGate
}

const REMOTE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Mac UI run ids (`run-<base36 time>-<seq>`); never ledger-backed.
const MAC_RUN_ID = /^run-[0-9a-z]{1,16}-[0-9]{1,12}$/
// Below the inner host's 30-second idle timer and the device's response deadline.
const WATCH_MAX_WAIT_MS = 20_000
const MAX_REMOTE_DETAIL_CHARS = 1_200_000
const MAX_REMOTE_PROMPT_CHARS = 128_000
const MAX_REMOTE_ATTACHMENTS = 4
const MAX_REMOTE_ATTACHMENT_BYTES = 512 * 1024
const MAX_REMOTE_ATTACHMENTS_TOTAL_BYTES = 700 * 1024

function parseRemoteAttachments(value: unknown): RemoteIntentAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_REMOTE_ATTACHMENTS) throw new RemoteRunDenied('invalid_target')
  let total = 0
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new RemoteRunDenied('invalid_target')
    const item = raw as Record<string, unknown>
    if (item.kind !== 'image' && item.kind !== 'text') throw new RemoteRunDenied('invalid_target')
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 160 || /[\u0000-\u001f]/.test(item.name)) {
      throw new RemoteRunDenied('invalid_target')
    }
    if (typeof item.mimeType !== 'string' || item.mimeType.length === 0 || item.mimeType.length > 100 || typeof item.dataBase64 !== 'string') {
      throw new RemoteRunDenied('invalid_target')
    }
    const bytes = decodedBase64ByteLength(item.dataBase64)
    if (bytes == null || bytes > MAX_REMOTE_ATTACHMENT_BYTES || item.size !== bytes) throw new RemoteRunDenied('invalid_target')
    if (item.kind === 'image' && !isSupportedImageMimeType(item.mimeType)) throw new RemoteRunDenied('invalid_target')
    if (item.kind === 'text') {
      if (!item.mimeType.startsWith('text/') && item.mimeType !== 'application/json' && item.mimeType !== 'application/xml') {
        throw new RemoteRunDenied('invalid_target')
      }
      try { new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(item.dataBase64, 'base64')) }
      catch { throw new RemoteRunDenied('invalid_target') }
    }
    total += bytes
    if (total > MAX_REMOTE_ATTACHMENTS_TOTAL_BYTES) throw new RemoteRunDenied('invalid_target')
    return { kind: item.kind, name: item.name, mimeType: item.mimeType, dataBase64: item.dataBase64, size: bytes }
  })
}

function parseRouting(detail: string | undefined): RemoteIntentRouting {
  if (typeof detail !== 'string' || detail.length === 0 || detail.length > MAX_REMOTE_DETAIL_CHARS) throw new RemoteRunDenied('invalid_target')
  let parsed: unknown
  try { parsed = JSON.parse(detail) } catch { throw new RemoteRunDenied('invalid_target') }
  if (!parsed || typeof parsed !== 'object') throw new RemoteRunDenied('invalid_target')
  const routing = parsed as Record<string, unknown>
  if (typeof routing.cwd !== 'string' || typeof routing.providerId !== 'string') throw new RemoteRunDenied('invalid_target')
  if (routing.prompt !== undefined && (typeof routing.prompt !== 'string' || routing.prompt.length > MAX_REMOTE_PROMPT_CHARS)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.modelId !== undefined && (typeof routing.modelId !== 'string' || routing.modelId.length === 0 || routing.modelId.length > 128)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.modelProviderId !== undefined && (typeof routing.modelProviderId !== 'string' || routing.modelProviderId.length === 0 || routing.modelProviderId.length > 128)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.effort !== undefined && (typeof routing.effort !== 'string' || routing.effort.length === 0 || routing.effort.length > 64)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.permissionMode !== undefined && !['default', 'auto_review', 'full_access'].includes(String(routing.permissionMode))) {
    throw new RemoteRunDenied('invalid_target')
  }
  const attachments = parseRemoteAttachments(routing.attachments)
  return {
    cwd: routing.cwd,
    providerId: routing.providerId,
    ...(typeof routing.agentProfileId === 'string' ? { agentProfileId: routing.agentProfileId } : {}),
    ...(typeof routing.prompt === 'string' ? { prompt: routing.prompt } : {}),
    ...(typeof routing.modelId === 'string' ? { modelId: routing.modelId } : {}),
    ...(typeof routing.modelProviderId === 'string' ? { modelProviderId: routing.modelProviderId } : {}),
    ...(typeof routing.effort === 'string' ? { effort: routing.effort } : {}),
    ...(routing.permissionMode === 'default' || routing.permissionMode === 'auto_review' || routing.permissionMode === 'full_access' ? { permissionMode: routing.permissionMode } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof routing.resume === 'string' && routing.resume.length > 0 && routing.resume.length <= 128 ? { resume: routing.resume } : {})
  }
}

export class HostController {
  readonly authority: PairingAuthority
  readonly terminals = new RemoteTerminalOwnership()
  #ledger: SessionLedger
  #gateway: RemoteGateway
  #dispatcher: RemoteDispatcher
  #output: RunOutputLog
  #interactions: RemoteInteractionBroker
  #stops = new Map<string, AbortController>()
  // Remote runs whose executor is in flight. In-memory on purpose: after a host
  // restart no executor exists, and the ledger already reports the run as ended.
  #live = new Map<string, { routing: RemoteIntentRouting; externalSessionId?: string }>()
  #workspace: WorkspaceAuthorizer
  #macRuns?: MacRunSource
  // Wake-up signal for long-poll watchers. Ledger events and output appends bump
  // it; a watcher always re-reads through the normal authorized readers.
  #changeSeq = 0
  #changeWaiters = new Set<() => void>()

  constructor(deps: HostControllerDependencies) {
    this.authority = new PairingAuthority(deps.pairing)
    this.#workspace = deps.workspace
    this.#macRuns = deps.macRuns
    this.#ledger = new SessionLedger({ store: deps.ledgerStore, onEvent: () => this.#notifyChange() })
    this.#output = new RunOutputLog({ store: deps.outputStore })
    this.#interactions = new RemoteInteractionBroker((runId, detail) => {
      this.#ledger.markProgress(runId, detail)
    })
    this.#gateway = new RemoteGateway({
      authority: this.authority,
      ledger: this.#ledger,
      output: this.#output,
      ...(deps.listProjects ? { projects: { list: deps.listProjects } } : {}),
      ...(deps.listDirectories ? { directories: { list: deps.listDirectories } } : {}),
      ...(deps.listProviders ? { providers: { list: deps.listProviders } } : {}),
      ...(deps.listCommands ? { commands: { list: deps.listCommands } as RemoteCommandSource } : {}),
      workspace: { read: (query) => readRemoteWorkspace(deps.workspace, query, deps.readSessionStatus) },
      ...(deps.listSessions ? { sessions: { list: deps.listSessions, ...(deps.sessionCatalogRevision ? { revision: deps.sessionCatalogRevision } : {}) } } : {}),
      ...(deps.readHistory ? { history: { read: deps.readHistory } as RemoteHistorySource } : {}),
      ...(deps.readHistoryPreview ? { historyPreview: { read: deps.readHistoryPreview } as RemoteHistoryPreviewSource } : {}),
      ...(deps.readHistoryVersion ? { historyVersion: { read: deps.readHistoryVersion } as RemoteHistoryVersionSource } : {}),
      ...(deps.readHistoryTurnsPage ? { historyTurnsPage: { read: deps.readHistoryTurnsPage } as RemoteHistoryTurnsPageSource } : {})
    })

    const policy = new RemoteRunPolicy({ gate: deps.gate ?? new ProviderOperationGate(), workspace: deps.workspace })
    const base: RemoteExecutor = {
      execute: async (input: RemoteExecutorInput) => {
        const stop = new AbortController()
        const routing = parseRouting(input.detail)
        const live: { routing: RemoteIntentRouting; externalSessionId?: string } = { routing }
        this.#stops.set(input.runId, stop)
        this.#live.set(input.runId, live)
        try {
          await deps.runProvider({
            runId: input.runId,
            routing,
            progress: (detail) => {
              const sessionId = sessionMarkerId(detail)
              if (sessionId) live.externalSessionId = sessionId
              input.progress(detail)
            },
            output: input.output,
            requestUserInput: (request, signal) => this.#interactions.request(input.runId, request, signal),
            stopSignal: stop.signal
          })
        } finally {
          this.#stops.delete(input.runId)
          this.#live.delete(input.runId)
          this.#interactions.cancelRun(input.runId)
          this.#notifyChange()
        }
      }
    }
    const gated = new GatedExecutor({ policy, resolveTarget: (input) => parseRouting(input.detail), base })
    const output = this.#output
    this.#dispatcher = new RemoteDispatcher({
      ledger: this.#ledger,
      executor: gated,
      outputSink: {
        append: (runId, chunk) => { output.append(runId, chunk); this.#notifyChange() },
        flush: (runId) => output.flush(runId)
      }
    })
  }

  // On startup, dispatch any intent that was durably recorded but never
  // dispatched (crash recovery), exactly once.
  recover(): void {
    this.#dispatcher.pump()
  }

  // Device-facing (inner-mTLS): submit a durable intent, then drive the
  // dispatcher so the gated executor picks it up exactly once.
  submitIntent(peerCertSHA256: string, input: { intentId: string; detail?: string }): { runId: string; status: 'recorded' | 'duplicate' } {
    const result = this.#gateway.submitIntent(peerCertSHA256, input)
    this.#dispatcher.pump()
    return result
  }

  intentStatus(peerCertSHA256: string, input: { intentId: string }): { runId: string; state: RunLifecycle } {
    return this.#gateway.intentStatus(peerCertSHA256, input)
  }

  poll(peerCertSHA256: string, input: { cursor: number }): ReturnType<SessionLedger['since']> {
    return this.#gateway.poll(peerCertSHA256, input)
  }

  runState(peerCertSHA256: string, input: { runId: string }): RunLifecycle | undefined {
    return this.#gateway.runState(peerCertSHA256, input)
  }

  pendingQuestions(peerCertSHA256: string, input: { runId: string }): AgentQuestionRequest[] {
    this.authorizeDevice(peerCertSHA256)
    if (!REMOTE_RUN_ID.test(input.runId) || !this.#ledger.runState(input.runId)) throw new RemoteInteractionError('unknown_run')
    return this.#interactions.list(input.runId)
  }

  answerQuestion(peerCertSHA256: string, input: {
    runId: string
    answerId: string
    response: AgentQuestionResponse
  }): RemoteQuestionAnswerReceipt {
    this.authorizeDevice(peerCertSHA256)
    if (!this.#isRemoteRun(input.runId)) {
      const run = this.#macRun(input.runId)
      const response = input.response as { runId?: unknown; questionId?: unknown } | null
      if (!response || response.runId !== input.runId ||
          !run.questions.some((question) => question.questionId === response.questionId)) {
        throw new RemoteInteractionError('question_not_pending')
      }
      // The Mac broker settles a question once. A false return means it was
      // already answered (here or on the Mac) or closed; never report success.
      if (!this.#macRuns!.answer(input.response)) throw new RemoteInteractionError('question_not_pending')
      return { status: 'answered' }
    }
    return this.#interactions.answer(input.runId, { answerId: input.answerId, response: input.response })
  }

  private authorizeDevice(peerCertSHA256: string): void {
    if (!/^[a-f0-9]{64}$/.test(peerCertSHA256) || !this.authority.authorizesCertificate(peerCertSHA256)) {
      throw new RemoteInteractionError('device_not_authorized')
    }
  }

  // Device-facing: the host-authorized project directories this device may
  // target, authorized by the same verified peer certificate as every method.
  listProjects(peerCertSHA256: string): RemoteProjectRef[] {
    return this.#gateway.listProjects(peerCertSHA256)
  }

  // Device-facing: browse within a host-authorized project without granting the
  // phone access to any parent or sibling outside that project's canonical root.
  listDirectories(peerCertSHA256: string, input: { path?: string }): RemoteDirectoryListing {
    return this.#gateway.listDirectories(peerCertSHA256, input)
  }

  listDirectoriesPage(peerCertSHA256: string, input: RemoteDirectoryPageQuery): RemoteDirectoryPage {
    return this.#gateway.listDirectoriesPage(peerCertSHA256, input)
  }

  // Device-facing: the Providers this device may target, authorized by the same
  // verified peer certificate as every method.
  listProviders(peerCertSHA256: string): RemoteProviderRef[] {
    return this.#gateway.listProviders(peerCertSHA256)
  }

  // Device-facing: Provider-native slash commands for this exact workspace.
  listCommands(peerCertSHA256: string, query: RemoteCommandQuery): Promise<RemoteCommandCatalog> {
    return this.#gateway.listCommands(peerCertSHA256, query)
  }

  // Device-facing: the host session catalog this device may browse, authorized
  // by the same verified peer certificate as every method.
  listSessions(peerCertSHA256: string): RemoteSessionRef[] {
    return this.#gateway.listSessions(peerCertSHA256)
  }

  listSessionsPage(peerCertSHA256: string, input: RemoteSessionPageQuery): RemoteSessionPage {
    return this.#gateway.listSessionsPage(peerCertSHA256, input)
  }

  // Device-facing: one session's real conversation content, authorized by the
  // same verified peer certificate. Async (reads the trace archive/transcript).
  readWorkspace(peerCertSHA256: string, query: unknown) {
    return this.#gateway.readWorkspace(peerCertSHA256, query)
  }

  readHistoryPreview(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryPreview> {
    return this.#gateway.readHistoryPreview(peerCertSHA256, query)
  }

  readHistoryVersion(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryVersion> {
    return this.#gateway.readHistoryVersion(peerCertSHA256, query)
  }

  readHistory(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]> {
    return this.#gateway.readHistory(peerCertSHA256, query)
  }

  readHistoryPage(peerCertSHA256: string, query: RemoteHistoryPageQuery): Promise<RemoteHistoryPage> {
    return this.#gateway.readHistoryPage(peerCertSHA256, query)
  }

  readHistoryTurnsPage(peerCertSHA256: string, query: RemoteHistoryTurnsPageQuery): Promise<RemoteHistoryTurnsPage> {
    return this.#gateway.readHistoryTurnsPage(peerCertSHA256, query)
  }

  // Device-facing: the assistant's real streamed output CONTENT for one run,
  // strictly after the caller's cursor, authorized by the verified peer cert.
  runOutput(peerCertSHA256: string, input: { runId: string; cursor: number }): Promise<RunOutputPage> {
    return this.#gateway.pollOutput(peerCertSHA256, input)
  }

  // Device-facing: ask the Provider running this remote intent to stop. This is
  // a request, not a lifecycle: the ledger records `stop_requested` and the run
  // settles only when the Provider adapter reports its real result.
  stopRun(peerCertSHA256: string, input: { runId: string }): { status: 'requested' | 'already_requested' | 'not_running' } {
    this.authorizeDevice(peerCertSHA256)
    if (!this.#isRemoteRun(input.runId)) {
      const run = this.#macRun(input.runId)
      if (run.stopping) return { status: 'already_requested' }
      return { status: this.#macRuns!.stop(input.runId) ? 'requested' : 'not_running' }
    }
    const stop = this.#stops.get(input.runId)
    if (!stop) return { status: 'not_running' }
    if (stop.signal.aborted) return { status: 'already_requested' }
    this.#ledger.markProgress(input.runId, JSON.stringify({ event: 'stop_requested' }))
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
      const seen = this.#changeSeq
      const poll = this.poll(peerCertSHA256, { cursor: input.cursor })
      const questions = this.pendingQuestions(peerCertSHA256, { runId: input.runId })
      const output = await this.runOutput(peerCertSHA256, { runId: input.runId, cursor: input.outputCursor })
      const state = this.#ledger.runState(input.runId) ?? null
      const terminal = state === 'settled' || state === 'failed' || state === 'cancelled'
      const remaining = deadline - Date.now()
      if (poll.events.length > 0 || poll.reset || output.chunks.length > 0 || terminal || remaining <= 0) {
        return { poll, questions, output, state }
      }
      if (seen === this.#changeSeq) await this.#waitForChange(remaining)
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
      const runs = this.#listLiveRuns()
      const revision = createHash('sha256').update(JSON.stringify(runs)).digest('hex').slice(0, 32)
      const historyVersion = input.history ? await this.#gateway.readHistoryVersion(peerCertSHA256, input.history.query) : undefined
      const remaining = deadline - Date.now()
      if (revision !== input.revision || (historyVersion && historyVersion.version !== input.history?.known) || remaining <= 0) {
        return { revision, runs, ...(historyVersion ? { historyVersion } : {}) }
      }
      await this.#waitForChange(Math.min(remaining, LIVE_RUNS_TICK_MS))
    }
  }

  #listLiveRuns(): LiveRunRef[] {
    const runs: LiveRunRef[] = []
    for (const [runId, live] of this.#live) {
      const cwd = this.#authorizedCwd(live.routing.cwd)
      if (!cwd) continue
      const questions = this.#interactions.list(runId)
      runs.push({
        origin: 'remote', runId, providerId: live.routing.providerId,
        ...(live.routing.agentProfileId ? { agentProfileId: live.routing.agentProfileId } : {}),
        cwd,
        ...(live.externalSessionId ? { externalSessionId: live.externalSessionId } : {}),
        prompt: (live.routing.prompt ?? '').slice(0, LIVE_RUN_PROMPT_CHARS),
        state: this.#stops.get(runId)?.signal.aborted ? 'stopping' : questions.length > 0 ? 'waiting' : 'running',
        questions
      })
    }
    for (const run of this.#macRuns?.list() ?? []) {
      const cwd = this.#authorizedCwd(run.cwd)
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

  #authorizedCwd(cwd: string): string | undefined {
    try { return this.#workspace.authorize(cwd) } catch { return undefined }
  }

  #isRemoteRun(runId: string): boolean {
    return REMOTE_RUN_ID.test(runId) && this.#ledger.runState(runId) !== undefined
  }

  // A Mac run the device may control: listed now and inside an authorized project.
  #macRun(runId: string): MacRunView {
    const run = MAC_RUN_ID.test(runId) ? this.#macRuns?.list().find((item) => item.runId === runId) : undefined
    if (!run || !this.#authorizedCwd(run.cwd)) throw new RemoteInteractionError('unknown_run')
    return run
  }

  #notifyChange(): void {
    this.#changeSeq++
    const waiters = [...this.#changeWaiters]
    this.#changeWaiters.clear()
    for (const wake of waiters) wake()
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => { clearTimeout(timer); this.#changeWaiters.delete(wake); resolve() }
      const timer = setTimeout(wake, timeoutMs)
      this.#changeWaiters.add(wake)
    })
  }

  // Test/shutdown aid: wait for in-flight executor work to settle.
  async idle(): Promise<void> {
    await this.#dispatcher.idle()
  }
}

function sessionMarkerId(detail: string | undefined): string | undefined {
  if (!detail) return undefined
  try {
    const marker = JSON.parse(detail) as { event?: unknown; externalSessionId?: unknown }
    return marker.event === 'session' && typeof marker.externalSessionId === 'string' && marker.externalSessionId.length <= 256
      ? marker.externalSessionId : undefined
  } catch { return undefined }
}
