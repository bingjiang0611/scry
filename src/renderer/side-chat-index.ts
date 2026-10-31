import type { ConversationSummary } from '@shared/conversation-api'
import type { SideChatSource } from '@shared/conversation'
import type { AgentQuestionKind } from '@shared/runtime'
import type { SessionProviderId } from '@shared/provider'
import { SIDE_CHAT_COPY } from './constants/side-chat-copy'

export interface SideChatCounts {
  total: number
  running: number
  /** Children whose own run waits for a permission decision. */
  permission: number
  /** Children whose own run waits for a clarification answer. */
  attention: number
}

/** Children whose captured source is no longer in the catalog, grouped by that source. */
export interface SideChatOrphanGroup {
  /**
   * Canonical identity of the captured source. The captured title is only what the row
   * prints: two unrelated sources that happen to share a title must stay two groups, or a
   * child would be shown under another conversation's name.
   */
  key: string
  parentTitleAtCapture: string
  items: ConversationSummary[]
  total: number
}

export function conversationSourceKey(conversationId: string): string {
  return `conversation:${conversationId}`
}

/** Same identity the host uses for a native source, profile included. */
export function nativeSourceKey({
  providerId, agentProfileId, cwd, nativeSessionId
}: {
  providerId: SessionProviderId | string
  agentProfileId?: string | null
  cwd: string
  nativeSessionId: string
}): string {
  return `native:${JSON.stringify([providerId, agentProfileId ?? null, cwd, nativeSessionId])}`
}

export function parentKeyOf(source: SideChatSource): string {
  return source.kind === 'conversation'
    ? conversationSourceKey(source.conversationId)
    : nativeSourceKey(source)
}

export interface SideChatCatalog {
  counts: ReadonlyMap<string, SideChatCounts>
  orphans: readonly SideChatOrphanGroup[]
}

function emptyCounts(): SideChatCounts {
  return { total: 0, running: 0, permission: 0, attention: 0 }
}

/**
 * One pass over the already-loaded project catalog.
 *
 * Every child, parent row and run status is taken from the same authoritative records
 * the sidebar already holds, so no child transcript is read and no per-child IPC is
 * issued to answer "how many side chats does this row have". A child whose source is
 * gone is grouped by that captured source (its title is display only); unrelated children
 * are never merged into one group nor flattened into the main list.
 */
export function indexSideChatCatalog({
  projects, runningRunIds, waitingQuestionRunIds, questionKindsByRun, extraParentKeys = []
}: {
  projects: readonly {
    cwd: string
    sessions?: readonly { providerId: SessionProviderId; agentProfileId?: string; externalSessionId?: string; sessionId: string }[]
    conversations?: readonly ConversationSummary[]
  }[]
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
  questionKindsByRun: ReadonlyMap<string, AgentQuestionKind>
  /** Parents known from another loaded list, e.g. the archived session catalog. */
  extraParentKeys?: readonly string[]
}): SideChatCatalog {
  const present = new Set<string>(extraParentKeys)
  const counts = new Map<string, SideChatCounts>()
  const orphans = new Map<string, ConversationSummary[]>()
  for (const project of projects) {
    for (const conversation of project.conversations ?? []) present.add(conversationSourceKey(conversation.id))
    for (const session of project.sessions ?? []) {
      present.add(nativeSourceKey({ providerId: session.providerId, agentProfileId: session.agentProfileId,
        cwd: project.cwd, nativeSessionId: session.externalSessionId ?? session.sessionId }))
    }
  }
  for (const project of projects) {
    for (const conversation of project.conversations ?? []) {
      const summary = conversation.sideChat
      if (!summary) continue
      const key = parentKeyOf(summary.source)
      if (!present.has(key)) {
        const bucket = orphans.get(key)
        if (bucket) bucket.push(conversation)
        else orphans.set(key, [conversation])
        continue
      }
      const entry = counts.get(key) ?? emptyCounts()
      entry.total += 1
      const runId = conversation.activeRunId
      if (runId && waitingQuestionRunIds.has(runId)) {
        // A clarification is not an approval request; only a real permission prompt is.
        if (questionKindsByRun.get(runId) === 'permission') entry.permission += 1
        else entry.attention += 1
      } else if (runId && runningRunIds.has(runId)) entry.running += 1
      counts.set(key, entry)
    }
  }
  return {
    counts,
    orphans: [...orphans.entries()]
      .map(([key, items]) => ({ key, parentTitleAtCapture: items[0].sideChat!.parentTitleAtCapture,
        items, total: items.length }))
      .sort((left, right) => right.total - left.total ||
        left.parentTitleAtCapture.localeCompare(right.parentTitleAtCapture) || left.key.localeCompare(right.key))
  }
}

/** Compact counter shown on a parent row; empty when the row has no children. */
export function sideChatCountLabel(counts: SideChatCounts | undefined): string | undefined {
  if (!counts || counts.total === 0) return undefined
  const needs = counts.permission + counts.attention
  const parts = [SIDE_CHAT_COPY.parentCount(counts.total)]
  if (counts.running > 0) parts.push(SIDE_CHAT_COPY.parentRunning(counts.running))
  if (needs > 0) parts.push(SIDE_CHAT_COPY.parentNeedsAttention(needs))
  return parts.join(' · ')
}
