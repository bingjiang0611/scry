import type { DeleteSessionResult, ProviderId } from './provider'
import type { AgentStartRequest } from './runtime'
import type { AgentTurnRecord } from './turn-record'
import type { ContentRef } from './tool-content'
import type { ManifestRef } from './content-manifest'

/** Explicit App archive location; not inferred from a Provider's native identity. */
export interface ConversationArchiveRef {
  sessionId: string
  providerTurnId?: string
}

/** A Scry conversation is not a Provider's native session or a transport process. */
export interface ConversationTarget {
  providerId: ProviderId
  agentProfileId?: string
  /** Main/adapter-owned compatibility identity; never inferred from the display name. */
  continuationKey: string
}

export interface ConversationBinding extends ConversationTarget {
  id: string
  nativeSessionId?: string
  /** Forked timelines may reference shared archives without owning their native sessions. */
  historyOnly?: true
  /** Explicitly retired generations remain in history but can never be selected for resume. */
  retiredReason?: string
}

/** References immutable, visible historical content, not reasoning or tool protocol state. */
export interface ConversationItemRef {
  runId: string
  itemId: string
  contentHash: string
}

/** Default label of a side chat whose own title is still unset; never the source title. */
export const SIDE_CHAT_DEFAULT_TITLE = '侧边会话'

/**
 * A side chat reads a source conversation or a verified native session prefix.
 * Neither kind transfers ownership, resume identity or native control of the source.
 */
export type SideChatSource =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'native-session'; providerId: ProviderId; agentProfileId?: string; cwd: string; nativeSessionId: string }

/** Bounded provenance for one frozen source message; bodies live in the sealed snapshot content. */
export interface SideChatSnapshotItem {
  ref: ConversationItemRef
  /** Source turn ordinal at capture time, not an ordinal in this child conversation. */
  sourceOrdinal: number
  providerId: ProviderId
  role: 'user' | 'assistant'
}

interface SideChatSnapshotBase {
  id: string
  prefixFingerprint: string
  throughOrdinal: number
  throughRunId: string
  capturedAt: number
}

/**
 * Legacy format 3: one sealed JSON artifact holding every message, read whole.
 *
 * Only records written before format 4 are expected to carry this shape; new snapshots
 * use the manifest so that item count and body size stop deciding whether creation works.
 */
export interface SideChatSnapshotArtifact extends SideChatSnapshotBase {
  format?: 3
  /** Complete text sealed under this child's own content root; never a source archive path. */
  content: ContentRef
  /** Ordered metadata cross-checked against the sealed bodies on every read. */
  items: SideChatSnapshotItem[]
}

/** Format 4: bounded manifest tree, descriptor-only record. */
export interface SideChatSnapshotManifest extends SideChatSnapshotBase {
  format: 4
  messageCount: number
  bodyBytes: number
  items: ManifestRef
}

/** Immutable, child-owned record of the frozen source prefix. */
export type SideChatSnapshot = SideChatSnapshotArtifact | SideChatSnapshotManifest

/**
 * Requested first runtime choice for a new side chat, copied from the user's
 * current controls. It is an intent, not evidence of the source session's own
 * model, account or permission; send revalidates everything against the live
 * runtime.
 */
export type SideChatInitialTarget = Pick<AgentStartRequest, 'model' | 'effort' | 'permissionMode'> & {
  providerId: ProviderId
  agentProfileId?: string
}

export interface SideChatOrigin {
  source: SideChatSource
  parentTitleAtCapture: string
  /** Survives restart so the source's provenance still seeds the composer. */
  initialTarget: SideChatInitialTarget
  snapshot: SideChatSnapshot
  /** Creation receipt: one local command may publish at most one child. */
  commandId: string
  intentHash: string
}

export type ConversationDelivery =
  | { status: 'pending' }
  | { status: 'unknown'; reason: string }
  | { status: 'not_sent'; reason: string }
  | {
      status: 'accepted'
      nativeSessionId: string
      outcome: AgentTurnRecord['status']
      /** Proven native delivery/output, not a guarantee of retention after native compaction. */
      nativeItems: ConversationItemRef[]
    }

interface ConversationTurnBase {
  ordinal: number
  runId: string
  bindingId: string
  /** Canonical content references; the archive remains the authority for bodies and usage. */
  items: ConversationItemRef[]
  /** May be unavailable after an archive failure; such bodies cannot be handed off. */
  archive?: ConversationArchiveRef
}

export interface ImportedConversationTurn extends ConversationTurnBase {
  origin: 'imported'
  /** Verified native coverage, not an assumption that every Scry event reached the model. */
  nativeItems: ConversationItemRef[]
}

