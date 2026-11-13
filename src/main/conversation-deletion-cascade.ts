import { createHash } from 'node:crypto'
import type { Conversation, SideChatSource } from '../shared/conversation'
import type { ConversationDeletionPreview, SideChatDeletionPreview } from '../shared/conversation-api'
import { SIDE_CHAT_DEFAULT_TITLE } from '../shared/conversation'
import { childNamesSource } from './conversation-side-chat'

/**
 * Side chats that a deletion of one source takes along.
 *
 * A side chat lives only in its parent's panel, so a parent that is deleted would leave its
 * children as records nobody can reach. They are found by their own frozen provenance, with
 * the same identity rule the history list uses. A child whose deletion already completed is
 * not deleted twice; one whose earlier deletion is still pending is planned again.
 */
export function sideChatsOf(sources: readonly SideChatSource[], all: readonly Conversation[]): Conversation[] {
  const owners = new Map(all.map(conversation => [conversation.id, conversation]))
  return all.filter(child => child.sideChat !== undefined && child.deletion?.status !== 'complete' &&
    sources.some(source => childNamesSource(child, owners, source)))
}

export function sideChatTitle(child: Conversation): string {
  return child.title ?? SIDE_CHAT_DEFAULT_TITLE
}

/**
 * The parent plan with its children attached.
 *
 * The fingerprint the user confirms covers every child plan, so a side chat that was
 * created, sent to or removed after the preview refuses the delete instead of being
 * deleted unseen. A parent without children keeps its own plan and fingerprint unchanged.
 */
export function withSideChats(plan: ConversationDeletionPreview, sideChats: readonly SideChatDeletionPreview[]): ConversationDeletionPreview {
  if (sideChats.length === 0) return plan
  const fingerprint = createHash('sha256').update(JSON.stringify({
    parent: plan.fingerprint, sideChats: sideChats.map(child => [child.conversationId, child.fingerprint])
  })).digest('hex')
  return { ...plan, fingerprint, sideChats: [...sideChats] }
}
