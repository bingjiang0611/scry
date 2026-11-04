// @ts-nocheck
import { createHash, randomUUID } from 'node:crypto'
import type { DesktopDirectoryPage, DesktopDirectoryQuery, DesktopDirectoryResult, DesktopHostRead, DesktopHostReadResult, DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteProviderQuery } from '../../shared/desktop-remote'
import type { DeleteSessionResult, McpSnapshot } from '../../shared/provider'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '../../shared/llm-performance'
import { shapeAnalyticsPanel, shapeLlmPanel, shapeMcpPanel, shapeMcpScan, type ToolPanelPayload } from '../../shared/tool-panel'
import type { UsageAnalytics, UsageAnalyticsRangeDays } from '../../shared/trace'
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
import type { WorkspaceStartSelection } from '../../shared/workspace-selection'
import { parseWorkspaceStartSelection } from '../../shared/workspace-selection-input'
import { RemoteInteractionBroker, RemoteInteractionError, type RemoteQuestionAnswerReceipt } from './remote-interaction-broker'
import { attachmentCapability, DesktopAttachmentStore, DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, type DesktopAttachmentReference } from './desktop-attachments'
import type { RemoteIntentAttachment, RemoteIntentRouting, MacRunView, MacRunSource, LiveRunRef, ToolPanelSources, HostControllerDependencies } from './host-controller-contracts'
import { parseRouting, sessionMarkerId, stampAttachmentPeer, HOST_RESTARTED_DETAIL, REMOTE_RUN_ID } from './host-controller'

export class HostControllerBase {
  readonly authority: PairingAuthority
  readonly terminals = new RemoteTerminalOwnership()
  ledger: SessionLedger
  gateway: RemoteGateway
  dispatcher: RemoteDispatcher
  output: RunOutputLog
  interactions: RemoteInteractionBroker
  stops = new Map<string, AbortController>()
  // Remote runs whose executor is in flight. In-memory on purpose: after a host
  // restart no executor exists, and the ledger already reports the run as ended.
  live = new Map<string, { routing: RemoteIntentRouting; externalSessionId?: string }>()
  workspace: WorkspaceAuthorizer
  fileDownloads: RemoteFileDownloads
  macRuns?: MacRunSource
  readDesktopSource?: HostControllerDependencies['readDesktop']
  desktopWorkbenchSource?: HostControllerDependencies['desktopWorkbench']
  desktopDirectories?: HostControllerDependencies['desktopDirectories']
  providerControls?: HostControllerDependencies['listProviderControls']
  sessionActionSource?: HostControllerDependencies['sessionAction']
  sessionForkSource?: HostControllerDependencies['sessionFork']
  sessionDeleteSource?: HostControllerDependencies['sessionDelete']
  toolPanels?: HostControllerDependencies['toolPanels']
  attachmentStore?: DesktopAttachmentStore
  // Wake-up signal for long-poll watchers. Ledger events and output appends bump
  // it; a watcher always re-reads through the normal authorized readers.
  changeSeq = 0
  changeWaiters = new Set<() => void>()

