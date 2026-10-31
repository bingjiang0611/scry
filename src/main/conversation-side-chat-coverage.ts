import { handoffBudget, handoffCoverage, selectHistory } from './conversation-handoff-budget'
import { MAX_SIDE_CHAT_SNAPSHOT_BYTES } from './conversation-side-chat-schema'
import type { SideChatCoverage } from '../shared/conversation-api'
import type { SideChatInitialTarget } from '../shared/conversation'
import { handoffWrapBytes, separatorBytes } from './conversation-side-chat-inline'

/** Same length as a real UUID, so a preview measures the exact bytes a seal will produce. */
export const PREVIEW_CONVERSATION_ID = '00000000-0000-4000-8000-000000000000'
export const PREVIEW_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000001'

/**
 * Measure the frozen prefix with the same budget the first send will use. The
 * future prompt is unknown here, so this is an empty-prompt preflight: send
 * revalidates with the real prompt and attachments, and creation only refuses
 * prefixes that provably cannot be delivered at all.
 */
export function sideChatCoverage(input: {
  conversationId: string
  items: ReadonlyArray<{ role: 'user' | 'assistant'; inlineBytes: number }>
  readerAvailable: boolean
  snapshotBytes: number
}): SideChatCoverage {
  const budget = handoffBudget({ userText: '', attachments: [] })
  // Each message's handoff cost was measured while its text streamed, so the selection
  // here is the same selection the first send will make, without holding any body.
  const selection = selectHistory({
    messages: input.items,
    budget,
    cost: selected => handoffWrapBytes(handoffCoverage({
      conversationId: input.conversationId, selected: selected.length, omitted: input.items.length - selected.length
    })) + selected.reduce((bytes, item) => bytes + item.inlineBytes, 0) +
      separatorBytes() * Math.max(0, selected.length - 1)
  })
  return {
    messageCount: input.items.length,
    inlineCount: selection.messages.length,
    retrievableCount: selection.omitted.length,
    readerAvailable: input.readerAvailable,
    handoffBudgetBytes: budget,
    snapshotBytes: input.snapshotBytes,
    snapshotByteLimit: MAX_SIDE_CHAT_SNAPSHOT_BYTES
  }
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
