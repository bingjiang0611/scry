import { useRef } from 'react'
import type { AppView } from '../app-types'
import type { ProviderId } from '@shared/provider'
import type { AgentQuestionKind } from '@shared/runtime'
import type { ConversationSummary } from '@shared/conversation-api'
import type { RightSurfaceAction } from '../right-surface'
import type { ComposerDraftStore } from '../composer-drafts'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import { useMeasuredNarrow } from './useMeasuredNarrow'
import { useSideChatPanel } from './useSideChatPanel'
import { indexSideChatCatalog } from '../side-chat-index'

/** Chat width that still fits the conversation and a 55/45 workbench side by side. */
const SIDE_BY_SIDE_MIN_CHAT = 880
const RESIZER = 6

/**
 * State of the right workbench of the active session: measured narrow layout, the
 * one-pass side-chat catalog for the sidebar, and the side-chat tab workspace.
 *
 * Kept in one place so the shell states only what it renders. Nothing here polls: the
 * narrow flag comes from a ResizeObserver on the main pane, and the catalog is a single
 * pass over the project list the shell already loaded.
 */
export function useRightWorkbench({
  sidebarWidth, projects, runningRunIds, waitingQuestionRunIds, questionKindsByRun,
  draftKey, view, conversation, cwd, activeSessionId, selectedProviderSessionId, providerId, agentProfileId,
  runControls, completedTurns, draftStore, chatProps, pickConversation, loadProjects, openIds, dispatch,
  dispatchForScope, restorePane, layoutSaved
}: {
  sidebarWidth: number
  projects: readonly Parameters<typeof indexSideChatCatalog>[0]['projects'][number][]
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
  questionKindsByRun: ReadonlyMap<string, AgentQuestionKind>
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
  dispatchForScope: (scopeKey: string, action: RightSurfaceAction) => void
  restorePane: () => void
  layoutSaved: boolean
}) {
  // The observed element is the whole shell, and the budget is the chat region that is
  // left after the sidebar and the pane resizer. Measuring the already-split main pane
  // would collapse the layout into itself: a wide panel would shrink the chat area,
  // which would then hide the panel that caused the measurement.
  const shellRef = useRef<HTMLDivElement>(null)
  const narrowSingleColumn = useMeasuredNarrow(shellRef, SIDE_BY_SIDE_MIN_CHAT + sidebarWidth + RESIZER)
  const catalog = indexSideChatCatalog({ projects, runningRunIds, waitingQuestionRunIds, questionKindsByRun })
  const panel = useSideChatPanel({
    draftKey, view,
    ...(conversation ? { conversation } : {}),
    cwd, activeSessionId, selectedProviderSessionId, providerId,
    ...(agentProfileId ? { agentProfileId } : {}),
    runControls, completedTurns, draftStore, chatProps, pickConversation, loadProjects, openIds, dispatch,
    dispatchForScope, restorePane, runningRunIds, waitingQuestionRunIds, questionKindsByRun
  })
  return { shellRef, narrowSingleColumn, catalog, panel, layoutSaved }
}
