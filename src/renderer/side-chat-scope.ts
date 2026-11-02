import type { SideChatInitialTarget, SideChatSource } from '@shared/conversation'
import type { ProviderId } from '@shared/provider'
import type { AgentRunControls } from '@shared/runtime'
import type { ConversationSummary } from '@shared/conversation-api'
import type { AppView } from './app-types'
import { SIDE_CHAT_COPY } from './constants/side-chat-copy'

export interface SideChatScope {
  /** Stable layout scope of the parent; a promoted session keeps the same children. */
  scopeKey: string
  source?: SideChatSource
  /** Runtime intent copied from the parent controls; main revalidates it on send. */
  target?: SideChatInitialTarget
  hasCompletedTurn: boolean
  /** Set when no child can be created at all, with the real reason. */
  unavailableReason?: string
}

/**
 * Identity of the parent a new side chat belongs to.
 *
 * A managed conversation is addressed by its own id. A native session keeps the exact
 * Provider/profile/cwd/session tuple the catalog uses, so an owned native alias can
 * never be presented as a second, unrelated source. The requested target is the parent's
 * current controls: an intent, never a claim about the source's own account or model.
 *
 * Only the conversation view has a logical conversation. A conversation left over from
 * another view is not this scope's parent: reading it anyway once turned a reopened
 * Provider session into "another side chat's source", which hid its children.
 */
export function sideChatScope({
  draftKey, view, conversation, providerId, agentProfileId, runControls, cwd, nativeSessionId,
  completedTurns, apiAvailable
}: {
  draftKey: string
  view: AppView
  conversation?: ConversationSummary
  providerId: ProviderId
  agentProfileId?: string
  runControls: AgentRunControls
  cwd: string | null
  nativeSessionId: string | null
  completedTurns: number
  apiAvailable: boolean
}): SideChatScope {
  const target: SideChatInitialTarget = {
    providerId,
    ...(agentProfileId ? { agentProfileId } : {}),
    ...(runControls.model ? { model: { ...runControls.model } } : {}),
    ...(runControls.effort ? { effort: runControls.effort } : {}),
    permissionMode: runControls.permissionMode
  }
  if (!apiAvailable) {
    return { scopeKey: draftKey, target, hasCompletedTurn: false, unavailableReason: SIDE_CHAT_COPY.entryUnavailableApi }
  }
  const parent = view === 'conversation' ? conversation : undefined
  // A side chat has its own frozen source; nesting one inside another is refused here
  // and by the host, which keeps provenance a single hop.
  if (parent?.sideChat) {
    return { scopeKey: draftKey, target, hasCompletedTurn: completedTurns > 0,
      unavailableReason: SIDE_CHAT_COPY.entryUnavailableNested }
  }
  if (parent) {
    return { scopeKey: draftKey, source: { kind: 'conversation', conversationId: parent.id },
      target, hasCompletedTurn: completedTurns > 0 }
  }
  if (view !== 'conversation' && cwd && nativeSessionId) {
    return {
      scopeKey: draftKey,
      source: { kind: 'native-session', providerId, ...(agentProfileId ? { agentProfileId } : {}),
        cwd, nativeSessionId },
      target,
      hasCompletedTurn: completedTurns > 0
    }
  }
  return { scopeKey: draftKey, target, hasCompletedTurn: completedTurns > 0,
    unavailableReason: SIDE_CHAT_COPY.entryUnavailableNoSource }
}
