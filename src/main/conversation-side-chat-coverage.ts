import type { HistoryMessage } from './conversation-history-content'
import { handoffBudget, handoffCoverage, selectHistory } from './conversation-handoff-budget'
import { historicalInputBytes } from './providers/historical-input'
import { historyTextFor } from './conversation-history'
import { sideChatSnapshotBytes } from './conversation-side-chat-snapshot'
import { MAX_SIDE_CHAT_SNAPSHOT_BYTES } from './conversation-side-chat-schema'
import type { SideChatCoverage } from '../shared/conversation-api'
import { sideChatSnapshotRunId, type SideChatInitialTarget, type SideChatSnapshotItem } from '../shared/conversation'

/** Same length as a real UUID, so a preview measures the exact bytes a seal will produce. */
export const PREVIEW_CONVERSATION_ID = '00000000-0000-4000-8000-000000000000'
export const PREVIEW_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000001'

/** Frozen manifest in source order; refs never reuse a source run identity. */
export function snapshotItems(snapshotId: string, entries: ReadonlyArray<{
  contentHash: string
  role: 'user' | 'assistant'
  sourceOrdinal: number
  providerId: string
}>): SideChatSnapshotItem[] {
  return entries.map((entry, index) => ({
    ref: { runId: sideChatSnapshotRunId(snapshotId, index), itemId: entry.role, contentHash: entry.contentHash },
    sourceOrdinal: entry.sourceOrdinal,
    providerId: entry.providerId as SideChatSnapshotItem['providerId'],
    role: entry.role
  }))
}

/**
 * Measure the frozen prefix with the same budget the first send will use. The
 * future prompt is unknown here, so this is an empty-prompt preflight: send
 * revalidates with the real prompt and attachments, and creation only refuses
 * prefixes that provably cannot be delivered at all.
 */
export function sideChatCoverage(input: {
  conversationId: string
  messages: readonly HistoryMessage[]
  readerAvailable: boolean
  snapshotBytes: number
}): SideChatCoverage {
  const budget = handoffBudget({ userText: '', attachments: [] })
  const selection = selectHistory({
    messages: input.messages,
    budget,
    cost: selected => historicalInputBytes(historyTextFor(selected, handoffCoverage({
      conversationId: input.conversationId, selected: selected.length, omitted: input.messages.length - selected.length
    })))
  })
  return {
    messageCount: input.messages.length,
    inlineCount: selection.messages.length,
    retrievableCount: selection.omitted.length,
    readerAvailable: input.readerAvailable,
    handoffBudgetBytes: budget,
    snapshotBytes: input.snapshotBytes,
    snapshotByteLimit: MAX_SIDE_CHAT_SNAPSHOT_BYTES
  }
}

export function measureSnapshot(input: {
  conversationId: string
  cwd: string
  snapshotId: string
  throughOrdinal: number
  throughRunId: string
  prefixFingerprint: string
  messages: readonly HistoryMessage[]
}): number {
  return sideChatSnapshotBytes({ id: input.conversationId, cwd: input.cwd }, {
    id: input.snapshotId, throughOrdinal: input.throughOrdinal, throughRunId: input.throughRunId,
    prefixFingerprint: input.prefixFingerprint
  }, input.messages)
}

/**
 * A first send must be able to carry the whole frozen prefix either inline or
 * through a verified reader. Anything else is refused before the child exists.
 */
export function deliveryBlockedReason(input: {
  supportsHistoricalInput: boolean
  readerAvailable: boolean
  target: SideChatInitialTarget
  coverage: Pick<SideChatCoverage, 'retrievableCount'>
}): string | undefined {
  if (!input.supportsHistoricalInput) return `${input.target.providerId} 尚未提供可验证的历史输入交接`
  if (input.coverage.retrievableCount > 0 && !input.readerAvailable) {
    return `所选范围有 ${input.coverage.retrievableCount} 条消息超出交接预算，且 ${input.target.providerId} 没有已验证的历史检索工具；请缩小范围后重新预览`
  }
  return undefined
}
