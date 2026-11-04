import { createHash } from 'node:crypto'
import {
  conversationItemKey,
  sideChatSnapshotIndexOf,
  sideChatSnapshotMessageCount,
  SIDE_CHAT_DEFAULT_TITLE,
  type SideChatSnapshotManifest,
  type Conversation,
  type ConversationContinuation,
  type ConversationItemRef,
  type ConversationTarget
} from '../shared/conversation'
import { readSideChatSnapshotItem } from './conversation-side-chat-snapshot'
import type { ConversationPreview, ConversationSendRequest, ConversationSummary, ConversationTargetRequest } from '../shared/conversation-api'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export function conversationSummary(conversation: Conversation, activeRunIds: ReadonlySet<string>): ConversationSummary {
  const latest = conversation.turns.at(-1)
  const lastRunOutcome = latest?.origin === 'dispatch' && latest.delivery.status === 'accepted' ? latest.delivery.outcome : undefined
  const pending = conversation.turns.find((turn) => turn.origin === 'dispatch' &&
    (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown')) as Extract<Conversation['turns'][number], { origin: 'dispatch' }> | undefined
  return {
    id: conversation.id,
    cwd: conversation.cwd,
    ...(conversation.deletion ? { deletion: structuredClone(conversation.deletion), blockedReason: '统一对话正在删除或已删除，不能执行' } : {}),
    ...(conversation.fork ? { fork: { sourceConversationId: conversation.fork.sourceConversationId, sourceRunId: conversation.fork.sourceRunId,
      bindingId: conversation.fork.bindingId, status: conversation.fork.status, reason: conversation.fork.reason },
      ...(conversation.fork.status !== 'accepted' && !conversation.deletion ? { blockedReason: conversation.fork.status === 'not_sent' ? `原生分支未创建：${conversation.fork.reason}` : `原生分支结果尚未确认：${conversation.fork.reason ?? '等待宿主回执'}；不会自动重建` } : {}) } : {}),
    ...(conversation.sideChat ? { sideChat: {
      source: structuredClone(conversation.sideChat.source),
      parentTitleAtCapture: conversation.sideChat.parentTitleAtCapture,
      initialTarget: structuredClone(conversation.sideChat.initialTarget),
      throughOrdinal: conversation.sideChat.snapshot.throughOrdinal,
      throughRunId: conversation.sideChat.snapshot.throughRunId,
      capturedAt: conversation.sideChat.snapshot.capturedAt,
      prefixFingerprint: conversation.sideChat.snapshot.prefixFingerprint,
      messageCount: sideChatSnapshotMessageCount(conversation.sideChat.snapshot)
    } } : {}),
    // A side chat has no source-derived title: it stays on the neutral default until
    // the first real question or an explicit rename assigns one.
    title: conversation.title ?? (conversation.sideChat ? SIDE_CHAT_DEFAULT_TITLE : `对话 ${conversation.id.slice(0, 8)}`),
    ...(conversation.pinnedAt ? { pinnedAt: conversation.pinnedAt } : {}),
    ...(conversation.archivedAt ? { archivedAt: conversation.archivedAt } : {}),
    revision: conversation.revision,
    turnCount: conversation.turns.length,
    ...(lastRunOutcome ? { lastRunOutcome } : {}),
    ...(activeRunIds.has(pending?.runId ?? '') ? { activeRunId: pending?.runId } : {}),
    ...(pending ? { blockedReason: pending.delivery.status === 'unknown' ? pending.delivery.reason : activeRunIds.has(pending.runId) ? '当前轮仍在投递' : '投递结果尚未确认，且没有可关联的运行；请重启核查' } : {})
  }
}

export function targetRequest(request: ConversationTargetRequest, continuationKey: string): ConversationTarget {
  return {
    providerId: request.providerId,
    ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
    continuationKey
  }
}

export function dispatchPayloadHash(input: {
  prompt: string
  attachments?: ConversationSendRequest['attachments']
  target: ConversationTarget
  cwd: string
  resumeSessionId: string | null
  model: ConversationSendRequest['model']
  effort: ConversationSendRequest['effort']
  permissionMode: ConversationSendRequest['permissionMode']
  selectedItems: ConversationItemRef[]
}): string {
  return hash(JSON.stringify({
    scope: 'plain-text-local-managed-v1',
    prompt: input.prompt,
    ...(input.attachments?.length ? { attachments: input.attachments.map(attachment => ({ ...attachment, dataBase64: hash(attachment.dataBase64) })) } : {}),
    target: input.target,
    cwd: input.cwd,
    resumeSessionId: input.resumeSessionId,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    selectedItems: input.selectedItems
  }))
}

/** Preview rows come from the same context items that planning hands off. */
export async function missingDetails(
  userData: string,
  conversation: Conversation,
  continuation: ConversationContinuation
): Promise<ConversationPreview['missingItems']> {
  if (continuation.kind === 'blocked') return []
  const missing = new Set(continuation.missingItems.map(conversationItemKey))
  const snapshot = conversation.sideChat?.snapshot
  // Format 4 resolves only the missing positions, one manifest leaf at a time.
  const frozen = snapshot === undefined ? []
    : snapshot.format === 4
      ? await frozenDetails(userData, conversation, snapshot, continuation.missingItems)
      : snapshot.items.filter(item => missing.has(conversationItemKey(item.ref)))
        .map(item => ({ ref: item.ref, ordinal: item.sourceOrdinal, providerId: item.providerId, role: item.role }))
  const own = conversation.turns.flatMap((turn) => {
    const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)
    return turn.items.filter((item) => missing.has(conversationItemKey(item))).map((item) => ({
      ref: item,
      ordinal: turn.ordinal,
      providerId: binding?.providerId ?? 'claude',
      role: item.itemId === 'assistant' ? 'assistant' as const : 'user' as const
    }))
  })
  return [...frozen, ...own]
}

async function frozenDetails(
  userData: string,
  conversation: Conversation,
  snapshot: SideChatSnapshotManifest,
  missingItems: readonly ConversationItemRef[]
): Promise<ConversationPreview['missingItems']> {
  const rows: ConversationPreview['missingItems'] = []
  for (const ref of missingItems) {
    const index = sideChatSnapshotIndexOf(snapshot, ref)
    if (index < 0) continue
    const item = await readSideChatSnapshotItem(userData, conversation, index)
    rows.push({ ref: item.ref, ordinal: item.sourceOrdinal, providerId: item.providerId, role: item.role })
  }
  return rows
}
