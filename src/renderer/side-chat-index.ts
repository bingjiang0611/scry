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
}

function emptyCounts(): SideChatCounts {
  return { total: 0, running: 0, permission: 0, attention: 0 }
}

/**
 * One pass over the already-loaded project catalog.
 *
 * A side chat is never a sidebar row of its own: it lives in its parent's right panel, and
 * the sidebar only tells that parent's row how many it has and whether one is running or
 * waiting. Every child and run status is taken from the records the sidebar already holds,
 * so no child transcript is read and no per-child IPC is issued. A child whose source is
 * not in the loaded list is counted under a key no row asks for; it is not surfaced here,
 * and stays reachable from its source's own side-chat history.
 */
export function indexSideChatCatalog({
  projects, runningRunIds, waitingQuestionRunIds, questionKindsByRun
}: {
  projects: readonly { conversations?: readonly ConversationSummary[] }[]
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
  questionKindsByRun: ReadonlyMap<string, AgentQuestionKind>
}): SideChatCatalog {
  const counts = new Map<string, SideChatCounts>()
  for (const project of projects) {
    for (const conversation of project.conversations ?? []) {
      const summary = conversation.sideChat
      if (!summary) continue
      const key = parentKeyOf(summary.source)
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
  return { counts }
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
