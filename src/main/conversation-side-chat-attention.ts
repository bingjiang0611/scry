import type { Conversation } from '../shared/conversation'
import { conversationAttentionKey, sessionAttentionKey } from '../shared/session-attention'
import { adoptingConversationOf } from './conversation-side-chat'

/**
 * Where a side chat's unread result and questions are kept.
 *
 * A side chat has no sidebar row of its own, so attention keyed by its own id could never be
 * seen or cleared: the Dock badge stayed on with nothing to open. It belongs to the row of the
 * session it was frozen from — a managed parent's conversation key, a native parent's session
 * key, or the conversation that has since adopted that native session. Any other conversation
 * keeps its own key (`undefined`).
 */
export async function sideChatAttentionKey(conversation: Conversation,
  listWorkspace: (cwd: string) => Promise<Conversation[]>): Promise<string | undefined> {
  const source = conversation.sideChat?.source
  if (!source) return undefined
  if (source.kind === 'conversation') return conversationAttentionKey(source.conversationId)
  const native = sessionAttentionKey({ providerId: source.providerId, agentProfileId: source.agentProfileId,
    cwd: source.cwd, sessionId: source.nativeSessionId })
  // An unreadable workspace list only hides whether the session was adopted. It never sends
  // attention back to the child, whose key no row can show or clear.
  const conversations = await listWorkspace(source.cwd).catch(() => undefined)
  const adopted = conversations && adoptingConversationOf(source, conversations)
  return adopted ? conversationAttentionKey(adopted.id) : native
}
