import type { DeleteSessionResult } from '../../shared/provider'
import type { DesktopDirectoryResult, DesktopHostReadResult, RemoteProviderQuery } from '../../shared/desktop-remote'
import type { RemoteIntentRouting, MacRunSource, LiveRunRef, HostControllerDependencies } from './host-controller-types'
import type { WorkspaceAuthorizer } from './remote-run-policy'
import { DesktopAttachmentStore, type DesktopAttachmentReference } from './desktop-attachments'
import { HOST_RESTARTED_DETAIL, REMOTE_RUN_ID } from './host-controller-routing'
import { LiveWatchers } from './host-controller-watch'
import { PairingAuthority } from './pairing'
import { RemoteDispatcher } from './remote-dispatcher'
import { RemoteFileDownloads } from './remote-file-download'
import { RemoteGateway, scopedIntentId, type RemoteProjectRef, type RemoteDirectoryListing, type RemoteDirectoryPage, type RemoteDirectoryPageQuery, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteSessionRef, type RemoteSessionPage, type RemoteSessionPageQuery, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPage, type RemoteHistoryPageQuery, type RemoteHistoryPreview, type RemoteHistoryVersion, type RemoteHistoryTurnsPage, type RemoteHistoryTurnsPageQuery } from './remote-gateway'
import { RemoteInteractionBroker, RemoteInteractionError, type RemoteQuestionAnswerReceipt } from './remote-interaction-broker'
import { RemoteTerminalOwnership } from './remote-terminal-ownership'
import { RunOutputLog, type RunOutputPage } from './run-output-log'
import { SessionLedger, type RunLifecycle } from './session-ledger'
import { answerOwnerRunQuestion, answerRunQuestion, stopRun, type AnswerInput, type RunControlDeps } from './host-controller-run-controls'
import { authorizedCwd, isRemoteRun, macRun } from './host-controller-runs'
import { chunkAttachment, commitAttachment, releaseIntentAttachments, resolveIntentAttachments, startAttachment, type AttachmentDeps } from './host-controller-attachments'
import { createExecution } from './host-controller-execution'
import { readDesktop, readDesktopDirectory, readDesktopWorkbench, type DesktopReadDeps } from './host-controller-desktop-reads'
import { readToolPanel, type ToolPanelDeps } from './host-controller-tool-panel'
import { runSessionAction, runSessionDelete, runSessionFork, type SessionActionDeps } from './host-controller-session'
import { submitIntent, submitReceivedIntent, type SubmitDeps } from './host-controller-submit'
import { type AgentQuestionRequest, type AgentQuestionResponse } from '../../shared/runtime'
import { type ToolPanelPayload } from '../../shared/tool-panel'

export type { RemoteIntentAttachment, RemoteIntentRouting, MacRunView, MacRunSource, LiveRunRef, ToolPanelSources, HostControllerDependencies } from './host-controller-types'
export type { RemoteProjectRef, RemoteDirectoryListing, RemoteDirectoryPage, RemoteDirectoryPageQuery, RemoteProviderRef, RemoteCommandRef, RemoteCommandCatalog, RemoteCommandQuery, RemoteSessionRef, RemoteSessionPage, RemoteSessionPageQuery, RemoteHistoryTurn, RemoteHistoryQuery, RemoteHistoryPreview, RemoteHistoryVersion, RemoteHistoryTurnsPage, RemoteHistoryTurnsPageQuery } from './remote-gateway'
export type { RunOutputPage, OutputChunk } from './run-output-log'


// Device-facing API of the remote host: one method per operation the paired
// device may call, each carrying the VERIFIED peer certificate fingerprint. The
// wiring lives in host-controller-execution.ts, the long polls in
// host-controller-watch.ts, the per-domain helpers beside this file. A device
// submission is a durable intent (recorded is not executed); the dispatcher
// drives exactly-once execution through the gated executor.