export interface DispatchedConversationTurn extends ConversationTurnBase {
  origin: 'dispatch'
  commandId: string
  intentHash: string
  resumeSessionId: string | null
  /** Exact selection, not a high-watermark pretending that omitted items were delivered. */
  importedItems: ConversationItemRef[]
  /** Omitted items that are not a contiguous frozen snapshot range. */
  omittedItems: ConversationItemRef[]
  /**
   * Omitted frozen snapshot positions, inclusive. A large child omits thousands of
   * items; recording the ranges keeps the conversation record small instead of
   * repeating one reference per message, and the manifest still holds the exact items.
   */
  omittedRanges?: OmittedItemRange[]
  /** New dispatches require a bootstrap artifact even when every item is omitted. */
  historyPolicy?: 'retrievable-v1'
  /** Immutable body published before this intent. */
  history?: ContentRef
  delivery: ConversationDelivery
}

export interface OmittedItemRange {
  snapshotId: string
  from: number
  to: number
}

export type ConversationTurn = ImportedConversationTurn | DispatchedConversationTurn

export interface ConversationDeletionResult extends Omit<DeleteSessionResult, 'deleted'> {
  /** Scoped store names across multiple native bindings, plus the private handoff cache. */
  deleted: string[]
}

export interface ConversationFork {
  commandId: string
  intentHash: string
  sourceConversationId: string
  sourceRevision: number
  sourceRunId: string
  sourceBindingId: string
  bindingId: string
  status: 'pending' | 'accepted' | 'unknown' | 'not_sent'
  reason?: string
  /** Coverage proven by the native fork boundary, not by copying the App timeline. */
  inheritedItems: ConversationItemRef[]
}

export interface Conversation {
  version: 1
  id: string
  cwd: string
  revision: number
  title?: string
  /** Present when this conversation is a side chat of a read-only source. */
  sideChat?: SideChatOrigin
  pinnedAt?: number
  archivedAt?: number
  /** Fingerprint of the explicitly confirmed legacy capture; original binding stays retired. */
  adoptionFingerprint?: string
  /** Durable write fence; completed tombstones retain IDs/hashes, never historical bodies. */
  deletion?: { status: 'pending' | 'complete'; fingerprint: string; result?: ConversationDeletionResult; retainedCopies?: boolean }
  fork?: ConversationFork
  bindings: ConversationBinding[]
  turns: ConversationTurn[]
}

export type ConversationContinuation =
  | { kind: 'blocked'; runId?: string; reason: string }
  | { kind: 'fresh'; missingItems: ConversationItemRef[] }
  | { kind: 'resume'; bindingId: string; nativeSessionId: string; missingItems: ConversationItemRef[] }

/** Total omitted items, without expanding a snapshot range into one entry per message. */
export function omittedItemCount(turn: Pick<DispatchedConversationTurn, 'omittedItems' | 'omittedRanges'>): number {
  const ranged = (turn.omittedRanges ?? []).reduce((sum, range) => sum + (range.to - range.from + 1), 0)
  return turn.omittedItems.length + ranged
}

/**
 * Split one omission list into compact snapshot ranges and explicit references.
 *
 * Snapshot positions become inclusive ranges: a contiguous frozen prefix stays a
 * constant-size ledger, while anything else keeps its exact reference.
 */
export function splitOmittedItems(
  conversation: Pick<Conversation, 'sideChat'>,
  omitted: readonly ConversationItemRef[]
): { items: ConversationItemRef[]; ranges: OmittedItemRange[] } {
  const snapshot = conversation.sideChat?.snapshot
  const positions: number[] = []
  const items: ConversationItemRef[] = []
  for (const item of omitted) {
    const index = snapshot ? sideChatSnapshotIndexOf(snapshot, item) : -1
    if (index < 0) items.push(item)
    else positions.push(index)
  }
  positions.sort((left, right) => left - right)
  const ranges: OmittedItemRange[] = []
  if (snapshot) {
    for (const index of positions) {
      const last = ranges.at(-1)
      if (last && last.snapshotId === snapshot.id && last.to === index - 1) last.to = index
      else ranges.push({ snapshotId: snapshot.id, from: index, to: index })
    }
  }
  return { items, ranges }
}

/**
 * Omitted positions as compact ranges.
 *
 * A frozen child can omit thousands of messages, so the ledger stores contiguous
 * snapshot ranges instead of one reference per message. Positions must be ascending and
 * unique; the caller derives them from the manifest, not from a materialized ref list.
 */
export function sideChatOmittedRanges(snapshot: SideChatSnapshot, positions: readonly number[]): OmittedItemRange[] {
  const ranges: OmittedItemRange[] = []
  for (const index of positions) {
    const last = ranges.at(-1)
    if (last && last.snapshotId === snapshot.id && last.to === index - 1) last.to = index
    else ranges.push({ snapshotId: snapshot.id, from: index, to: index })
  }
  return ranges
}

export const conversationItemKey = (item: ConversationItemRef): string =>
  JSON.stringify([item.runId, item.itemId, item.contentHash])

/** Snapshot refs are namespaced so they can never be mistaken for a child run id. */
export const sideChatSnapshotRunId = (snapshotId: string, index: number): string =>
  `side-chat:${snapshotId}:${index}`

