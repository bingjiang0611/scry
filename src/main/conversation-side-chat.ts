import { createHash, randomUUID } from 'node:crypto'
import { isCommandId } from '../shared/runtime'
import { conversationSummary } from './conversation-summary'
import { parseSideChatCreate, parseSideChatListRequest, parseSideChatPreviewOptions, parseSideChatSource } from './conversation-request'
import {
  sideChatSnapshotMessageCount, type Conversation, type SideChatInitialTarget, type SideChatOrigin, type SideChatSource
} from '../shared/conversation'
import { conversationIdPattern, requireValue } from './conversation-schema'
import { SideChatSnapshotWriter } from './conversation-side-chat-manifest'
import { conversationHistoryRoot } from './conversation-history-content'
import { sealSink } from './conversation-side-chat-capture'
import { deleteConversationHistory } from './conversation-history-content'
import type { SideChatServiceDeps } from './conversation-service-deps'
import {
  captureSideChatPrefix, sourceWorkspaceCwd, type CapturedPrefix
} from './conversation-side-chat-source'
import { deliveryBlockedReason, sideChatCoverage } from './conversation-side-chat-coverage'
import type {
  ConversationSideChatRequest, ConversationSummary, SideChatCommandReceipt, SideChatList, SideChatPreview, SideChatSnapshotPage
} from '../shared/conversation-api'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const DEFAULT_PAGE_SIZE = 40

/** A requested choice, never inferred evidence about the source session's own model. */
function initialTargetFor(captured: CapturedPrefix, requested?: SideChatInitialTarget): SideChatInitialTarget {
  if (requested) return { ...requested }
  return {
    providerId: captured.sourceTarget.providerId,
    ...(captured.sourceTarget.agentProfileId ? { agentProfileId: captured.sourceTarget.agentProfileId } : {}),
    permissionMode: 'default'
  }
}

function readerAvailable(deps: SideChatServiceDeps, target: SideChatInitialTarget): boolean {
  return deps.supportsHistoryReader?.(target.providerId) === true
}

/**
 * Snapshot size and coverage share one measurement path for preview and creation.
 *
 * Format 4 keeps the item index and every body in content-addressed manifests, so a
 * large source no longer refuses creation. `bodyBytes` is the frozen text size, and it
 * decides only whether a reader is required, never whether the snapshot may exist.
 */
function measure(
  deps: SideChatServiceDeps,
  conversationId: string,
  captured: CapturedPrefix,
  target: SideChatInitialTarget
): { readerAvailable: boolean; coverage: ReturnType<typeof sideChatCoverage> } {
  const reader = readerAvailable(deps, target)
  return {
    readerAvailable: reader,
    coverage: sideChatCoverage({
      conversationId, items: captured.items, readerAvailable: reader, snapshotBytes: captured.bodyBytes
    })
  }
}

/** Projects one captured prefix into the preview shape; no persistence, no Provider call. */
function previewOf(
  deps: SideChatServiceDeps,
  captured: CapturedPrefix,
  measured: ReturnType<typeof measure>,
  target: SideChatInitialTarget
): SideChatPreview {
  const blocked = deliveryBlockedReason({
    supportsHistoricalInput: deps.supportsHistoricalInput(target.providerId),
    readerAvailable: measured.readerAvailable, target, coverage: measured.coverage
  })
  return {
    source: captured.source,
    title: captured.title,
    throughOrdinal: captured.throughOrdinal,
    throughRunId: captured.throughRunId,
    prefixFingerprint: captured.prefixFingerprint,
    manifestFingerprint: captured.manifestFingerprint,
    messageCount: captured.items.length,
    bodyBytes: captured.bodyBytes,
    target,
    coverage: measured.coverage,
    smallestThroughOrdinal: captured.smallestThroughOrdinal,
    ...(blocked ? { firstSendBlockedReason: blocked } : {})
  }
}

