import type { DesktopWorkbenchRequest, DesktopWorkbenchResult } from './desktop-workbench'
import type { AgentInputAttachment } from './runtime'
import type { AgentForkSessionRequest, AgentPermissionMode, AgentQuestionResponse } from './runtime'
import type { DeleteSessionResult } from './provider'
import type { ActiveRun, TraceEvent } from './trace'
import type { LoadedSessionTurn } from './session-history'
import type { WorkspaceFilePage, WorkspaceListResult } from './workspace'
import type { ScRead } from './source-control'
import type { WorkspaceChoices, WorkspaceChoicesRequest, WorkspacePrepareProgress, WorkspaceStartSelection } from './workspace-selection'
import type { HostAdminNotice } from './host-admin'

export interface RemoteProjectRef { path: string; label: string }
export interface DesktopDirectoryPage {
  current: RemoteProjectRef
  parent?: RemoteProjectRef
  directories: RemoteProjectRef[]
  cursor: number
  total: number
  hasMore: boolean
  snapshot: string
}
export type DesktopDirectoryQuery =
  | { action: 'list'; path?: string; cursor?: number; snapshot?: string }
  | { action: 'select'; path: string }
export type DesktopDirectoryResult =
  | { action: 'list'; page: DesktopDirectoryPage }
  | { action: 'select'; project: RemoteProjectRef }
export interface RemoteControlOption { id: string; label: string; description?: string; isDefault?: boolean }
export interface RemoteModelOption {
  id: string
  providerId?: string
  label: string
  description?: string
  isDefault?: boolean
  efforts?: RemoteControlOption[]
}
export interface RemoteProviderRef {
  id: string
  label: string
  available: boolean
  agentProfileId?: string
  modelId?: string
  models?: RemoteModelOption[]
  efforts?: RemoteControlOption[]
  permissions?: RemoteControlOption[]
  forkSession?: true
  observedAt?: number
  metadataRevision?: number
}
export function isRemoteProviderObservationTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime())
}
export type RemoteProviderQuery =
  | { detail: 'metadata' }
  | { detail: 'selected'; providerId: string; cwd: string; agentProfileId?: string }
export interface RemoteCommandRef {
  name: string
  description: string
  argumentHint?: string
  source?: 'builtin' | 'skill' | 'mcp' | 'custom'
}
export interface RemoteCommandCatalog {
  commands: RemoteCommandRef[]
  reason?: string
}
export interface RemoteSessionRef {
  sessionId: string
  externalSessionId?: string
  providerId: string
  agentProfileId?: string
  cwd: string
  label: string
  ts: number
  pinnedAt?: number
  archivedAt?: number
  isActive?: boolean
  pendingQuestions?: number
  lastRunId?: string
  lastRunOutcome?: import('./turn-record').AgentTurnRecord['status']
}
export function isRemoteSessionOutcome(value: unknown): value is NonNullable<RemoteSessionRef['lastRunOutcome']> {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted'
}

export type DesktopRemoteSessionAction =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive'; archived: boolean }

export interface DesktopSshTarget { hostname: string; username: string; port: number }
export interface DesktopHostInvitation {
  version: 1
  hostId: string
  anchorPEM: string
  pairPort: number
  runPort: number
  pairingId: string
  secret: string
  expiresAt: number
}
export type DesktopHostAccess =
  | { enabled: true; pairPort: number; runPort: number }
  | { enabled: false; reason?: string }
export interface DesktopRemoteConnection {
  id: string
  label: string
  hostId: string
  anchorSHA256: string
  ssh: DesktopSshTarget
  state: 'disconnected' | 'connected' | 'pairing'
  subscribe?: 1
  expiresAt: number
}
export interface DesktopPairingResult {
  connection: DesktopRemoteConnection
  publicKeySHA256: string
  state: 'pending' | 'paired'
}
export interface DesktopRemoteContext {
  cwd: string
  providerId: string
  agentProfileId?: string
  externalSessionId?: string
}
export interface DesktopRemoteAttachmentCapability {
  transport: 'chunked'
  maxBytes: number
  maxTotalBytes: number
  maxCount: number
  chunkBytes: number
}
export interface DesktopRemoteCatalog {
  projects: RemoteProjectRef[]
  providers: RemoteProviderRef[]
  sessions: RemoteSessionRef[]
  attachments?: DesktopRemoteAttachmentCapability
  providerEvidence: 'host_snapshot' | 'legacy_host'
  providerDiscovery?: 2
  managedWorktrees?: 1
  directorySelection?: true
  workbench?: 1
  workbenchOps?: { openPath: boolean; trashItem: boolean }
  sessionActions?: true
  sessionFork?: true
  sessionDelete?: true
  traceDelta?: 1
  hostAdminNotices?: 1
  // P8: the host can answer the read-only machine summary. Absent => 「请升级」.
  hostMetrics?: 1
  subscribe?: 1
  hostAdminNoticeItems?: HostAdminNotice[]
  unreadSessionKeys?: string[]
}
export interface DesktopRemoteUpdate {
  connectionId: string
  catalog?: DesktopRemoteCatalog
  runs?: true
  history?: true
  stale?: true
}

