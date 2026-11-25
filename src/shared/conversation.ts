import type { DeleteSessionResult, ProviderId } from './provider'
import type { AgentStartRequest } from './runtime'
import type { AgentTurnRecord } from './turn-record'
import type { ContentRef } from './tool-content'
import type { ManifestRef } from './content-manifest'

export interface ConversationArchiveRef {
  sessionId: string
  providerTurnId?: string
}

export interface ConversationTarget {
  providerId: ProviderId
  agentProfileId?: string
  continuationKey: string
}

export interface ConversationBinding extends ConversationTarget {
  id: string
  nativeSessionId?: string
  historyOnly?: true
  retiredReason?: string
}

export interface ConversationItemRef {
  runId: string
  itemId: string
  contentHash: string
}

export const SIDE_CHAT_DEFAULT_TITLE = '侧边会话'

export type SideChatSource =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'native-session'; providerId: ProviderId; agentProfileId?: string; cwd: string; nativeSessionId: string }

export interface SideChatSnapshotItem {
  ref: ConversationItemRef
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

export interface SideChatSnapshotArtifact extends SideChatSnapshotBase {
  format?: 3
  content: ContentRef
  items: SideChatSnapshotItem[]
}

export interface SideChatSnapshotManifest extends SideChatSnapshotBase {
  format: 4
  messageCount: number
  bodyBytes: number
  items: ManifestRef
}

export type SideChatSnapshot = SideChatSnapshotArtifact | SideChatSnapshotManifest

export type SideChatInitialTarget = Pick<AgentStartRequest, 'model' | 'effort' | 'permissionMode'> & {
  providerId: ProviderId
  agentProfileId?: string
}

export interface SideChatOrigin {
  source: SideChatSource
  parentTitleAtCapture: string
  initialTarget: SideChatInitialTarget
  snapshot: SideChatSnapshot
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
      nativeItems: ConversationItemRef[]
    }

interface ConversationTurnBase {
  ordinal: number
  runId: string
  bindingId: string
  items: ConversationItemRef[]
  archive?: ConversationArchiveRef
}

export interface ImportedConversationTurn extends ConversationTurnBase {
  origin: 'imported'
  nativeItems: ConversationItemRef[]
}

export interface DispatchedConversationTurn extends ConversationTurnBase {
  origin: 'dispatch'
  commandId: string
  intentHash: string
  resumeSessionId: string | null
  importedItems: ConversationItemRef[]
  omittedItems: ConversationItemRef[]
  omittedRanges?: OmittedItemRange[]
  historyPolicy?: 'retrievable-v1'
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
  deleted: string[]
  failed: Array<DeleteSessionResult['failed'][number] & { reason?: DeleteSessionResult['reason'] }>
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
  inheritedItems: ConversationItemRef[]
}

export interface Conversation {
  version: 1
  id: string
  cwd: string
  revision: number
  title?: string
  sideChat?: SideChatOrigin
  pinnedAt?: number
  archivedAt?: number
  adoptionFingerprint?: string
  deletion?: { status: 'pending' | 'complete'; fingerprint: string; result?: ConversationDeletionResult; retainedCopies?: boolean }
  fork?: ConversationFork
  bindings: ConversationBinding[]
  turns: ConversationTurn[]
}

export type ConversationContinuation =
  | { kind: 'blocked'; runId?: string; reason: string }
  | { kind: 'fresh'; missingItems: ConversationItemRef[] }
  | { kind: 'resume'; bindingId: string; nativeSessionId: string; missingItems: ConversationItemRef[] }

export function omittedItemCount(turn: Pick<DispatchedConversationTurn, 'omittedItems' | 'omittedRanges'>): number {
  const ranged = (turn.omittedRanges ?? []).reduce((sum, range) => sum + (range.to - range.from + 1), 0)
  return turn.omittedItems.length + ranged
}

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

export const sideChatSnapshotRunId = (snapshotId: string, index: number): string =>
  `side-chat:${snapshotId}:${index}`

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

function frozenRefs(
  snapshot: SideChatSnapshot,
  snapshotRefs: readonly ConversationItemRef[] | undefined
): readonly ConversationItemRef[] {
  if (snapshot.format !== 4) return snapshot.items.map(item => item.ref)
  if (snapshotRefs === undefined) throw new Error('侧聊冻结快照引用需要从清单读取，不能假定为空')
  return snapshotRefs
}

export function sideChatSnapshotItems(conversation: Pick<Conversation, 'sideChat'>): SideChatSnapshotItem[] {
  const snapshot = conversation.sideChat?.snapshot
  return snapshot === undefined || snapshot.format === 4 ? [] : snapshot.items
}

export function sideChatSnapshotMessageCount(snapshot: SideChatSnapshot): number {
  return snapshot.format === 4 ? snapshot.messageCount : snapshot.items.length
}

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
