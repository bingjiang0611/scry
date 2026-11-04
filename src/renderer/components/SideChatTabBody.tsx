import { useEffect, useRef } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import type { ComposerDraftStore } from '../composer-drafts'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import type { WorkspaceFileTarget } from '../workspace-links'
import { SideChatSurface } from './SideChatSurface'

export interface SideChatTabBodyProps {
  summary?: ConversationSummary
  draftStore: ComposerDraftStore
  agents: ConversationHostChatProps['agents']
  onOpenFile?: (target: WorkspaceFileTarget) => void
  onOpenConversation: (conversation: ConversationSummary) => void
  onChanged: () => void
  onClose: () => void
  /** This body belongs to the child that was just created here. */
  autoFocusComposer?: boolean
  /** The body is mounted; the workspace can forget its one-shot creation marker. */
  onMounted?: () => void
}

/**
 * Body of one mounted child tab.
 *
 * A tab whose summary could not be read keeps its place in the strip and shows that the
 * record is unreadable right now; it is not shown as an empty conversation, and nothing
 * here reads a transcript to fill the gap.
 */
export function SideChatTabBody({ summary, onMounted, ...rest }: SideChatTabBodyProps) {
  // The mount marker is consumed exactly once, so a later rerender cannot re-focus.
  const mountedCallback = useRef(onMounted)
  mountedCallback.current = onMounted
  useEffect(() => { mountedCallback.current?.() }, [])
  if (!summary) {
    return <div className="side-chat-unavailable" role="status" data-side-chat-unavailable>
      {SIDE_CHAT_COPY.tabUnavailable}
    </div>
  }
  return <SideChatSurface
    conversation={summary}
    draftStore={rest.draftStore}
    agents={rest.agents}
    onOpenFile={rest.onOpenFile}
    onOpenConversation={rest.onOpenConversation}
    onChanged={rest.onChanged}
    onClose={rest.onClose}
    {...(rest.autoFocusComposer ? { autoFocusComposer: true } : {})}
  />
}