export interface DesktopRemoteHistory {
  historyScope?: 'session'
  imageCounts?: Record<string, number>
  turns: LoadedSessionTurn[]
  hasOlder: boolean
  before?: number
  snapshot?: string
  source: 'trace_archive'
  status: 'available' | 'unavailable'
  reason?: string
}
export const DESKTOP_HISTORY_CHUNK_BYTES = 512 * 1024
export const DESKTOP_HISTORY_MAX_BYTES = 512 * 1024 * 1024

export const REMOTE_PROTOCOL_VERSION = 3

export type DesktopHostRead =
  | { kind: 'info' }
  | { kind: 'workspaceChoices'; request: WorkspaceChoicesRequest }
  | { kind: 'validateWorkspaceBranch'; request: { cwd: string; repositoryId: string; name: string } }
  | { kind: 'history'; context: DesktopRemoteContext; historyScope?: 'session'; before?: number; snapshot?: string; byteChunks?: true; images?: true; chunk?: { id: string; offset: number } }
  | { kind: 'trace'; context: DesktopRemoteContext; runId: string; images?: true; delta?: { after?: DesktopTraceCursor }; byteChunks?: true; chunk?: { id: string; offset: number }; archive?: true }
  | { kind: 'image'; context: DesktopRemoteContext; historyScope?: 'session'; runId: string; providerTurnId?: string; index: number; chunk?: { id: string; offset: number } }
export type DesktopHostReadResult =
  | { kind: 'info'; protocol: number; hostId: string; execution: 'canonical'; providerDiscovery?: 2; managedWorktrees?: 1; directorySelection?: true; workbench?: 1; workbenchOps?: { openPath: boolean; trashItem: boolean }; sessionActions?: true; sessionFork?: true; sessionDelete?: true; traceDelta?: 1; hostAdminNotices?: 1; hostMetrics?: 1; subscribe?: 1; attachments?: DesktopRemoteAttachmentCapability }
  | { kind: 'workspaceChoices'; value: ScRead<WorkspaceChoices> }
  | { kind: 'validateWorkspaceBranch'; value: ScRead<{ name: string }> }
  | { kind: 'history'; history: DesktopRemoteHistory }
  | { kind: 'history_chunk'; id: string; offset: number; totalBytes: number; data: string }
  | { kind: 'trace'; run: ActiveRun | null; imageCount?: number; revision?: string; reset?: true }
  | { kind: 'trace_delta'; run: DesktopTraceRunMeta; imageCount?: number; base: string; revision: string; count: number; changes: DesktopTraceChange[] }
  | { kind: 'image_chunk'; id: string; offset: number; totalBytes: number; data: string; name: string; mimeType: AgentInputAttachment['mimeType']; historyScope?: 'session' }

export interface DesktopTraceCursor { revision: string; count: number }
export interface DesktopTraceChange { index: number; item: TraceEvent }
export type DesktopTraceRunMeta = Omit<ActiveRun, 'items'>
export type DesktopRemoteTraceRead =
  | { kind: 'snapshot'; run: ActiveRun | null; cursor?: DesktopTraceCursor }
  | { kind: 'delta'; run: DesktopTraceRunMeta; base: string; cursor: DesktopTraceCursor; changes: DesktopTraceChange[] }

export type DesktopRemoteForkSessionRequest = AgentForkSessionRequest
export interface DesktopRemoteDeleteSessionRequest {
  providerId: string
  agentProfileId?: string
  cwd: string
  externalSessionId: string
  confirmed: true
}

