import { createHash, randomUUID } from 'node:crypto'
import type { DesktopDirectoryPage, DesktopDirectoryQuery, DesktopDirectoryResult, DesktopHostRead, DesktopHostReadResult, DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest } from '../../shared/desktop-remote'
import type { DeleteSessionResult } from '../../shared/provider'
import { parseDesktopDirectoryQuery } from './desktop-directory-picker'
import { parseDesktopHostRead } from './desktop-host-reader'
import { parseDesktopWorkbenchQuery } from './desktop-workbench'
import { PairingAuthority, type PairingDependencies } from './pairing'
import { SessionLedger, type LedgerStore, type RunLifecycle } from './session-ledger'
import { RemoteGateway, scopedIntentId, type RemoteProjectRef, type RemoteDirectoryListing, type RemoteDirectoryPage, type RemoteDirectoryPageQuery, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteCommandSource, type RemoteSessionRef, type RemoteSessionPage, type RemoteSessionPageQuery, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPage, type RemoteHistoryPageQuery, type RemoteHistorySource, type RemoteHistoryPreview, type RemoteHistoryPreviewSource, type RemoteHistoryVersion, type RemoteHistoryVersionSource, type RemoteHistoryTurnsPage, type RemoteHistoryTurnsPageQuery, type RemoteHistoryTurnsPageSource } from './remote-gateway'
import { RunOutputLog, type RunOutputPage, type RunOutputStore } from './run-output-log'
export type { RemoteProjectRef, RemoteDirectoryListing, RemoteDirectoryPage, RemoteDirectoryPageQuery, RemoteProviderRef, RemoteCommandRef, RemoteCommandCatalog, RemoteCommandQuery, RemoteSessionRef, RemoteSessionPage, RemoteSessionPageQuery, RemoteHistoryTurn, RemoteHistoryQuery, RemoteHistoryPreview, RemoteHistoryVersion, RemoteHistoryTurnsPage, RemoteHistoryTurnsPageQuery } from './remote-gateway'
export type { RunOutputPage, OutputChunk } from './run-output-log'
import { RemoteDispatcher, type RemoteExecutor, type RemoteExecutorInput } from './remote-dispatcher'
import { RemoteRunPolicy, GatedExecutor, RemoteRunDenied, type WorkspaceAuthorizer, type RemoteRunTarget } from './remote-run-policy'
import { readRemoteWorkspace, type RemoteSessionStatus, type RemoteSessionStatusQuery } from './remote-workspace'
import { RemoteFileDownloads } from './remote-file-download'
import { RemoteTerminalOwnership } from './remote-terminal-ownership'
import { ProviderOperationGate } from '../provider-operation-gate'
import { decodedBase64ByteLength, isAgentPermissionMode, isSupportedImageMimeType, type AgentPermissionMode, type AgentQuestionRequest, type AgentQuestionResponse } from '../../shared/runtime'
import { RemoteInteractionBroker, RemoteInteractionError, type RemoteQuestionAnswerReceipt } from './remote-interaction-broker'
import { attachmentCapability, DesktopAttachmentStore, DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, type DesktopAttachmentReference } from './desktop-attachments'

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
  attachmentId?: string
  sha256?: string
  index?: number
  totalCount?: number
  intentId?: string
}

export interface RemoteIntentRouting extends RemoteRunTarget {
  prompt?: string
  modelId?: string
  modelProviderId?: string
  effort?: string
  permissionMode?: AgentPermissionMode
  // Inline payloads are retained for older peers; current desktop peers send
  // persistent, hash-bound host attachment references. Images are forwarded as
  // native Provider attachments; UTF-8 text/code files become explicit context
  // blocks. The parser and attachment store validate every byte before the
  // Provider can see it.
  attachments?: RemoteIntentAttachment[]
  // The Provider's own session id to CONTINUE (resume) instead of starting a
  // fresh conversation. Present when the device sends a follow-up into an opened
  // session; absent for a brand-new session. Authorization is unchanged (still by
  // cwd + provider); resume only selects which conversation the run continues.
  resume?: string
  // Host-injected owner identity for persisted attachment references.
  attachmentPeer?: string
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
  readDesktop?(query: DesktopHostRead): Promise<DesktopHostReadResult>
  desktopWorkbench?: import('./desktop-workbench').DesktopWorkbenchHost
  desktopDirectories?: {
    list(query: Extract<DesktopDirectoryQuery, { action: 'list' }>): DesktopDirectoryPage
    select(path: string): RemoteProjectRef
  }
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
  // Host-owned session metadata writes. The callback must use the host store.
  sessionAction?(context: DesktopRemoteContext, action: DesktopRemoteSessionAction, authorize: () => void): Promise<boolean> | boolean
  sessionFork?(request: DesktopRemoteForkSessionRequest, authorize: () => void): Promise<{ externalSessionId: string }>
  sessionDelete?(request: DesktopRemoteDeleteSessionRequest, authorize: () => void): Promise<DeleteSessionResult>
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
  attachmentStore?: DesktopAttachmentStore
  attachmentDirectory?: string
}

