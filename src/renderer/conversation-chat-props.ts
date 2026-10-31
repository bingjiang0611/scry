import type { ComponentProps } from 'react'
import type { SessionChatView } from './components/ChatView'

/**
 * Parent-owned chat props a conversation instance may inherit.
 *
 * Everything omitted here is owned by `ConversationView`/`ConversationViewBody` for
 * the instance itself: its own turns, draft key, busy/lock state, queue, slash menu,
 * steer evidence, approvals, stop handler and attachment writes. Narrowing the
 * contract is what keeps a side chat from calling the parent's mutators.
 */
export type ConversationHostChatProps = Omit<ComponentProps<typeof SessionChatView>,
  | 'draftStore' | 'draftKey' | 'turns' | 'cwd' | 'workspaceRoots' | 'agentLocked' | 'hasSelectedSession'
  | 'onInput' | 'onSend' | 'submitting' | 'sessionLoading' | 'sessionCacheVisible' | 'sessionEvidenceGap'
  | 'emptyState'
  | 'busy' | 'queueWhileBusy' | 'composerError' | 'composerNotice' | 'draftAttachments'
  | 'queuedPrompts' | 'steerCapability' | 'onSteerQueuedPrompt' | 'slashOpen' | 'slashCmds' | 'slashLoading'
  | 'historyWindow' | 'onLoadOlderTurns' | 'pendingQuestions' | 'stopStates' | 'traceHealth' | 'forkableRunIds'
  | 'onForkTurn' | 'onAnswerQuestion' | 'onStop' | 'onPasteImages'
  | 'onPasteClipboardImage' | 'onRemoveDraftAttachment'>