export async function previewSideChat(
  deps: SideChatServiceDeps,
  input: unknown,
  optionsInput?: unknown
): Promise<SideChatPreview> {
  const source = parseSideChatSource(input)
  const options = parseSideChatPreviewOptions(optionsInput)
  const readAt = async (ordinal?: number): Promise<SideChatPreview> => {
    const captured = await captureSideChatPrefix(deps, source,
      ordinal === undefined ? undefined : { ordinal })
    const target = initialTargetFor(captured, options.initialTarget)
    return previewOf(deps, captured, measure(deps, captured.source.kind === 'conversation'
      ? captured.source.conversationId : captured.source.nativeSessionId, captured, target), target)
  }
  // A refused range stays refused. Capture streams the whole prefix into the manifest,
  // so there is no snapshot budget left to answer with a silently smaller prefix.
  return readAt(options.completedThroughOrdinal)
}

function requestIntentHash(request: ConversationSideChatRequest): string {
  return hash(JSON.stringify({
    source: request.source,
    throughOrdinal: request.expectedThroughOrdinal,
    throughRunId: request.expectedThroughRunId,
    prefixFingerprint: request.expectedPrefixFingerprint,
    manifestFingerprint: request.expectedManifestFingerprint,
    initialTarget: request.initialTarget ?? null
  }))
}

/** Conclusive non-publication lets the child-owned body be discarded; anything else keeps it. */
async function discardUnpublishedContent(deps: SideChatServiceDeps, id: string, cwd: string): Promise<void> {
  try {
    await deleteConversationHistory(deps.store.userData, { id, cwd })
  } catch (error) {
    console.error('[scry] failed to discard an unpublished side-chat snapshot:', error)
  }
}

/**
 * Local-only creation. The frozen body is sealed under the new child's own content
 * root before the record is published, so a source mutation or deletion cannot
 * produce a child that looks complete without its snapshot bytes.
 */
export async function createSideChat(
  deps: SideChatServiceDeps,
  active: ReadonlySet<string>,
  input: unknown
): Promise<ConversationSummary> {
  const request = parseSideChatCreate(input)
  const intentHash = requestIntentHash(request)
  const receipt = await deps.store.findSideChat(request.commandId)
  if (receipt) {
    requireValue(receipt.sideChat?.intentHash === intentHash, '同一侧聊创建命令不能替换内容或来源')
    return conversationSummary(receipt, active)
  }
  const id = randomUUID()
  requireValue(conversationIdPattern.test(id), '侧聊 ID 无效')
  const snapshotId = randomUUID()
  const capturedAt = Date.now()
  // The sealed body lives under the child's own content root, so the writer has to
  // exist before the source is read. Its identity uses the requested range: a source
  // that changed under us is refused below, and the orphaned body is discarded.
  const cwd = await sourceWorkspaceCwd(deps, request.source)
  const writer = new SideChatSnapshotWriter({
    dataRoot: conversationHistoryRoot(deps.store.userData, { id, cwd }),
    identity: {
      id: snapshotId, prefixFingerprint: request.expectedPrefixFingerprint,
      throughOrdinal: request.expectedThroughOrdinal, throughRunId: request.expectedThroughRunId, capturedAt
    }
  })
  // A source that turns out not to prove its own prefix is refused after its body has
  // already been streamed into the child's content root; the sealed partial must not stay
  // behind, because this child is never published.
  const captured = await captureSideChatPrefix(deps, request.source,
    { ordinal: request.expectedThroughOrdinal, runId: request.expectedThroughRunId }, sealSink(writer, snapshotId))
    .catch(async (error: unknown) => {
      await discardUnpublishedContent(deps, id, cwd)
      throw error
    })
  if (captured.cwd !== cwd || captured.throughOrdinal !== request.expectedThroughOrdinal ||
    captured.prefixFingerprint !== request.expectedPrefixFingerprint ||
    captured.manifestFingerprint !== request.expectedManifestFingerprint) {
    await discardUnpublishedContent(deps, id, cwd)
    throw new Error('来源快照范围已变化，请重新预览；本次未创建侧聊')
  }
  const target = initialTargetFor(captured, request.initialTarget)
  const measured = measure(deps, id, captured, target)
  const blocked = deliveryBlockedReason({
    supportsHistoricalInput: deps.supportsHistoricalInput(target.providerId),
    readerAvailable: measured.readerAvailable, target, coverage: measured.coverage
  })
  // Refuse before publishing: a child whose first send provably cannot carry its
  // own frozen context would be an empty session that only looks complete.
  if (blocked !== undefined) {
    await discardUnpublishedContent(deps, id, cwd)
    requireValue(blocked === undefined, blocked)
  }
  const sealed = await writer.seal()
  if (sealed.messageCount !== captured.items.length || sealed.bodyBytes !== captured.bodyBytes) {
    await discardUnpublishedContent(deps, id, cwd)
    throw new Error('侧聊快照正文与来源事实不一致，本次未创建侧聊')
  }
  const origin: SideChatOrigin = {
    source: captured.source,
    parentTitleAtCapture: captured.title,
    initialTarget: target,
    snapshot: sealed,
    commandId: request.commandId,
    intentHash
  }
  try {
    const published = await deps.store.createSideChat({ id, cwd, origin })
    if (!published.created) {
      // A concurrent identical command already published its child; this body is orphaned.
      requireValue(published.conversation.sideChat?.intentHash === intentHash, '同一侧聊创建命令不能替换内容或来源')
      await discardUnpublishedContent(deps, id, cwd)
    }
    return conversationSummary(published.conversation, active)
  } catch (error) {
    // A published record may lose its acknowledgement. Read back, never re-create.
    let persisted: Conversation | null
    try {
      persisted = await deps.store.read(id)
    } catch (readbackError) {
      // Publication outcome is unknown: the sealed body must stay readable.
      console.error('[scry] could not verify side-chat publication:', readbackError)
      throw error
    }
    if (persisted?.sideChat?.commandId === request.commandId) return conversationSummary(persisted, active)
    if (!persisted) await discardUnpublishedContent(deps, id, cwd)
    throw error
  }
}

