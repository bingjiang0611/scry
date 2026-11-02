import type { Conversation, ConversationBinding, ConversationDeletionResult, ConversationContinuation, ConversationDelivery, ConversationItemRef, ConversationTarget, SideChatInitialTarget, SideChatSnapshotItem, SideChatSource } from './conversation'
import type { LoadedSessionTurn } from './session-history'
import type { AgentStartRequest } from './runtime'
import type { ProviderId } from './provider'

/** Bounded side-chat provenance for summaries and lists; bodies stay in the sealed snapshot. */
export interface SideChatSummary {
  source: SideChatSource
  parentTitleAtCapture: string
  initialTarget: SideChatInitialTarget
  throughOrdinal: number
  throughRunId: string
  capturedAt: number
  prefixFingerprint: string
  messageCount: number
}

export interface SideChatSnapshotPage extends SideChatSummary {
  /**
   * Legacy format 3 metadata list. A format 4 snapshot carries its items in a bounded
   * manifest instead, so the page reports only `messageCount` and the viewer reads
   * bodies page by page.
   */
  items?: SideChatSnapshotItem[]
}

/**
 * One frozen message body inside a bounded page. `continuation` appears when a single
 * message is larger than the page budget: the rest is an explicit next page, never a
 * silently truncated body.
 */
export interface SideChatSnapshotBodyItem {
  ref: ConversationItemRef
  role: 'user' | 'assistant'
  providerId: ProviderId
  sourceOrdinal: number
  text: string
  continuation?: true
}

/** Real frozen text for at most `SIDE_CHAT_BODY_PAGE_ITEMS` messages per read. */
export interface SideChatSnapshotBodyPage {
  conversationId: string
  items: SideChatSnapshotBodyItem[]
  /** Absent on the last page. Encodes message index and offset inside that message. */
  nextCursor?: string
  byteLimit: number
}

/**
 * One frozen prefix measured against the same handoff budget the first send uses.
 * `inline` items travel in the request; `retrievable` items are only reachable
 * through the Provider's verified history reader and are never claimed as sent.
 */
export interface SideChatCoverage {
  messageCount: number
  inlineCount: number
  retrievableCount: number
  readerAvailable: boolean
  handoffBudgetBytes: number
  /** Byte size of the exact sealed artifact, measured before publication. */
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
  /** Latest dispatched turn only; imported history has no inferred outcome. */
  lastRunOutcome?: import('./turn-record').AgentTurnRecord['status']
  fork?: Pick<NonNullable<Conversation['fork']>, 'sourceConversationId' | 'sourceRunId' | 'bindingId' | 'status' | 'reason'>
  sideChat?: SideChatSummary
  blockedReason?: string
}

export interface ConversationPage {
  summary: ConversationSummary
  bindings: ConversationBinding[]
  /** Frozen source snapshot of a side chat; absent for ordinary conversations. */
  sideChat?: SideChatSnapshotPage
  turns: Array<{
    ordinal: number
    runId: string
    bindingId: string
    providerId: ProviderId
    /** Dispatch command this turn published; absent for imported prefix turns. */
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
  /** Read-only recovery after a committed adoption whose IPC reply was lost. */
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

export interface ConversationDeletionPreview {
  reclaim?: true
  conversationId: string
  revision: number
  fingerprint: string
  targets: ConversationDeletionTarget[]
}

/**
 * Read-only preview of the exact frozen prefix. Creation re-reads the same prefix
 * and refuses if either fingerprint changed; the source may keep appending after it.
 */
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
  /** Smallest captured prefix the user can choose instead of this one. */
  smallestThroughOrdinal: number
  /** Real current-build limitation; creation stays local and never fakes a handoff. */
  firstSendBlockedReason?: string
}

/** Optional explicit snapshot boundary and first-send target offered by the preview UI. */
export interface SideChatPreviewOptions {
  completedThroughOrdinal?: number
  initialTarget?: SideChatInitialTarget
}

/** Local-only creation. No Provider call happens until the first send. */
export interface ConversationSideChatRequest {
  source: SideChatSource
  expectedThroughOrdinal: number
  expectedThroughRunId: string
  expectedPrefixFingerprint: string
  expectedManifestFingerprint: string
  commandId: string
  initialTarget?: SideChatInitialTarget
}

/**
 * Cursor is `capturedAt:id` of the last child of the previous page.
 *
 * `ids` is the narrow selected-id lookup a restored layout uses to validate at most
 * eight open tabs without reading a child transcript. It is a summary read inside the
 * same source membership check, never a second listing.
 */
export interface SideChatListRequest {
  source: SideChatSource
  cursor?: string
  limit?: number
  ids?: string[]
}

export interface SideChatList {
  /** Children of this source; with `ids` it counts the requested matches only. */
  total: number
  items: ConversationSummary[]
  /** Absent on the last page; a deleted child never creates a gap. */
  nextCursor?: string
}

/**
 * Read-only receipt for one side-chat creation command. Creation runs only when the
 * user explicitly asks again; this lookup never creates, adopts or contacts a Provider.
 * `not-found` is not proof that the command was never dispatched.
 */
export type SideChatCommandReceipt =
  | { commandId: string; status: 'found'; conversation: ConversationSummary }
  | { commandId: string; status: 'not-found' }

/** Only these typed operations cross the preload boundary; runtime callbacks stay in main. */
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
  readSideChatSnapshot(id: string, cursor?: string): Promise<SideChatSnapshotBodyPage>
  readItem(id: string, ref: ConversationItemRef): Promise<string>
  preview(id: string, target: ConversationTargetRequest): Promise<ConversationPreview>
  send(request: ConversationSendRequest): Promise<{ runId: string; disposition: 'created' | 'duplicate' }>
}