export { HOST_RESTARTED_DETAIL } from './host-controller-routing'

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
  #providerControls?: HostControllerDependencies['listProviderControls']
  #sessionAction?: HostControllerDependencies['sessionAction']
  #sessionFork?: HostControllerDependencies['sessionFork']
  #sessionDelete?: HostControllerDependencies['sessionDelete']
  #toolPanels?: HostControllerDependencies['toolPanels']
  #attachmentStore?: DesktopAttachmentStore
  // Wake-up signal for long-poll watchers. Ledger events and output appends bump
  // it; a watcher always re-reads through the normal authorized readers.
  #watchers: LiveWatchers

  constructor(deps: HostControllerDependencies) {
    this.authority = new PairingAuthority(deps.pairing)
    this.#workspace = deps.workspace
    this.#fileDownloads = new RemoteFileDownloads(deps.workspace)
    this.#macRuns = deps.macRuns
    this.#readDesktop = deps.readDesktop
    this.#desktopWorkbench = deps.desktopWorkbench
    this.#desktopDirectories = deps.desktopDirectories
    this.#providerControls = deps.listProviderControls
    this.#sessionAction = deps.sessionAction
    this.#sessionFork = deps.sessionFork
    this.#sessionDelete = deps.sessionDelete
    this.#toolPanels = deps.toolPanels
    this.#ledger = new SessionLedger({ store: deps.ledgerStore, onEvent: () => this.#watchers.notify() })
    this.#attachmentStore = deps.attachmentStore ?? (deps.attachmentDirectory
      ? new DesktopAttachmentStore(deps.attachmentDirectory, (peer, id) => this.#ledger.intentRun(scopedIntentId(peer, id))?.lifecycle)
      : undefined)
    this.#output = new RunOutputLog({ store: deps.outputStore })
    this.#interactions = new RemoteInteractionBroker((runId, detail) => {
      this.#ledger.markProgress(runId, detail)
    })
    const wiring = createExecution({
      deps, authority: this.authority, ledger: this.#ledger, output: this.#output, fileDownloads: this.#fileDownloads,
      interactions: this.#interactions, stops: this.#stops, live: this.#live,
      resolveAttachments: (routing) => this.#resolveAttachments(routing),
      releaseAttachments: (routing) => this.#releaseAttachments(routing),
      notify: () => this.#watchers.notify()
    })
    this.#gateway = wiring.gateway
    this.#dispatcher = wiring.dispatcher
    this.#watchers = new LiveWatchers({
      authorizeDevice: (peer) => this.authorizeDevice(peer),
      authorizedCwd: (cwd) => authorizedCwd(this.#workspace, cwd),
      ledger: this.#ledger, gateway: this.#gateway, interactions: this.#interactions,
      stops: this.#stops, live: this.#live, ...(this.#macRuns ? { macRuns: this.#macRuns } : {}),
      poll: (peer, input) => this.poll(peer, input),
      pendingQuestions: (peer, input) => this.pendingQuestions(peer, input),
      runOutput: (peer, input) => this.runOutput(peer, input)
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
    return startAttachment(this.#deps(), peer, input)
  }

  attachmentChunk(peer: string, input: unknown): Promise<{ offset: number }> {
    return chunkAttachment(this.#deps(), peer, input)
  }

  async attachmentCommit(peer: string, input: unknown): Promise<{ attachment: DesktopAttachmentReference }> {
    return await commitAttachment(this.#deps(), peer, input)
  }

  // Device-facing (inner-mTLS): submit a durable intent, then drive the
  // dispatcher so the gated executor picks it up exactly once.
  submitIntent(peerCertSHA256: string, input: { intentId: string; detail?: string }): { runId: string; status: 'recorded' | 'duplicate' } {
    return submitIntent(this.#deps(), peerCertSHA256, input)
  }

  async submitReceivedIntent(peer: string, input: { intentId: string; detail?: string }): Promise<{ runId: string; status: 'recorded' | 'duplicate' }> {
    return await submitReceivedIntent(this.#deps(), peer, input)
  }


  intentStatus(peerCertSHA256: string, input: { intentId: string }): { runId: string; state: RunLifecycle } {
    return this.#gateway.intentStatus(peerCertSHA256, input)
  }

  resolveIntent(peerCertSHA256: string, input: { intentId: string }): { runId: string; state: RunLifecycle } {
    // Do not pump a recovery fence through the submission path.
    return this.#gateway.resolveIntent(peerCertSHA256, input)
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

  answerQuestion(peerCertSHA256: string, input: AnswerInput): RemoteQuestionAnswerReceipt {
    return answerRunQuestion(this.#deps(), peerCertSHA256, input)
  }

  // Trusted Mac UI answering a question of a device-started run. Same broker as
  // the device path, so whichever side answers first settles it exactly once.
  // `response.runId` is ignored: the caller resolved the ledger runId itself.
  // false = not accepted, like the Mac broker: no longer pending (answered on the
  // device or withdrawn) or not a valid answer to that question. A ledger write
  // failure still throws.
  answerOwnerQuestion(runId: string, response: AgentQuestionResponse): boolean {
    return answerOwnerRunQuestion(this.#deps(), runId, response)
  }

  async readDesktop(peerCertSHA256: string, input: unknown): Promise<DesktopHostReadResult> {
    return await readDesktop(this.#deps(), peerCertSHA256, input)
  }

  releaseDesktopPeer(peer: string): Promise<void> { return this.#desktopWorkbench?.release(peer) ?? Promise.resolve() }

  async desktopWorkbench(peer: string, input: unknown): Promise<unknown> {
    return await readDesktopWorkbench(this.#deps(), peer, input)
  }

  // Separate from the project-scoped mobile browser. Selecting is an explicit
  // workspace grant by an authenticated owner, never a browse side effect.
  desktopDirectory(peerCertSHA256: string, input: unknown): DesktopDirectoryResult {
    return readDesktopDirectory(this.#deps(), peerCertSHA256, input)
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

  async listProvidersFull(peerCertSHA256: string): Promise<RemoteProviderRef[]> {
    return this.#gateway.listProvidersFull(peerCertSHA256)
  }

  async listProviderControls(peerCertSHA256: string, query: Extract<RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef> {
    return this.#gateway.listProviderControls(peerCertSHA256, query)
  }

  // Device-facing: Provider-native slash commands for this exact workspace.
  listCommands(peerCertSHA256: string, query: RemoteCommandQuery): Promise<RemoteCommandCatalog> {
    return this.#gateway.listCommands(peerCertSHA256, query)
  }

  // Device-facing read of one bounded tool panel. Unknown kinds and out-of-range
  // analytics windows are rejected; a missing source reports unavailable with a
  // reason instead of an empty panel that would read as "nothing happened".
  // One object satisfies every device-facing deps interface (submit, desktop
  // reads, run controls, session actions, attachments); each helper reads only
  // its own fields. `authorizeDevice` re-checks the verified peer every time.
  #deps(): SubmitDeps & DesktopReadDeps & ToolPanelDeps & RunControlDeps & SessionActionDeps & AttachmentDeps {
    return {
      authorizeDevice: (value) => this.authorizeDevice(value), toolPanels: this.#toolPanels,
      ledger: this.#ledger, gateway: this.#gateway, dispatcher: this.#dispatcher, scopedIntentId,
      attachmentStore: this.#attachmentStore, store: this.#attachmentStore,
      readDesktop: this.#readDesktop, desktopWorkbench: this.#desktopWorkbench, desktopDirectories: this.#desktopDirectories,
      providerControls: this.#providerControls !== undefined,
      canSessionActions: this.#sessionAction !== undefined,
      canSessionFork: this.#sessionFork !== undefined,
      canSessionDelete: this.#sessionDelete !== undefined,
      workspace: this.#workspace, sessionAction: this.#sessionAction, sessionFork: this.#sessionFork, sessionDelete: this.#sessionDelete,
      isRemoteRun: (runId) => isRemoteRun(this.#ledger, runId), macRun: (runId) => macRun({ ...(this.#macRuns ? { macRuns: this.#macRuns } : {}), workspace: this.#workspace }, runId, (code) => new RemoteInteractionError(code)), macRuns: this.#macRuns,
      interactions: this.#interactions, stops: this.#stops
    }
  }



  async readToolPanel(peerCertSHA256: string, input: unknown): Promise<ToolPanelPayload> {
    return await readToolPanel(this.#deps(), peerCertSHA256, input)
  }

  async sessionAction(peerCertSHA256: string, input: unknown): Promise<boolean> {
    return await runSessionAction(this.#deps(), peerCertSHA256, input)
  }

  async sessionFork(peerCertSHA256: string, input: unknown): Promise<{ externalSessionId: string }> {
    return await runSessionFork(this.#deps(), peerCertSHA256, input)
  }

  async sessionDelete(peerCertSHA256: string, input: unknown): Promise<DeleteSessionResult> {
    return await runSessionDelete(this.#deps(), peerCertSHA256, input)
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
    return stopRun(this.#deps(), peerCertSHA256, input)
  }

  async watchRun(peerCertSHA256: string, input: { runId: string; cursor: number; outputCursor: number; waitMs: number }): Promise<{ poll: ReturnType<SessionLedger['since']>; questions: AgentQuestionRequest[]; output: RunOutputPage; state: RunLifecycle | null }> {
    return await this.#watchers.watchRun(peerCertSHA256, input)
  }

  async liveRuns(peerCertSHA256: string, input: { revision?: string; waitMs: number; history?: { query: RemoteHistoryQuery; known?: string } }): Promise<{ revision: string; runs: LiveRunRef[]; historyVersion?: RemoteHistoryVersion }> {
    return await this.#watchers.liveRuns(peerCertSHA256, input)
  }

  async #resolveAttachments(routing: RemoteIntentRouting): Promise<RemoteIntentRouting> {
    return await resolveIntentAttachments(this.#attachmentStore, routing)
  }

  async #releaseAttachments(routing: RemoteIntentRouting): Promise<void> {
    await releaseIntentAttachments(this.#attachmentStore, routing)
  }



  // A Mac run the device may control: listed now and inside an authorized project.

  // Test/shutdown aid: wait for in-flight executor work to settle.
  async idle(): Promise<void> {
    await this.#dispatcher.idle()
  }
}