/** Whether a stored binding names exactly this native source in this workspace. */
const bindingNames = (owner: Conversation, binding: Conversation['bindings'][number],
  native: { providerId: string; agentProfileId?: string; cwd: string; nativeSessionId: string }): boolean =>
  binding.providerId === native.providerId && (binding.agentProfileId ?? null) === (native.agentProfileId ?? null) &&
  owner.cwd === native.cwd && binding.nativeSessionId === native.nativeSessionId

/**
 * Whether one child's frozen provenance names the requested source scope.
 *
 * A native session and the managed conversations that bind it are one source. A parent
 * adopted into a conversation keeps the children it froze while it was a Provider
 * session, so asking by that conversation id must still find them; asking by the native
 * tuple of a conversation-bound parent keeps finding its children too.
 *
 * Only the requested side is resolved: the same-kind case is an exact tuple/id comparison,
 * and the handoff case looks up that one owner by id and reads that owner's own bindings.
 * Unrelated owners are never inspected, so a page scan does not grow with history size,
 * and the fence stays one exact provider/profile/workspace/session tuple.
 */
function childNamesSource(child: Conversation, owners: ReadonlyMap<string, Conversation>,
  source: SideChatSource): boolean {
  const origin = child.sideChat?.source
  if (!origin) return false
  if (origin.kind === 'native-session') {
    if (source.kind === 'native-session') return sameSourceIdentity(origin, source)
    const owner = owners.get(source.conversationId)
    return owner?.bindings.some(binding => binding.nativeSessionId !== undefined &&
      bindingNames(owner, binding, origin)) ?? false
  }
  if (source.kind === 'conversation') return origin.conversationId === source.conversationId
  const owner = owners.get(origin.conversationId)
  return owner?.bindings.some(binding => binding.nativeSessionId !== undefined &&
    bindingNames(owner, binding, source)) ?? false
}

