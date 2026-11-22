import type { Conversation, ConversationBinding, ConversationDeletionResult, ConversationContinuation, ConversationDelivery, ConversationItemRef, ConversationTarget, SideChatInitialTarget, SideChatSnapshotItem, SideChatSource } from './conversation'
import type { LoadedSessionTurn } from './session-history'
import type { AgentStartRequest } from './runtime'
import type { ProviderId } from './provider'

export interface SideChatSummary {
  source: SideChatSource
  parentTitleAtCapture: string
  initialTarget: SideChatInitialTarget
  throughOrdinal: number
  throughRunId: string
  capturedAt: number
  prefixFingerprint: string
  messageCount: number
  parentConversationId?: string
}

export interface SideChatSnapshotPage extends SideChatSummary {
  items?: SideChatSnapshotItem[]
}

export interface SideChatSnapshotBodyItem {
  ref: ConversationItemRef
  role: 'user' | 'assistant'
  providerId: ProviderId
  sourceOrdinal: number
  text: string
  continuation?: true
}

export interface SideChatSnapshotBodyPage {
  conversationId: string
  items: SideChatSnapshotBodyItem[]
  nextCursor?: string
  byteLimit: number
}

export interface SideChatCoverage {
  messageCount: number
  inlineCount: number
  retrievableCount: number
  readerAvailable: boolean
  handoffBudgetBytes: number
  snapshotBytes: number
  snapshotByteLimit: number
}

export interface ConversationSummary {
  id: string
  cwd: string
  title: string
  revision: number
  turnCount: number
  pinnedAt?: number
  archivedAt?: number
  deletion?: Conversation['deletion']
  activeRunId?: string
  lastRunOutcome?: import('./turn-record').AgentTurnRecord['status']
  fork?: Pick<NonNullable<Conversation['fork']>, 'sourceConversationId' | 'sourceRunId' | 'bindingId' | 'status' | 'reason'>
  sideChat?: SideChatSummary
  blockedReason?: string
}

export interface ConversationPage {
  summary: ConversationSummary
  bindings: ConversationBinding[]
  sideChat?: SideChatSnapshotPage
  turns: Array<{
    ordinal: number
    runId: string
    bindingId: string
    providerId: ProviderId
    commandId?: string
    delivery: ConversationDelivery | { status: 'imported' }
    history?: LoadedSessionTurn
    unavailableReason?: string
  }>
  nextBeforeOrdinal?: number
}

export interface ConversationPreview {
  conversationId: string
  revision: number
  target: ConversationTarget
  continuation: ConversationContinuation
  missingItems: Array<{
    ref: ConversationItemRef
    ordinal: number
    providerId: ProviderId
    role: 'user' | 'assistant'
  }>
}

export type ConversationTargetRequest = Pick<AgentStartRequest, 'model' | 'effort' | 'permissionMode'> & {
  providerId: ProviderId
  agentProfileId?: string
}

export interface ConversationForkRequest {
  conversationId: string
  expectedRevision: number
  sourceRunId: string
  commandId: string
  permissionMode?: AgentStartRequest['permissionMode']
}

export interface ConversationSendRequest extends ConversationTargetRequest {
  conversationId: string
  expectedRevision: number
  expectedContinuationKey: string
  commandId: string
  prompt: string
  attachments?: AgentStartRequest['attachments']
  selectedItems: ConversationItemRef[]
  confirmFresh: boolean
}

export type ConversationMetadataChange =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive'; archived: boolean }

export interface ConversationLegacySource {
  providerId: 'claude' | 'codex' | 'pi'
  agentProfileId?: string
  cwd: string
  externalSessionId: string
}

export interface ConversationAdoptionPreview {
  adoptedConversation?: ConversationSummary
  source: ConversationLegacySource
  fingerprint: string
  title: string
  turnCount: number
}

export interface ConversationDeletionTarget {
  providerId: ProviderId
  agentProfileId?: string
  externalSessionId: string
  runIds: string[]
  sharedWith: string[]
}

export interface SideChatDeletionPreview {
  conversationId: string
  title: string
  revision: number
  fingerprint: string
  targets: ConversationDeletionTarget[]
}

export interface ConversationDeletionPreview {
  reclaim?: true
  conversationId: string
  revision: number
  fingerprint: string
  targets: ConversationDeletionTarget[]
  sideChats?: SideChatDeletionPreview[]
}

export interface SideChatPreview {
  source: SideChatSource
  title: string
  throughOrdinal: number
  throughRunId: string
  prefixFingerprint: string
  manifestFingerprint: string
  messageCount: number
  bodyBytes: number
  target: SideChatInitialTarget
  coverage: SideChatCoverage
  smallestThroughOrdinal: number
  firstSendBlockedReason?: string
}

export interface SideChatPreviewOptions {
  terminalThroughOrdinal?: number
  initialTarget?: SideChatInitialTarget
}

export interface ConversationSideChatRequest {
  source: SideChatSource
  expectedThroughOrdinal: number
  expectedThroughRunId: string
  expectedPrefixFingerprint: string
  expectedManifestFingerprint: string
  commandId: string
  initialTarget?: SideChatInitialTarget
}

export interface SideChatListRequest {
  source: SideChatSource
  cursor?: string
  limit?: number
  ids?: string[]
}

export interface SideChatList {
  total: number
  items: ConversationSummary[]
  nextCursor?: string
}

export type SideChatCommandReceipt =
  | { commandId: string; status: 'found'; conversation: ConversationSummary }
  | { commandId: string; status: 'in-flight' }
  | { commandId: string; status: 'not-found' }

export type ConversationSendResult =
  | { status: 'accepted'; runId: string; disposition: 'created' | 'duplicate' }
  | { status: 'not_sent'; reason: string }

export interface ConversationApi {
  create(cwd: string): Promise<ConversationSummary>
  fork(request: ConversationForkRequest): Promise<ConversationSummary>
  previewAdoption(source: ConversationLegacySource, target?: ConversationTargetRequest): Promise<ConversationAdoptionPreview>
  adopt(source: ConversationLegacySource, fingerprint: string): Promise<ConversationSummary>
  previewDeletion(id: string): Promise<ConversationDeletionPreview>
  delete(id: string, fingerprint: string): Promise<ConversationDeletionResult>
  previewSideChat(source: SideChatSource, options?: SideChatPreviewOptions): Promise<SideChatPreview>
  createSideChat(request: ConversationSideChatRequest): Promise<ConversationSummary>
  listSideChats(request: SideChatListRequest): Promise<SideChatList>
  findSideChatCommand(source: SideChatSource, commandId: string): Promise<SideChatCommandReceipt>
  update(id: string, expectedRevision: number, change: ConversationMetadataChange): Promise<ConversationSummary>
  list(cwd: string): Promise<ConversationSummary[]>
  read(id: string, beforeOrdinal?: number): Promise<ConversationPage>
  setViewed(id: string | null): Promise<void>
  readSideChatSnapshot(id: string, cursor?: string): Promise<SideChatSnapshotBodyPage>
  readItem(id: string, ref: ConversationItemRef): Promise<string>
  preview(id: string, target: ConversationTargetRequest): Promise<ConversationPreview>
  send(request: ConversationSendRequest): Promise<ConversationSendResult>
}