export interface DesktopRemoteSubmit {
  context: DesktopRemoteContext
  prompt: string
  attachments?: AgentInputAttachment[]
  modelId?: string
  modelProviderId?: string
  effort?: string
  permissionMode?: AgentPermissionMode
  workspace?: WorkspaceStartSelection
}
export interface DesktopRemoteIntentOrigin {
  phonePeerFingerprint: string
  phoneIntentId: string
  targetBinding: string
  payloadHash: string
}
export interface DesktopRemoteIntent {
  intentId: string
  connectionId: string
  context: DesktopRemoteContext
  createdAt: number
  status: 'recorded' | 'unknown'
  runId?: string
  failure?: string
  origin?: DesktopRemoteIntentOrigin
}
export interface DesktopRemoteRunStatus {
  state: 'recorded' | 'dispatched' | 'settled' | 'failed' | 'unknown'
  scryRunId?: string
  outputSeq?: number
  externalSessionId?: string
  cwd?: string
  detail?: string
  workspaceProgress?: WorkspacePrepareProgress
  changed?: boolean
}
export interface DesktopRemoteLiveRun {
  runId: string
  origin: 'remote' | 'mac'
  state: 'running' | 'waiting' | 'stopping'
  scryRunId?: string
  outputSeq?: number
}
export interface ExecutionTargetRef {
  id: string
  binding: string
  hostId: string
  label: string
  state: 'connected' | 'disconnected'
  subscribe?: 1
}
export interface DesktopMobileTargetSubmit {
  target: { id: string; binding: string }
  phonePeerFingerprint: string
  phoneIntentId: string
  payloadHash: string
  request: Record<string, unknown>
}
export interface DesktopRemoteTargetAPI {
  executionTargets(): Promise<ExecutionTargetRef[]>
  mobileRequest(target: { id: string; binding: string }, request: Record<string, unknown>, authorizePeer?: () => void, signal?: AbortSignal): Promise<unknown>
  mobileSubmit(input: DesktopMobileTargetSubmit & { authorizePeer?: () => void }): Promise<unknown>
  mobileIntentStatus(input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string; knownLogId?: string; authorizePeer?: () => void }): Promise<unknown>
}
export interface DesktopRemoteAPI {
  workbench<Request extends DesktopWorkbenchRequest>(connectionId: string, request: Request): Promise<DesktopWorkbenchResult<Request>>
  list(): Promise<DesktopRemoteConnection[]>
  pair(input: { label: string; ssh: DesktopSshTarget; invitation: string }): Promise<DesktopPairingResult>
  finishPairing(connectionId: string): Promise<DesktopPairingResult>
  updateSsh(connectionId: string, ssh: DesktopSshTarget): Promise<void>
  connect(connectionId: string): Promise<void>
  disconnect(connectionId: string): Promise<void>
  forget(connectionId: string): Promise<void>
  catalog(connectionId: string): Promise<DesktopRemoteCatalog>
  setViewedSession(connectionId: string, context: DesktopRemoteContext | null): Promise<void>
  providerControls(connectionId: string, context: DesktopRemoteContext): Promise<RemoteProviderRef>
  commands(connectionId: string, context: DesktopRemoteContext): Promise<RemoteCommandCatalog>
  workspaceChoices(connectionId: string, request: WorkspaceChoicesRequest): Promise<ScRead<WorkspaceChoices>>
  validateWorkspaceBranch(connectionId: string, request: { cwd: string; repositoryId: string; name: string }): Promise<ScRead<{ name: string }>>
  sessionAction(connectionId: string, context: DesktopRemoteContext, action: DesktopRemoteSessionAction): Promise<boolean>
  forkSession(connectionId: string, request: DesktopRemoteForkSessionRequest): Promise<{ externalSessionId: string }>
  deleteSession(connectionId: string, request: DesktopRemoteDeleteSessionRequest): Promise<DeleteSessionResult>
  directories(connectionId: string, path?: string, cursor?: number, snapshot?: string): Promise<DesktopDirectoryPage>
  selectDirectory(connectionId: string, path: string): Promise<RemoteProjectRef>
  history(connectionId: string, context: DesktopRemoteContext, before?: number, snapshot?: string): Promise<DesktopRemoteHistory>
  trace(connectionId: string, context: DesktopRemoteContext, runId: string, knownAttachmentCount?: number): Promise<ActiveRun | null>
  traceDelta(connectionId: string, context: DesktopRemoteContext, runId: string, after?: DesktopTraceCursor, knownAttachmentCount?: number): Promise<DesktopRemoteTraceRead>
  intents(connectionId: string): Promise<DesktopRemoteIntent[]>
  submit(connectionId: string, input: DesktopRemoteSubmit): Promise<DesktopRemoteIntent>
  intentStatus(connectionId: string, intentId: string): Promise<DesktopRemoteIntent>
  resolveIntent(connectionId: string, intentId: string): Promise<DesktopRemoteIntent>
  runStatus(connectionId: string, runId: string): Promise<DesktopRemoteRunStatus>
  liveRun(connectionId: string, context: DesktopRemoteContext): Promise<DesktopRemoteLiveRun | null>
  stop(connectionId: string, runId: string): Promise<void>
  answer(connectionId: string, runId: string, response: AgentQuestionResponse): Promise<void>
  // P8 machine management: the target's own resource summary (remote scope only).
  hostMetrics(connectionId: string): Promise<import('./host-metrics').HostMetricsSnapshot>
  files(connectionId: string, context: DesktopRemoteContext, path: string, cursor?: string): Promise<WorkspaceListResult>
  file(connectionId: string, context: DesktopRemoteContext, path: string, offset?: number, snapshot?: string): Promise<WorkspaceFilePage>
}
