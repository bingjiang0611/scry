import type { SideChatSource } from '@shared/conversation'
import type { SessionProviderId } from '@shared/provider'

/**
 * Identity of the source a side chat belongs to.
 *
 * A side chat is never a sidebar row and the sidebar prints nothing about it: no group, no
 * row and no counter. These keys only let the activity projection attribute a child's live
 * run to the row of its source.
 */
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