function parsedCursor(value: string | undefined): { capturedAt: number; id: string } | undefined {
  if (value === undefined) return undefined
  const match = /^(\d{1,16}):([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.exec(value)
  requireValue(match !== null, '侧聊历史游标无效')
  return { capturedAt: Number(match[1]), id: match[2] }
}

/**
 * Paged children of one source. Identity comes from each child's own frozen
 * provenance, so a deleted source conversation or native session still restores
 * its children; completely deleted children are excluded, archived ones kept.
 */
export async function listSideChats(
  deps: SideChatServiceDeps,
  active: ReadonlySet<string>,
  input: unknown
): Promise<SideChatList> {
  const request = parseSideChatListRequest(input)
  const source = request.source
  const limit = request.limit ?? DEFAULT_PAGE_SIZE
  const cursor = parsedCursor(request.cursor)
  const owners = new Map((await deps.store.list()).map(conversation => [conversation.id, conversation]))
  const children = [...owners.values()]
    .filter(child => child.sideChat !== undefined && (!child.deletion || child.deletion.retainedCopies === true))
    .filter(child => childNamesSource(child, owners, source))
    .sort((left, right) => (right.sideChat!.snapshot.capturedAt - left.sideChat!.snapshot.capturedAt) ||
      left.id.localeCompare(right.id))
  const selected = request.ids === undefined ? undefined : new Set(request.ids)
  if (selected) {
    const wantedChildren = children.filter(child => selected.has(child.id))
    return { total: wantedChildren.length, items: wantedChildren.map(child => conversationSummary(child, active)) }
  }
  const remaining = cursor === undefined ? children : children.filter(child => {
    const capturedAt = child.sideChat!.snapshot.capturedAt
    return capturedAt < cursor.capturedAt || (capturedAt === cursor.capturedAt && child.id > cursor.id)
  })
  const page = remaining.slice(0, limit)
  const last = page.at(-1)
  return {
    total: children.length,
    items: page.map(child => conversationSummary(child, active)),
    ...(remaining.length > page.length && last
      ? { nextCursor: `${last.sideChat!.snapshot.capturedAt}:${last.id}` }
      : {})
  }
}

function sameSourceIdentity(left: SideChatSource, right: SideChatSource): boolean {
  if (left.kind === 'conversation' || right.kind === 'conversation') {
    return left.kind === 'conversation' && right.kind === 'conversation' && left.conversationId === right.conversationId
  }
  return left.providerId === right.providerId && (left.agentProfileId ?? null) === (right.agentProfileId ?? null) &&
    left.cwd === right.cwd && left.nativeSessionId === right.nativeSessionId
}

/**
 * Read-only creation receipt lookup for one source scope.
 *
 * C2 persists a bounded create command before invoking creation, so a lost reply is
 * resolved by reading back the same child instead of silently creating a second one.
 * This path never creates, adopts or starts a Provider. `not-found` means only that
 * no child of this source owns that command id; it is not evidence about whether a
 * concurrent IPC ever reached the host.
 */
export async function findSideChatCommand(
  deps: SideChatServiceDeps,
  active: ReadonlySet<string>,
  sourceInput: unknown,
  commandIdInput: unknown
): Promise<SideChatCommandReceipt> {
  const source = parseSideChatSource(sourceInput)
  if (typeof commandIdInput !== 'string' || !isCommandId(commandIdInput)) throw new Error('侧聊创建命令无效')
  const commandId = commandIdInput
  const child = await deps.store.findSideChat(commandId)
  if (!child?.sideChat) return { commandId, status: 'not-found' }
  requireValue(sameSourceIdentity(child.sideChat.source, source), '该侧聊创建命令不属于此来源')
  if (source.kind === 'native-session') requireValue(child.cwd === source.cwd, '侧聊工作区与冻结来源不一致')
  requireValue(child.deletion?.status !== 'complete', '侧聊已删除')
  return { commandId, status: 'found', conversation: conversationSummary(child, active) }
}

/** Read-only snapshot metadata for the child's own page; bodies stay behind readItem. */
export function sideChatPage(conversation: Conversation): SideChatSnapshotPage | undefined {
  if (!conversation.sideChat) return undefined
  return {
    source: structuredClone(conversation.sideChat.source),
    parentTitleAtCapture: conversation.sideChat.parentTitleAtCapture,
    initialTarget: structuredClone(conversation.sideChat.initialTarget),
    throughOrdinal: conversation.sideChat.snapshot.throughOrdinal,
    throughRunId: conversation.sideChat.snapshot.throughRunId,
    capturedAt: conversation.sideChat.snapshot.capturedAt,
    prefixFingerprint: conversation.sideChat.snapshot.prefixFingerprint,
    messageCount: sideChatSnapshotMessageCount(conversation.sideChat.snapshot),
    ...(conversation.sideChat.snapshot.format === 4
      ? {}
      : { items: structuredClone(conversation.sideChat.snapshot.items) })
  }
}
