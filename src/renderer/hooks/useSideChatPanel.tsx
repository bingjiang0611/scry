import type { ReactNode } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import type { ProviderId } from '@shared/provider'
import type { AppView } from '../app-types'
import type { RightSurfaceAction } from '../right-surface'
import type { ComposerDraftStore } from '../composer-drafts'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import type { WorkspaceFileTarget } from '../workspace-links'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import { SideChatTabBody } from '../components/SideChatTabBody'
import { useSideChatWorkspace } from './useSideChatWorkspace'
import { sideChatScope } from '../side-chat-scope'

/**
 * Composition of the side-chat workspace of the active parent session.
 *
 * Kept out of the shell so the panel wiring stays readable: this hook owns the pinned
 * source identity, the tab summaries and the creation entry, and it renders one child
 * body at a time. Tool surfaces stay owned by the shell.
 */
export function useSideChatPanel({
  draftKey, view, conversation, cwd, activeSessionId, selectedProviderSessionId, providerId, agentProfileId,
  runControls, completedTurns, draftStore, chatProps, pickConversation, loadProjects, openIds, dispatch,
  dispatchForScope, restorePane, runningRunIds, waitingQuestionRunIds, questionKindsByRun
}: {
  draftKey: string
  view: AppView
  conversation?: ConversationSummary
  cwd: string | null
  activeSessionId: string | null
  selectedProviderSessionId: string | null
  providerId: ProviderId
  agentProfileId?: string
  runControls: ConversationHostChatProps['runControls']
  completedTurns: number
  draftStore: ComposerDraftStore
  chatProps: Pick<ConversationHostChatProps, 'agents' | 'onOpenFile'>
  pickConversation: (conversation: ConversationSummary) => void
  loadProjects: () => void | Promise<void>
  openIds: readonly string[]
  dispatch: (action: RightSurfaceAction) => void
  /** Applies a tab action to another parent scope's stored layout. */
  dispatchForScope: (scopeKey: string, action: RightSurfaceAction) => void
  restorePane: () => void
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
  questionKindsByRun: ReadonlyMap<string, import('@shared/runtime').AgentQuestionKind>
}) {
  const scope = sideChatScope({
    draftKey, view,
    ...(conversation ? { conversation } : {}),
    providerId,
    ...(agentProfileId ? { agentProfileId } : {}),
    runControls,
    cwd,
    nativeSessionId: selectedProviderSessionId ?? activeSessionId,
    completedTurns,
    // Static render and tests have no preload bridge; treat that as "api unavailable"
    // rather than reaching for a `window` that does not exist.
    apiAvailable: typeof window !== 'undefined' && Boolean(window.scry?.conversations)
  })
  const statusOf = (child: ConversationSummary): string | undefined => {
    const runId = child.activeRunId
    if (!runId) return undefined
    if (waitingQuestionRunIds.has(runId)) {
      // Only a real permission request is presented as an approval need; a
      // clarification is ordinary attention, not a permission decision.
      return questionKindsByRun.get(runId) === 'permission'
        ? SIDE_CHAT_COPY.tabStatusPermission : SIDE_CHAT_COPY.tabStatusAttention
    }
    return runningRunIds.has(runId) ? SIDE_CHAT_COPY.tabStatusRunning : undefined
  }
  const api = typeof window === 'undefined' ? undefined : window.scry?.conversations
  const workspace = useSideChatWorkspace({
    ...(api ? { api } : {}),
    scopeKey: scope.scopeKey,
    ...(scope.source ? { source: scope.source } : {}),
    ...(scope.target ? { target: scope.target } : {}),
    openIds,
    hasCompletedTurn: scope.hasCompletedTurn,
    ...(scope.unavailableReason ? { unavailableReason: scope.unavailableReason } : {}),
    statusOf,
    // The child is opened in the scope it was created for. Switching parents while a
    // create is in flight must not move the tab into whatever is on screen now.
    onOpen: (conversationId, openScopeKey) => {
      if (openScopeKey === scope.scopeKey) { restorePane(); dispatch({ type: 'open-side-chat', conversationId }) }
      else dispatchForScope(openScopeKey, { type: 'open-side-chat', conversationId })
    },
    onDrop: (conversationIds) => dispatch({ type: 'drop-side-chats', conversationIds }),
    onClose: (conversationId) => dispatch({ type: 'close-side-chat', conversationId })
  })
  const renderTab = (conversationId: string): ReactNode => <SideChatTabBody
    summary={workspace.records.get(conversationId)}
    {...(workspace.createdId === conversationId ? { autoFocusComposer: true } : {})}
    onMounted={() => { if (workspace.createdId === conversationId) workspace.clearCreated() }}
    draftStore={draftStore}
    agents={chatProps.agents}
    {...(chatProps.onOpenFile ? { onOpenFile: chatProps.onOpenFile as (target: WorkspaceFileTarget) => void } : {})}
    onOpenConversation={pickConversation}
    onChanged={() => { workspace.refresh(); void loadProjects() }}
    onClose={() => dispatch({ type: 'close-side-chat', conversationId })}
  />
  return {
    tabs: workspace.tabs,
    entry: workspace.entry,
    records: workspace.records,
    history: workspace.history,
    renderTab,
    activate: (conversationId: string) => dispatch({ type: 'activate-side-chat', conversationId }),
    close: (conversationId: string) => dispatch({ type: 'close-side-chat', conversationId })
  }
}
