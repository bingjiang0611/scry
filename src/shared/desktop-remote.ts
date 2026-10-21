import type { DesktopWorkbenchRequest, DesktopWorkbenchResult } from './desktop-workbench'
import type { AgentInputAttachment } from './runtime'
import type { AgentForkSessionRequest, AgentPermissionMode, AgentQuestionResponse } from './runtime'
import type { DeleteSessionResult } from './provider'
import type { ActiveRun } from './trace'
import type { LoadedSessionTurn } from './session-history'
import type { WorkspaceFilePage, WorkspaceListResult } from './workspace'

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
}
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
}
export type DesktopRemoteSessionAction =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive'; archived: boolean }

// SSH coordinates are independent of the pinned Scry host identity. The first
// desktop version deliberately accepts no SSH config aliases or arbitrary flags.
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
  // A cached Provider picker is not a current authentication/capability proof.
  providerEvidence: 'host_snapshot'
  // Absent on older hosts; never imply that arbitrary directory selection works.
  directorySelection?: true
  workbench?: 1
  sessionActions?: true
  // Fork and delete are independent because an older host may implement only one.
  sessionFork?: true
  sessionDelete?: true
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
// Oversized history pages are transferred losslessly in bounded byte chunks.
// The assembled page is capped separately from the 4 MiB wire response limit.
export const DESKTOP_HISTORY_CHUNK_BYTES = 512 * 1024
export const DESKTOP_HISTORY_MAX_BYTES = 32 * 1024 * 1024

export type DesktopHostRead =
  | { kind: 'info' }
  | { kind: 'history'; context: DesktopRemoteContext; historyScope?: 'session'; before?: number; snapshot?: string; byteChunks?: true; images?: true; chunk?: { id: string; offset: number } }
  | { kind: 'trace'; context: DesktopRemoteContext; runId: string; images?: true }
  | { kind: 'image'; context: DesktopRemoteContext; historyScope?: 'session'; runId: string; providerTurnId?: string; index: number; chunk?: { id: string; offset: number } }
export type DesktopHostReadResult =
  | { kind: 'info'; protocol: 1; hostId: string; execution: 'canonical'; directorySelection?: true; workbench?: 1; sessionActions?: true; sessionFork?: true; sessionDelete?: true; attachments?: DesktopRemoteAttachmentCapability }
  | { kind: 'history'; history: DesktopRemoteHistory }
  | { kind: 'history_chunk'; id: string; offset: number; totalBytes: number; data: string }
  | { kind: 'trace'; run: ActiveRun | null; imageCount?: number }
  | { kind: 'image_chunk'; id: string; offset: number; totalBytes: number; data: string; name: string; mimeType: AgentInputAttachment['mimeType']; historyScope?: 'session' }

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
}
// Durable receipt: recorded is not executed, and unknown must never be retried
// with a fresh intent id. The main process owns the id and pending receipt.
export interface DesktopRemoteIntentOrigin {
  phonePeerFingerprint: string
  phoneIntentId: string
  targetBinding: string
  payloadHash: string
}
export interface DesktopRemoteIntent {
  // This is the stable downstream intent key. Phone-originated receipts keep
  // their upstream identity separately so the desktop submit path remains
  // idempotent without exposing a second local execution ledger.
  intentId: string
  connectionId: string
  context: DesktopRemoteContext
  createdAt: number
  status: 'recorded' | 'unknown'
  runId?: string
  origin?: DesktopRemoteIntentOrigin
}
export interface DesktopRemoteRunStatus {
  state: 'recorded' | 'dispatched' | 'settled' | 'failed' | 'unknown'
  scryRunId?: string
  externalSessionId?: string
  detail?: string
}
export interface ExecutionTargetRef {
  id: string
  binding: string
  hostId: string
  label: string
  state: 'connected' | 'disconnected'
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
  mobileRequest(target: { id: string; binding: string }, request: Record<string, unknown>, authorizePeer?: () => void): Promise<unknown>
  mobileSubmit(input: DesktopMobileTargetSubmit & { authorizePeer?: () => void }): Promise<unknown>
  mobileIntentStatus(input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string; authorizePeer?: () => void }): Promise<unknown>
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
  commands(connectionId: string, context: DesktopRemoteContext): Promise<RemoteCommandCatalog>
  sessionAction(connectionId: string, context: DesktopRemoteContext, action: DesktopRemoteSessionAction): Promise<boolean>
  forkSession(connectionId: string, request: DesktopRemoteForkSessionRequest): Promise<{ externalSessionId: string }>
  deleteSession(connectionId: string, request: DesktopRemoteDeleteSessionRequest): Promise<DeleteSessionResult>
  directories(connectionId: string, path?: string, cursor?: number, snapshot?: string): Promise<DesktopDirectoryPage>
  selectDirectory(connectionId: string, path: string): Promise<RemoteProjectRef>
  history(connectionId: string, context: DesktopRemoteContext, before?: number, snapshot?: string): Promise<DesktopRemoteHistory>
  trace(connectionId: string, context: DesktopRemoteContext, runId: string, knownAttachmentCount?: number): Promise<ActiveRun | null>
  intents(connectionId: string): Promise<DesktopRemoteIntent[]>
  submit(connectionId: string, input: DesktopRemoteSubmit): Promise<DesktopRemoteIntent>
  intentStatus(connectionId: string, intentId: string): Promise<DesktopRemoteIntent>
  runStatus(connectionId: string, runId: string): Promise<DesktopRemoteRunStatus>
  stop(connectionId: string, runId: string): Promise<void>
  answer(connectionId: string, runId: string, response: AgentQuestionResponse): Promise<void>
  files(connectionId: string, context: DesktopRemoteContext, path: string, cursor?: string): Promise<WorkspaceListResult>
  file(connectionId: string, context: DesktopRemoteContext, path: string, offset?: number, snapshot?: string): Promise<WorkspaceFilePage>
}