const REMOTE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Mac UI run ids (`run-<base36 time>-<seq>`); never ledger-backed.
const MAC_RUN_ID = /^run-[0-9a-z]{1,16}-[0-9]{1,12}$/
// Below the inner host's 30-second idle timer and the device's response deadline.
const WATCH_MAX_WAIT_MS = 20_000
const MAX_REMOTE_DETAIL_CHARS = 1_200_000
const MAX_REMOTE_PROMPT_CHARS = 128_000
const MAX_REMOTE_ATTACHMENT_BYTES = 512 * 1024
const MAX_REMOTE_ATTACHMENTS_TOTAL_BYTES = 700 * 1024
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[a-f0-9]{64}$/

function parseRemoteAttachments(value: unknown): RemoteIntentAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > DESKTOP_ATTACHMENT_MAX_COUNT) throw new RemoteRunDenied('invalid_target')
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
    const reference = item.attachmentId !== undefined
    if (reference) {
      if (item.kind !== 'image' || !isSupportedImageMimeType(item.mimeType) || typeof item.attachmentId !== 'string' || !ATTACHMENT_ID.test(item.attachmentId) || item.dataBase64 !== '' || !SHA256.test(String(item.sha256)) || !Number.isSafeInteger(item.size) || Number(item.size) < 1 || Number(item.size) > DESKTOP_ATTACHMENT_MAX_BYTES || !Number.isSafeInteger(item.index) || Number(item.index) < 0 || !Number.isSafeInteger(item.totalCount) || Number(item.totalCount) < 1 || Number(item.totalCount) > DESKTOP_ATTACHMENT_MAX_COUNT || Number(item.index) >= Number(item.totalCount) || typeof item.intentId !== 'string' || !ATTACHMENT_ID.test(item.intentId)) throw new RemoteRunDenied('invalid_target')
      total += item.size as number
      if (total > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) throw new RemoteRunDenied('invalid_target')
      return { kind: 'image', name: item.name, mimeType: item.mimeType, dataBase64: '', size: item.size as number, attachmentId: item.attachmentId, sha256: item.sha256 as string, index: item.index as number, totalCount: item.totalCount as number, intentId: item.intentId }
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

function stampAttachmentPeer(peer: string, detail: string | undefined): { detail: string | undefined; referenced: boolean } {
  if (typeof detail !== 'string') return { detail, referenced: false }
  try {
    const value = JSON.parse(detail) as Record<string, unknown>
    const attachments = value && Array.isArray(value.attachments) ? value.attachments : []
    if (!attachments.some((item) => item && typeof item === 'object' && 'attachmentId' in item)) return { detail, referenced: false }
    return { detail: JSON.stringify({ ...value, attachmentPeer: peer }), referenced: true }
  } catch { return { detail, referenced: false } }
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
  if (routing.permissionMode !== undefined && !isAgentPermissionMode(routing.permissionMode)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.attachmentPeer !== undefined && (typeof routing.attachmentPeer !== 'string' || !SHA256.test(routing.attachmentPeer))) throw new RemoteRunDenied('invalid_target')
  const attachments = parseRemoteAttachments(routing.attachments)
  if (routing.prompt !== undefined && typeof routing.prompt !== 'string') throw new RemoteRunDenied('invalid_target')
  if (routing.prompt === '' && attachments.length === 0) throw new RemoteRunDenied('invalid_target')
  return {
    cwd: routing.cwd,
    providerId: routing.providerId,
    ...(typeof routing.agentProfileId === 'string' ? { agentProfileId: routing.agentProfileId } : {}),
    ...(typeof routing.prompt === 'string' ? { prompt: routing.prompt } : {}),
    ...(typeof routing.modelId === 'string' ? { modelId: routing.modelId } : {}),
    ...(typeof routing.modelProviderId === 'string' ? { modelProviderId: routing.modelProviderId } : {}),
    ...(typeof routing.effort === 'string' ? { effort: routing.effort } : {}),
    ...(isAgentPermissionMode(routing.permissionMode) ? { permissionMode: routing.permissionMode } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof routing.resume === 'string' && routing.resume.length > 0 && routing.resume.length <= 128 ? { resume: routing.resume } : {}),
    ...(typeof routing.attachmentPeer === 'string' ? { attachmentPeer: routing.attachmentPeer } : {})
  }
}

// Device-visible failure detail for a run orphaned by a host restart.
export const HOST_RESTARTED_DETAIL = 'host_restarted: Mac 上的 Scry 在这轮结束前重启，已无法观测它的结果；Provider 可能已部分执行，请在 Mac 上核对后再决定是否重发'

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
  #fileDownloads: RemoteFileDownloads
  #macRuns?: MacRunSource
  #readDesktop?: HostControllerDependencies['readDesktop']
  #desktopWorkbench?: HostControllerDependencies['desktopWorkbench']
  #desktopDirectories?: HostControllerDependencies['desktopDirectories']
  #sessionAction?: HostControllerDependencies['sessionAction']
  #sessionFork?: HostControllerDependencies['sessionFork']
  #sessionDelete?: HostControllerDependencies['sessionDelete']
  #attachmentStore?: DesktopAttachmentStore
  // Wake-up signal for long-poll watchers. Ledger events and output appends bump
  // it; a watcher always re-reads through the normal authorized readers.
  #changeSeq = 0
  #changeWaiters = new Set<() => void>()

  constructor(deps: HostControllerDependencies) {
    this.authority = new PairingAuthority(deps.pairing)
    this.#workspace = deps.workspace
    this.#fileDownloads = new RemoteFileDownloads(deps.workspace)
    this.#macRuns = deps.macRuns
    this.#readDesktop = deps.readDesktop
    this.#desktopWorkbench = deps.desktopWorkbench
    this.#desktopDirectories = deps.desktopDirectories
    this.#sessionAction = deps.sessionAction
    this.#sessionFork = deps.sessionFork
    this.#sessionDelete = deps.sessionDelete
    this.#ledger = new SessionLedger({ store: deps.ledgerStore, onEvent: () => this.#notifyChange() })
    this.#attachmentStore = deps.attachmentStore ?? (deps.attachmentDirectory
      ? new DesktopAttachmentStore(deps.attachmentDirectory, (peer, id) => this.#ledger.intentRun(scopedIntentId(peer, id))?.lifecycle)
      : undefined)
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
      fileDownloads: this.#fileDownloads,
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
        const parsed = parseRouting(input.detail)
        const routing = await this.#resolveAttachments(parsed)
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
      executor: { execute: async (input) => {
        const routing = parseRouting(input.detail)
        try { await gated.execute(input) }
        finally {
          try { await this.#releaseAttachments(routing) }
          catch (error) { console.warn('[scry] remote attachment cleanup failed:', error) }
        }
      } },
      outputSink: {
        append: (runId, chunk) => { output.append(runId, chunk); this.#notifyChange() },
        flush: (runId) => output.flush(runId)
      }
    })
  }

  // Startup only, before any executor exists in this process.
  //   - A run still `dispatched` lost its executor with the previous process, so
  //     nothing can ever report its terminal result. Close it as failed with that
  //     reason instead of leaving the device showing it as running forever. Its
  //     Provider outcome stays unknown, and it is never re-run.
  //   - Dispatch any intent that was durably recorded but never dispatched,
  //     exactly once.
  recover(): void {
    for (const runId of this.#ledger.dispatchedRuns()) this.#ledger.markFailed(runId, HOST_RESTARTED_DETAIL)
    this.#dispatcher.pump()
  }

  async cleanupAttachments(): Promise<void> { await this.#attachmentStore?.cleanup() }

  attachmentStart(peer: string, input: unknown): Promise<{ status: 'ready' }> {
    this.authorizeDevice(peer)
    if (!this.#attachmentStore || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    return this.#attachmentStore.begin(peer, {
      attachmentId: value.attachmentId as string, intentId: value.intentId as string, name: value.name as string,
      mimeType: value.mimeType as never, size: value.size as number, sha256: value.sha256 as string,
      index: value.index as number, totalCount: value.totalCount as number
    }).then(() => { this.authorizeDevice(peer); return { status: 'ready' as const } })
  }

  attachmentChunk(peer: string, input: unknown): Promise<{ offset: number }> {
    this.authorizeDevice(peer)
    if (!this.#attachmentStore || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    return this.#attachmentStore.chunk(peer, { attachmentId: value.attachmentId as string, offset: value.offset as number, dataBase64: value.dataBase64 as string }).then((result) => { this.authorizeDevice(peer); return result })
  }

  async attachmentCommit(peer: string, input: unknown): Promise<{ attachment: DesktopAttachmentReference }> {
    this.authorizeDevice(peer)
    if (!this.#attachmentStore || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    const attachment = await this.#attachmentStore.commit(peer, value.attachmentId as string)
    this.authorizeDevice(peer)
    return { attachment }
  }

  // Device-facing (inner-mTLS): submit a durable intent, then drive the
  // dispatcher so the gated executor picks it up exactly once.
  submitIntent(peerCertSHA256: string, input: { intentId: string; detail?: string }): { runId: string; status: 'recorded' | 'duplicate' } {
    if (stampAttachmentPeer(peerCertSHA256, input.detail).referenced) throw new Error('attachment_requires_validated_submit')
    return this.#recordIntent(peerCertSHA256, input)
  }

  async submitReceivedIntent(peer: string, input: { intentId: string; detail?: string }): Promise<{ runId: string; status: 'recorded' | 'duplicate' }> {
    this.authorizeDevice(peer)
    const { detail, referenced } = stampAttachmentPeer(peer, input.detail)
    if (referenced && !this.#ledger.intentRun(scopedIntentId(peer, input.intentId))) {
      const routing = parseRouting(detail)
      if (!this.#attachmentStore) throw new Error('desktop_remote_attachments_unsupported')
      const references = (routing.attachments ?? []).map((item) => ({ ...item, peer })) as DesktopAttachmentReference[]
      await this.#attachmentStore.validateReferences(peer, input.intentId, references)
    }
    // Existing receipts are compared by the ledger, even after terminal cleanup
    // removed their blobs. A lost acknowledgement must remain idempotent.
    this.authorizeDevice(peer)
    return this.#recordIntent(peer, { ...input, detail })
  }

  #recordIntent(peer: string, input: { intentId: string; detail?: string }): { runId: string; status: 'recorded' | 'duplicate' } {
    const result = this.#gateway.submitIntent(peer, input)
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

  // Trusted Mac UI answering a question of a device-started run. Same broker as
  // the device path, so whichever side answers first settles it exactly once.
  // `response.runId` is ignored: the caller resolved the ledger runId itself.
  // false = not accepted, like the Mac broker: no longer pending (answered on the
  // device or withdrawn) or not a valid answer to that question. A ledger write
  // failure still throws.
  answerOwnerQuestion(runId: string, response: AgentQuestionResponse): boolean {
    try {
      return this.#interactions.answer(runId, { answerId: randomUUID(), response: { ...response, runId } }).status === 'answered'
    } catch (error) {
      if (error instanceof RemoteInteractionError) return false
      throw error
    }
  }

  async readDesktop(peerCertSHA256: string, input: unknown): Promise<DesktopHostReadResult> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.#readDesktop) throw new Error('desktop_protocol_unavailable')
    const result = await this.#readDesktop(parseDesktopHostRead(input))
    this.authorizeDevice(peerCertSHA256)
    if (result.kind !== 'info') return result
    const { sessionActions: _reportedSessionActions, sessionFork: _reportedSessionFork, sessionDelete: _reportedSessionDelete, ...info } = result
    return { ...info, ...(this.#desktopDirectories ? { directorySelection: true as const } : {}), ...(this.#desktopWorkbench ? { workbench: 1 as const } : {}), ...(this.#sessionAction ? { sessionActions: true as const } : {}), ...(this.#sessionFork ? { sessionFork: true as const } : {}), ...(this.#sessionDelete ? { sessionDelete: true as const } : {}), ...(this.#attachmentStore ? { attachments: attachmentCapability() } : {}) }
  }

  releaseDesktopPeer(peer: string): Promise<void> { return this.#desktopWorkbench?.release(peer) ?? Promise.resolve() }

  async desktopWorkbench(peer: string, input: unknown): Promise<unknown> {
    this.authorizeDevice(peer)
    if (!this.#desktopWorkbench) throw new Error('desktop_workbench_unavailable')
    const result = await this.#desktopWorkbench.request(peer, parseDesktopWorkbenchQuery(input), () => this.authorizeDevice(peer))
    try { this.authorizeDevice(peer) } catch (error) {
      await this.#desktopWorkbench.release(peer)
      throw error
    }
    return result
  }

  // Separate from the project-scoped mobile browser. Selecting is an explicit
  // workspace grant by an authenticated owner, never a browse side effect.
  desktopDirectory(peerCertSHA256: string, input: unknown): DesktopDirectoryResult {
    this.authorizeDevice(peerCertSHA256)
    if (!this.#desktopDirectories) throw new Error('desktop_directory_selection_unavailable')
    const query = parseDesktopDirectoryQuery(input)
    return query.action === 'list'
      ? { action: 'list', page: this.#desktopDirectories.list(query) }
      : { action: 'select', project: this.#desktopDirectories.select(query.path) }
  }

  private authorizeDevice(peerCertSHA256: string): void {
    if (!/^[a-f0-9]{64}$/.test(peerCertSHA256) || !this.authority.authorizesCertificate(peerCertSHA256)) {
      throw new RemoteInteractionError('device_not_authorized')
    }
  }

  // Narrow target routing needs the same verified-peer check as every existing
  // mobile operation. It deliberately exposes no pairing or workspace state.
  authorizeDevicePeer(peerCertSHA256: string): void { this.authorizeDevice(peerCertSHA256) }

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

  async sessionAction(peerCertSHA256: string, input: unknown): Promise<boolean> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.#sessionAction) throw new Error('desktop_session_actions_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_action')
    const value = input as Record<string, unknown>
    const rawContext = value.context
    if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) throw new Error('invalid_session_action')
    const contextValue = rawContext as Record<string, unknown>
    if (typeof contextValue.cwd !== 'string' || contextValue.cwd.length === 0 || contextValue.cwd.length > 16_384 ||
        typeof contextValue.providerId !== 'string' || contextValue.providerId.length === 0 || contextValue.providerId.length > 256 ||
        typeof contextValue.externalSessionId !== 'string' || contextValue.externalSessionId.length === 0 || contextValue.externalSessionId.length > 256 ||
        (contextValue.agentProfileId !== undefined && (typeof contextValue.agentProfileId !== 'string' || contextValue.agentProfileId.length === 0 || contextValue.agentProfileId.length > 256))) {
      throw new Error('invalid_session_action')
    }
    const rawAction = value.action
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) throw new Error('invalid_session_action')
    const actionValue = rawAction as Record<string, unknown>
    let action: DesktopRemoteSessionAction
    if (actionValue.kind === 'rename' && typeof actionValue.title === 'string' && actionValue.title.length <= 256) action = { kind: 'rename', title: actionValue.title }
    else if (actionValue.kind === 'pin' && typeof actionValue.pinned === 'boolean') action = { kind: 'pin', pinned: actionValue.pinned }
    else if (actionValue.kind === 'archive' && typeof actionValue.archived === 'boolean') action = { kind: 'archive', archived: actionValue.archived }
    else throw new Error('invalid_session_action')
    const canonicalCwd = this.#workspace.authorize(contextValue.cwd)
    const context: DesktopRemoteContext = {
      cwd: canonicalCwd,
      providerId: contextValue.providerId,
      ...(typeof contextValue.agentProfileId === 'string' ? { agentProfileId: contextValue.agentProfileId } : {}),
      externalSessionId: contextValue.externalSessionId
    }
    const authorize = (): void => {
      this.authorizeDevice(peerCertSHA256)
      if (this.#workspace.authorize(context.cwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await this.#sessionAction(context, action, authorize)
    authorize()
    return result
  }

  async sessionFork(peerCertSHA256: string, input: unknown): Promise<{ externalSessionId: string }> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.#sessionFork) throw new Error('desktop_session_fork_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_fork')
    const value = input as Record<string, unknown>
    const text = (candidate: unknown, max = 256): candidate is string => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= max && !candidate.includes('\0')
    if (!text(value.providerId) || !text(value.cwd, 16_384) || !text(value.sourceSessionId) || !text(value.sourceRunId) ||
        !text(value.sourceProviderTurnId) || !text(value.sourceForkTurnId) ||
        (value.agentProfileId !== undefined && !text(value.agentProfileId)) ||
        (value.model !== undefined && (!value.model || typeof value.model !== 'object' || Array.isArray(value.model)))) throw new Error('invalid_session_fork')
    const canonicalCwd = this.#workspace.authorize(value.cwd)
    const request = {
      providerId: value.providerId,
      cwd: canonicalCwd,
      sourceSessionId: value.sourceSessionId,
      sourceRunId: value.sourceRunId,
      sourceProviderTurnId: value.sourceProviderTurnId,
      sourceForkTurnId: value.sourceForkTurnId,
      ...(typeof value.agentProfileId === 'string' ? { agentProfileId: value.agentProfileId } : {}),
      ...(value.model !== undefined ? { model: value.model } : {})
    } as DesktopRemoteForkSessionRequest
    const authorize = (): void => {
      this.authorizeDevice(peerCertSHA256)
      if (this.#workspace.authorize(canonicalCwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await this.#sessionFork(request, authorize)
    authorize()
    if (!result || typeof result.externalSessionId !== 'string' || result.externalSessionId.length === 0) throw new Error('invalid_session_fork_response')
    return result
  }

  async sessionDelete(peerCertSHA256: string, input: unknown): Promise<DeleteSessionResult> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.#sessionDelete) throw new Error('desktop_session_delete_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_delete')
    const value = input as Record<string, unknown>
    if (value.confirmed !== true || typeof value.providerId !== 'string' || value.providerId.length === 0 || value.providerId.length > 256 ||
        typeof value.cwd !== 'string' || value.cwd.length === 0 || value.cwd.length > 16_384 ||
        typeof value.externalSessionId !== 'string' || value.externalSessionId.length === 0 || value.externalSessionId.length > 256 ||
        (value.agentProfileId !== undefined && (typeof value.agentProfileId !== 'string' || value.agentProfileId.length === 0 || value.agentProfileId.length > 256))) throw new Error('invalid_session_delete')
    const canonicalCwd = this.#workspace.authorize(value.cwd)
    const request = {
      providerId: value.providerId,
      cwd: canonicalCwd,
      externalSessionId: value.externalSessionId,
      confirmed: true as const,
      ...(typeof value.agentProfileId === 'string' ? { agentProfileId: value.agentProfileId } : {})
    } satisfies DesktopRemoteDeleteSessionRequest
    const authorize = (): void => {
      this.authorizeDevice(peerCertSHA256)
      if (this.#workspace.authorize(canonicalCwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await this.#sessionDelete(request, authorize)
    authorize()
    return result
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

  readFileDownload(peerCertSHA256: string, query: unknown) {
    return this.#gateway.readFileDownload(peerCertSHA256, query)
  }

  closeReadResources(): void {
    this.#fileDownloads.dispose()
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
      const output = await this.runOutput(peerCertSHA256, { runId: input.runId, cursor: input.outputCursor })
      // Read lifecycle and its ledger evidence together after the async output
      // read. Otherwise a newly terminal state can omit its failure/result event.
      const poll = this.poll(peerCertSHA256, { cursor: input.cursor })
      const questions = this.pendingQuestions(peerCertSHA256, { runId: input.runId })
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

  async #resolveAttachments(routing: RemoteIntentRouting): Promise<RemoteIntentRouting> {
    const references = (routing.attachments ?? []).filter((item): item is RemoteIntentAttachment & { attachmentId: string; sha256: string } => typeof item.attachmentId === 'string' && typeof item.sha256 === 'string')
    if (references.length === 0) return routing
    if (!this.#attachmentStore || typeof routing.attachmentPeer !== 'string') throw new RemoteRunDenied('invalid_target')
    const hydrated = await Promise.all((routing.attachments ?? []).map(async (item) => {
      if (!item.attachmentId || !item.sha256) return item
      const loaded = await this.#attachmentStore!.read({ ...item, peer: routing.attachmentPeer! } as unknown as DesktopAttachmentReference)
      return { ...item, ...loaded } as unknown as RemoteIntentAttachment
    }))
    return { ...routing, attachments: hydrated as RemoteIntentAttachment[] }
  }

  async #releaseAttachments(routing: RemoteIntentRouting): Promise<void> {
    if (!this.#attachmentStore || typeof routing.attachmentPeer !== 'string') return
    await Promise.all((routing.attachments ?? []).filter((item): item is RemoteIntentAttachment & { attachmentId: string } => typeof item.attachmentId === 'string').map((item) => this.#attachmentStore!.remove(routing.attachmentPeer!, item.attachmentId)))
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