  constructor(deps: HostControllerDependencies) {
    this.authority = new PairingAuthority(deps.pairing)
    this.workspace = deps.workspace
    this.fileDownloads = new RemoteFileDownloads(deps.workspace)
    this.macRuns = deps.macRuns
    this.readDesktopSource = deps.readDesktop
    this.desktopWorkbenchSource = deps.desktopWorkbench
    this.desktopDirectories = deps.desktopDirectories
    this.providerControls = deps.listProviderControls
    this.sessionActionSource = deps.sessionAction
    this.sessionForkSource = deps.sessionFork
    this.sessionDeleteSource = deps.sessionDelete
    this.toolPanels = deps.toolPanels
    this.ledger = new SessionLedger({ store: deps.ledgerStore, onEvent: () => this.notifyChange() })
    this.attachmentStore = deps.attachmentStore ?? (deps.attachmentDirectory
      ? new DesktopAttachmentStore(deps.attachmentDirectory, (peer, id) => this.ledger.intentRun(scopedIntentId(peer, id))?.lifecycle)
      : undefined)
    this.output = new RunOutputLog({ store: deps.outputStore })
    this.interactions = new RemoteInteractionBroker((runId, detail) => {
      this.ledger.markProgress(runId, detail)
    })
    this.gateway = new RemoteGateway({
      authority: this.authority,
      ledger: this.ledger,
      output: this.output,
      ...(deps.listProjects ? { projects: { list: deps.listProjects } } : {}),
      ...(deps.listDirectories ? { directories: { list: deps.listDirectories } } : {}),
      ...(deps.listProviders || deps.listProvidersFull || deps.listProviderControls ? {
        providers: {
          ...(deps.listProviders ? { list: deps.listProviders } : {}),
          ...(deps.listProvidersFull ? { listFull: deps.listProvidersFull } : {}),
          ...(deps.listProviderControls ? { selected: deps.listProviderControls } : {})
        }
      } : {}),
      ...(deps.listCommands ? { commands: { list: deps.listCommands } as RemoteCommandSource } : {}),
      workspace: { read: (query) => readRemoteWorkspace(deps.workspace, query, deps.readSessionStatus) },
      fileDownloads: this.fileDownloads,
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
        const routing = await this.resolveAttachments(parsed)
        const live: { routing: RemoteIntentRouting; externalSessionId?: string } = { routing }
        this.stops.set(input.runId, stop)
        this.live.set(input.runId, live)
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
            requestUserInput: (request, signal) => this.interactions.request(input.runId, request, signal),
            stopSignal: stop.signal
          })
        } finally {
          this.stops.delete(input.runId)
          this.live.delete(input.runId)
          this.interactions.cancelRun(input.runId)
          this.notifyChange()
        }
      }
    }
    const gated = new GatedExecutor({ policy, resolveTarget: (input) => parseRouting(input.detail), base })
    const output = this.output
    this.dispatcher = new RemoteDispatcher({
      ledger: this.ledger,
      executor: { execute: async (input) => {
        const routing = parseRouting(input.detail)
        try { await gated.execute(input) }
        finally {
          try { await this.releaseAttachments(routing) }
          catch (error) { console.warn('[scry] remote attachment cleanup failed:', error) }
        }
      } },
      outputSink: {
        append: (runId, chunk) => { output.append(runId, chunk); this.notifyChange() },
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
    for (const runId of this.ledger.dispatchedRuns()) this.ledger.markFailed(runId, HOST_RESTARTED_DETAIL)
    this.dispatcher.pump()
  }

  async cleanupAttachments(): Promise<void> { await this.attachmentStore?.cleanup() }

  attachmentStart(peer: string, input: unknown): Promise<{ status: 'ready' }> {
    this.authorizeDevice(peer)
    if (!this.attachmentStore || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    return this.attachmentStore.begin(peer, {
      attachmentId: value.attachmentId as string, intentId: value.intentId as string, name: value.name as string,
      mimeType: value.mimeType as never, size: value.size as number, sha256: value.sha256 as string,
      index: value.index as number, totalCount: value.totalCount as number
    }).then(() => { this.authorizeDevice(peer); return { status: 'ready' as const } })
  }

  attachmentChunk(peer: string, input: unknown): Promise<{ offset: number }> {
    this.authorizeDevice(peer)
    if (!this.attachmentStore || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    return this.attachmentStore.chunk(peer, { attachmentId: value.attachmentId as string, offset: value.offset as number, dataBase64: value.dataBase64 as string }).then((result) => { this.authorizeDevice(peer); return result })
  }

  async attachmentCommit(peer: string, input: unknown): Promise<{ attachment: DesktopAttachmentReference }> {
    this.authorizeDevice(peer)
    if (!this.attachmentStore || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    const attachment = await this.attachmentStore.commit(peer, value.attachmentId as string)
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
    if (referenced && !this.ledger.intentRun(scopedIntentId(peer, input.intentId))) {
      const routing = parseRouting(detail)
      if (!this.attachmentStore) throw new Error('desktop_remote_attachments_unsupported')
      const references = (routing.attachments ?? []).map((item) => ({ ...item, peer })) as DesktopAttachmentReference[]
      await this.attachmentStore.validateReferences(peer, input.intentId, references)
    }
    // Existing receipts are compared by the ledger, even after terminal cleanup
    // removed their blobs. A lost acknowledgement must remain idempotent.
    this.authorizeDevice(peer)
    return this.#recordIntent(peer, { ...input, detail })
  }

  #recordIntent(peer: string, input: { intentId: string; detail?: string }): { runId: string; status: 'recorded' | 'duplicate' } {
    const result = this.gateway.submitIntent(peer, input)
    this.dispatcher.pump()
    return result
  }

  intentStatus(peerCertSHA256: string, input: { intentId: string }): { runId: string; state: RunLifecycle } {
    return this.gateway.intentStatus(peerCertSHA256, input)
  }

  resolveIntent(peerCertSHA256: string, input: { intentId: string }): { runId: string; state: RunLifecycle } {
    // Do not pump a recovery fence through the submission path.
    return this.gateway.resolveIntent(peerCertSHA256, input)
  }

  poll(peerCertSHA256: string, input: { cursor: number }): ReturnType<SessionLedger['since']> {
    return this.gateway.poll(peerCertSHA256, input)
  }

  runState(peerCertSHA256: string, input: { runId: string }): RunLifecycle | undefined {
    return this.gateway.runState(peerCertSHA256, input)
  }

  pendingQuestions(peerCertSHA256: string, input: { runId: string }): AgentQuestionRequest[] {
    this.authorizeDevice(peerCertSHA256)
    if (!REMOTE_RUN_ID.test(input.runId) || !this.ledger.runState(input.runId)) throw new RemoteInteractionError('unknown_run')
    return this.interactions.list(input.runId)
  }

  answerQuestion(peerCertSHA256: string, input: {
    runId: string
    answerId: string
    response: AgentQuestionResponse
  }): RemoteQuestionAnswerReceipt {
    this.authorizeDevice(peerCertSHA256)
    if (!this.isRemoteRun(input.runId)) {
      const run = this.macRun(input.runId)
      const response = input.response as { runId?: unknown; questionId?: unknown } | null
      if (!response || response.runId !== input.runId ||
          !run.questions.some((question) => question.questionId === response.questionId)) {
        throw new RemoteInteractionError('question_not_pending')
      }
      // The Mac broker settles a question once. A false return means it was
      // already answered (here or on the Mac) or closed; never report success.
      if (!this.macRuns!.answer(input.response)) throw new RemoteInteractionError('question_not_pending')
      return { status: 'answered' }
    }
    return this.interactions.answer(input.runId, { answerId: input.answerId, response: input.response })
  }

  // Trusted Mac UI answering a question of a device-started run. Same broker as
  // the device path, so whichever side answers first settles it exactly once.
  // `response.runId` is ignored: the caller resolved the ledger runId itself.
  // false = not accepted, like the Mac broker: no longer pending (answered on the
  // device or withdrawn) or not a valid answer to that question. A ledger write
  // failure still throws.
  answerOwnerQuestion(runId: string, response: AgentQuestionResponse): boolean {
    try {
      return this.interactions.answer(runId, { answerId: randomUUID(), response: { ...response, runId } }).status === 'answered'
    } catch (error) {
      if (error instanceof RemoteInteractionError) return false
      throw error
    }
  }



}
