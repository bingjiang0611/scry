// Types of the remote host controller: device intents, live-run views and the
// dependencies Electron main injects. Split from host-controller.ts by responsibility.
import type { DesktopDirectoryPage, DesktopDirectoryQuery, DesktopHostRead, DesktopHostReadResult, DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteProviderQuery } from '../../shared/desktop-remote'
import type { DeleteSessionResult, McpSnapshot } from '../../shared/provider'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '../../shared/llm-performance'
import type { UsageAnalytics, UsageAnalyticsRangeDays } from '../../shared/trace'
import type { AgentForkLastTurn, AgentRestartLastTurn } from '../../shared/runtime-types'
import { type PairingDependencies } from './pairing'
import { type LedgerStore } from './session-ledger'
import { type RemoteProjectRef, type RemoteDirectoryListing, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteSessionRef, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPreview, type RemoteHistoryVersion, type RemoteHistoryTurnsPage, type RemoteHistoryTurnsPageQuery } from './remote-gateway'
import { type RunOutputStore } from './run-output-log'
import { type WorkspaceAuthorizer, type RemoteRunTarget } from './remote-run-policy'
import { type RemoteSessionStatus, type RemoteSessionStatusQuery } from './remote-workspace'
import { ProviderOperationGate } from '../provider-operation-gate'
import { type AgentPermissionMode, type AgentQuestionRequest, type AgentQuestionResponse } from '../../shared/runtime'
import { DesktopAttachmentStore } from './desktop-attachments'

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
  // Edit-last-message boundaries, App submits only: validated by the App's own
  // normalizer, so the daemon never decides on its own whether a boundary is trusted.
  forkLastTurn?: AgentForkLastTurn
  restartLastTurn?: AgentRestartLastTurn
  expectedExternalSessionId?: string
  // App submits only: a conversation run whose launch the daemon holds in memory
  // (managed-launches.ts). The run id is the conversation turn's own.
  conversation?: { conversationId: string; runId: string }
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
  // Change signal for the live-runs long poll: a Mac run appears, disappears,
  // changes state or gains/loses a pending question. Without it a device waits for
  // the fallback tick, which is a cost every parked device pays.
  subscribe?(listener: () => void): () => void
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


export interface ToolPanelSources {
  analytics(rangeDays: UsageAnalyticsRangeDays): Promise<UsageAnalytics> | UsageAnalytics
  llmPerformance(): Promise<[LlmPerformanceHistory, LlmPerformanceSummary]> | [LlmPerformanceHistory, LlmPerformanceSummary]
  // Read-only: the host runs its own static scan in the Mac's current workspace
  // and reports why it could not when that is impossible. The device supplies
  // only a provider id, never a path.
  mcpTrust(query: { providerId: string }): Promise<{
    snapshot: McpSnapshot | null
    scan?: unknown
    unavailable?: string
  }>
}

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
    // Scope of the grant that submitted this run. Policy that differs by scope reads
    // this, never the transport: transport says where bytes came from, not who the
    // caller is.
    grantScope?: 'local' | 'remote'
  }): Promise<void>
  // The ledger refused a run before it reached the run start (policy, routing or
  // attachments). A daemon conversation send waits on that start, so it learns the
  // refusal here instead of waiting forever.
  onDispatchRefused?(input: { detail?: string; grantScope: 'local' | 'remote'; error: unknown }): void
  // A run's ledger events or output changed (P3f E2): the App's event feed names the
  // run so only that run re-reads. Observation only; it never fails the run.
  onRunActivity?(runId: string): void
  // Snapshot of host-authorized project directories a device may target. Absent
  // => the device sees an honest empty list (never a fabricated one).
  listProjects?(): RemoteProjectRef[]
  // Immediate child folders under an authorized project path. The source must
  // canonicalize and reject paths outside the original host grant.
  listDirectories?(path?: string): RemoteDirectoryListing
  // Metadata snapshot; it must not probe Provider controls.
  listProviders?(): RemoteProviderRef[]
  // Explicit legacy all-controls request.
  listProvidersFull?(): Promise<RemoteProviderRef[]>
  // Controls for one already-selected, authorized context.
  listProviderControls?(query: Extract<RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef>
  // Provider-native slash commands for one authorized workspace context.
  listCommands?(query: RemoteCommandQuery): Promise<RemoteCommandCatalog>
  // Host-owned session metadata writes. The callback must use the host store.
  sessionAction?(context: DesktopRemoteContext, action: DesktopRemoteSessionAction, authorize: () => void): Promise<boolean> | boolean
  sessionFork?(request: DesktopRemoteForkSessionRequest, authorize: () => void): Promise<{ externalSessionId: string }>
  sessionDelete?(request: DesktopRemoteDeleteSessionRequest, authorize: () => void, grantScope?: 'local' | 'remote'): Promise<DeleteSessionResult>
  // Read-only tool panels for the paired device. Production passes the same
  // aggregations the Mac UI shows; nothing here scans or executes.
  toolPanels?: ToolPanelSources
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
