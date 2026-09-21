import { PairingAuthority, type PairingDependencies } from './pairing'
import { SessionLedger, type LedgerStore, type RunLifecycle } from './session-ledger'
import { RemoteGateway, type RemoteProjectRef, type RemoteDirectoryListing, type RemoteDirectoryPage, type RemoteDirectoryPageQuery, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteCommandSource, type RemoteSessionRef, type RemoteSessionPage, type RemoteSessionPageQuery, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPage, type RemoteHistoryPageQuery, type RemoteHistorySource } from './remote-gateway'
import { RunOutputLog, type RunOutputPage, type RunOutputStore } from './run-output-log'
export type { RemoteProjectRef, RemoteDirectoryListing, RemoteDirectoryPage, RemoteDirectoryPageQuery, RemoteProviderRef, RemoteCommandRef, RemoteCommandCatalog, RemoteCommandQuery, RemoteSessionRef, RemoteSessionPage, RemoteSessionPageQuery, RemoteHistoryTurn, RemoteHistoryQuery } from './remote-gateway'
export type { RunOutputPage, OutputChunk } from './run-output-log'
import { RemoteDispatcher, type RemoteExecutor, type RemoteExecutorInput } from './remote-dispatcher'
import { RemoteRunPolicy, GatedExecutor, RemoteRunDenied, type WorkspaceAuthorizer, type RemoteRunTarget } from './remote-run-policy'
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

export interface HostControllerDependencies {
  // Pairing adapters (CSR verification + certificate issuance + persistence).
  pairing: PairingDependencies
  // Durable ledger backing store (JSONL file store in production).
  ledgerStore: LedgerStore
  // Production supplies a durable cursor store; omission keeps the explicit bounded fallback.
  outputStore?: RunOutputStore
  // Resolves and authorizes a workspace against the known-project authority.
  workspace: WorkspaceAuthorizer
  // The only injected leaf: performs the real Provider run for a routed intent.
  // `output` streams the assistant's real trace CONTENT (masked, bounded) to the
  // device; distinct from the opaque lifecycle `progress` markers.
  runProvider(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
    requestUserInput(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
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
  // Read one session's real conversation content. Absent => empty transcript.
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
  // Optional shared operation gate (auth vs run mutual exclusion). A fresh one
  // is created when omitted; production passes the app-wide gate.
  gate?: ProviderOperationGate
}

const REMOTE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
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

  constructor(deps: HostControllerDependencies) {
    this.authority = new PairingAuthority(deps.pairing)
    this.#ledger = new SessionLedger({ store: deps.ledgerStore })
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
      ...(deps.listSessions ? { sessions: { list: deps.listSessions } } : {}),
      ...(deps.readHistory ? { history: { read: deps.readHistory } as RemoteHistorySource } : {})
    })

    const policy = new RemoteRunPolicy({ gate: deps.gate ?? new ProviderOperationGate(), workspace: deps.workspace })
    const base: RemoteExecutor = {
      execute: async (input: RemoteExecutorInput) => {
        try {
          await deps.runProvider({
            runId: input.runId,
            routing: parseRouting(input.detail),
            progress: input.progress,
            output: input.output,
            requestUserInput: (request, signal) => this.#interactions.request(input.runId, request, signal)
          })
        } finally {
          this.#interactions.cancelRun(input.runId)
        }
      }
    }
    const gated = new GatedExecutor({ policy, resolveTarget: (input) => parseRouting(input.detail), base })
    this.#dispatcher = new RemoteDispatcher({ ledger: this.#ledger, executor: gated, outputSink: this.#output })
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
    if (!REMOTE_RUN_ID.test(input.runId) || !this.#ledger.runState(input.runId)) throw new RemoteInteractionError('unknown_run')
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
  readHistory(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]> {
    return this.#gateway.readHistory(peerCertSHA256, query)
  }

  readHistoryPage(peerCertSHA256: string, query: RemoteHistoryPageQuery): Promise<RemoteHistoryPage> {
    return this.#gateway.readHistoryPage(peerCertSHA256, query)
  }

  // Device-facing: the assistant's real streamed output CONTENT for one run,
  // strictly after the caller's cursor, authorized by the verified peer cert.
  runOutput(peerCertSHA256: string, input: { runId: string; cursor: number }): Promise<RunOutputPage> {
    return this.#gateway.pollOutput(peerCertSHA256, input)
  }

  // Test/shutdown aid: wait for in-flight executor work to settle.
  async idle(): Promise<void> {
    await this.#dispatcher.idle()
  }
}
