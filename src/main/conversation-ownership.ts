import type { Conversation, ConversationBinding, ConversationTarget } from '../shared/conversation'

/** Single main-process owner. No Provider calls, workspace writes or automatic retry occur here. */
export type NativeSessionScope = Pick<ConversationTarget, 'providerId' | 'agentProfileId'> & {
  cwd: string
  nativeSessionId?: string
}

// Legacy callers cannot prove continuationKey. Keep their physical scope conservative:
// changing compatibility configuration must not release an existing conversation's owner.
export function nativeOwnerKey(cwd: string, binding: ConversationBinding): string {
  return JSON.stringify([binding.providerId, binding.agentProfileId ?? null, cwd, binding.nativeSessionId])
}

/** A source snapshot's frozen provenance is not native ownership of the child. */
export function checkNativeOwners(conversations: Iterable<Conversation>): void {
  const owners = new Map<string, string>()
  for (const conversation of conversations) {
    for (const binding of conversation.bindings) {
      if (!binding.nativeSessionId) continue
      const key = nativeOwnerKey(conversation.cwd, binding)
      const owner = owners.get(key)
      if (owner !== undefined && owner !== conversation.id) throw new Error('原生会话已归属其他统一对话')
      owners.set(key, conversation.id)
    }
  }
}
