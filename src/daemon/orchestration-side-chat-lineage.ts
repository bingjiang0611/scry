import type { Conversation } from '../shared/conversation'
import type { SessionLineageInput } from './orchestration-lineage'

/** Only the fields the lineage needs; a full conversation is accepted as-is. */
export type SideChatConversation = Pick<Conversation, 'id' | 'cwd' | 'sideChat' | 'bindings' | 'title'>

export interface SideChatLineageOptions {
  /** Projected session key for the parent conversation's native session, when it has one. */
  parentSessionKeyOf: (sourceConversationId: string) => string | undefined
}

/**
 * D3: a side chat opens its own native session, so its lineage can only be recorded once the
 * Provider returns that id. Nothing is recorded before then, and a source whose native session is
 * unknown leaves the child unattached instead of pointing at a session that does not exist.
 */
export function sideChatLineageInput(
  conversation: SideChatConversation,
  nativeSessionId: string | undefined,
  options: SideChatLineageOptions
): SessionLineageInput | undefined {
  const origin = conversation.sideChat
  if (!origin || !nativeSessionId) return undefined
  const parentSessionKey = origin.source.kind === 'native-session'
    ? origin.source.nativeSessionId
    : options.parentSessionKeyOf(origin.source.conversationId)
  if (!parentSessionKey || parentSessionKey === nativeSessionId) return undefined
  const binding = conversation.bindings.find((candidate) => candidate.nativeSessionId === nativeSessionId)
    ?? conversation.bindings[0]
  return {
    sessionKey: nativeSessionId,
    parentSessionKey,
    rootSessionKey: parentSessionKey,
    conversationId: conversation.id,
    provider: binding?.providerId ?? null,
    profile: binding?.agentProfileId ?? null,
    cwd: conversation.cwd,
    ...(conversation.title ? { title: conversation.title } : {}),
    lineage: { kind: 'side_chat', source: { sessionKey: parentSessionKey } }
  }
}