/**
 * Ordered context of one conversation: frozen snapshot items first, then its own
 * real turns. Snapshot items are context, not execution, so they never gain a run
 * id, usage row or turn ordinal in the child.
 */
export function conversationContextItems(
  conversation: Pick<Conversation, 'turns' | 'sideChat'>,
  snapshotRefs?: readonly ConversationItemRef[]
): ConversationItemRef[] {
  const snapshot = conversation.sideChat?.snapshot
  return [
    ...(snapshot === undefined ? [] : frozenRefs(snapshot, snapshotRefs)),
    ...conversation.turns.flatMap(turn => turn.items)
  ]
}

/**
 * Frozen refs in order. A format 4 record keeps them in a manifest, so the caller reads
 * them from the child's own storage; returning an empty list here would silently drop
 * context instead of failing, so the missing input is an error.
 */
function frozenRefs(
  snapshot: SideChatSnapshot,
  snapshotRefs: readonly ConversationItemRef[] | undefined
): readonly ConversationItemRef[] {
  if (snapshot.format !== 4) return snapshot.items.map(item => item.ref)
  if (snapshotRefs === undefined) throw new Error('侧聊冻结快照引用需要从清单读取，不能假定为空')
  return snapshotRefs
}

/** Only items of this child's own snapshot; a source ref is never readable here. */
export function sideChatSnapshotItems(conversation: Pick<Conversation, 'sideChat'>): SideChatSnapshotItem[] {
  const snapshot = conversation.sideChat?.snapshot
  return snapshot === undefined || snapshot.format === 4 ? [] : snapshot.items
}

/** Message count without materializing the item list. */
export function sideChatSnapshotMessageCount(snapshot: SideChatSnapshot): number {
  return snapshot.format === 4 ? snapshot.messageCount : snapshot.items.length
}

/**
 * Position of one frozen message, or -1.
 *
 * A frozen ref is namespaced as `side-chat:<snapshot id>:<index>`, so both formats
 * resolve a position without reading a list.
 */
export function sideChatSnapshotIndexOf(snapshot: SideChatSnapshot, ref: ConversationItemRef): number {
  const prefix = `side-chat:${snapshot.id}:`
  if (!ref.runId.startsWith(prefix)) return -1
  const index = Number(ref.runId.slice(prefix.length))
  const count = sideChatSnapshotMessageCount(snapshot)
  return Number.isSafeInteger(index) && index >= 0 && index < count && String(index) === ref.runId.slice(prefix.length)
    ? index : -1
}

export function sameConversationTarget(a: ConversationTarget, b: ConversationTarget): boolean {
  return a.providerId === b.providerId && a.agentProfileId === b.agentProfileId &&
    a.continuationKey === b.continuationKey
}

export function conversationCoverage(conversation: Pick<Conversation, 'turns' | 'fork'>, bindingId: string): ConversationItemRef[] {
  const covered = new Map<string, ConversationItemRef>()
  if (conversation.fork?.status === 'accepted' && conversation.fork.bindingId === bindingId) {
    for (const item of conversation.fork.inheritedItems) covered.set(conversationItemKey(item), item)
  }
  for (const turn of conversation.turns) {
    if (turn.bindingId !== bindingId) continue
    const items = turn.origin === 'imported' ? turn.nativeItems : turn.delivery.status === 'accepted'
      ? [...turn.importedItems, ...turn.delivery.nativeItems] : []
    for (const item of items) covered.set(conversationItemKey(item), item)
  }
  return [...covered.values()]
}

/** Planning never resumes a foreign Provider/profile or treats an unknown delivery as unsent. */
export function planConversationContinuation(
  conversation: Conversation,
  target: ConversationTarget,
  snapshotRefs?: readonly ConversationItemRef[]
): ConversationContinuation {
  if (conversation.deletion) return { kind: 'blocked', reason: '统一对话正在删除或已删除，不能恢复执行' }
  if (conversation.fork && conversation.fork.status !== 'accepted') return { kind: 'blocked', reason: conversation.fork.reason ?? '原生分支尚未确认，不能发送或重试创建' }
  const unsettled = conversation.turns.find((turn) => turn.origin === 'dispatch' &&
    (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown'))
  if (unsettled) return {
    kind: 'blocked', runId: unsettled.runId,
    reason: '当前对话存在未收敛的投递；先核查原尝试，不能自动重发或切换执行'
  }
  const binding = [...conversation.bindings].reverse().find((candidate) =>
    candidate.nativeSessionId !== undefined && candidate.retiredReason === undefined &&
    sameConversationTarget(candidate, target))
  const covered = new Set(binding ? conversationCoverage(conversation, binding.id).map(conversationItemKey) : [])
  const missingItems = conversationContextItems(conversation, snapshotRefs)
    .filter((item) => !covered.has(conversationItemKey(item)))
  return binding?.nativeSessionId !== undefined
    ? { kind: 'resume', bindingId: binding.id, nativeSessionId: binding.nativeSessionId, missingItems }
    : { kind: 'fresh', missingItems }
}
