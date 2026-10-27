import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import type { AppView, RemoteTarget } from './app-types'
import type { ResizablePaneState } from './hooks/useResizablePane'
import type { useWorkspaceState } from './hooks/useWorkspaceState'
import type { useIntegrations } from './hooks/useIntegrations'
import type { useAgentSession } from './hooks/useAgentSession'
import type { useSessionRightSurfaces } from './hooks/useSessionRightSurfaces'
import type { RightSurfaceAction } from './right-surface'
import type { DraftAttachment, QueuedPrompt, SessionComposerDraft } from './app-model'
import type { ComposerDraftStore } from './composer-drafts'
import type { AppTheme } from './theme'

export interface AppViewContext {
  theme: AppTheme
  setTheme: Dispatch<SetStateAction<AppTheme>>
  setShowSkills: Dispatch<SetStateAction<boolean>>
  setShowMcp: Dispatch<SetStateAction<boolean>>
  setShowLlmPerformance: Dispatch<SetStateAction<boolean>>
  refreshProviderCatalogs: () => Promise<void>
  view: AppView
  setView: Dispatch<SetStateAction<AppView>>
  cwd: string | null
  setCwd: (cwd: string | null) => void
  openWorkspaceRun: (cwd: string, runId: string) => Promise<void>
  activeSessionId: string | null
  selectSessionId: (id: string | null) => void
  session: ReturnType<typeof useAgentSession>
  integrations: ReturnType<typeof useIntegrations>
  sessionLoading: boolean
  composerSubmitting: boolean
  switchingAgentRef: MutableRefObject<string | undefined>
  setSwitchingAgent: Dispatch<SetStateAction<boolean>>
  setComposerError: Dispatch<SetStateAction<string | null>>
  draftAttachments: DraftAttachment[]
  queuedPrompts: QueuedPrompt[]
  draftKey: string
  draftStore: ComposerDraftStore
  setInput: Dispatch<SetStateAction<string>>
  releaseDraft: (draft: SessionComposerDraft) => void
  selectedProviderSessionId: string | null
  sessionSelectionSeqRef: MutableRefObject<number>
  sessionNavigationSeqRef: MutableRefObject<number>
  activeSessionIdRef: MutableRefObject<string | null>
  cwdRef: MutableRefObject<string | null>
  setSessionDrafts: (update: (drafts: ReadonlyMap<string, SessionComposerDraft>) => ReadonlyMap<string, SessionComposerDraft>) => void
  migrateRightSurface: (from: string, to: string) => void
  loadProjects: () => void | Promise<void>
  recent: ReturnType<typeof useWorkspaceState>['recent']
  chooseFolder: ReturnType<typeof useWorkspaceState>['chooseFolder']
  removeRecentFolder: ReturnType<typeof useWorkspaceState>['removeRecentFolder']
  confirmWorkspaceTransition: () => boolean
  logicalConversation?: ConversationSummary
  setConversationError: Dispatch<SetStateAction<string | undefined>>
  setConversationAgent: Dispatch<SetStateAction<string | undefined>>
  setLogicalConversation: Dispatch<SetStateAction<ConversationSummary | undefined>>
  remoteWorkspaceDirty: boolean
  setRemoteWorkspaceDirty: Dispatch<SetStateAction<boolean>>
  remoteTarget: RemoteTarget | null
  setRemoteTarget: Dispatch<SetStateAction<RemoteTarget | null>>
  remoteAdoptedSession?: string
  setRemoteAdoptedSession: Dispatch<SetStateAction<string | undefined>>
  remoteSurfaces: ReturnType<typeof useSessionRightSurfaces>
  remoteSurfaceKey: string
  remotePanelVisible: boolean
  sidebarPane: ResizablePaneState
  surfacePane: ResizablePaneState
  rightSurfaces: ReturnType<typeof useSessionRightSurfaces>
  rightSurface: ReturnType<typeof useSessionRightSurfaces>['current']['state']
  hasSurfaceContext: boolean
  terminalOpen: boolean
  remoteSurface: ReturnType<typeof useSessionRightSurfaces>['current']['state']
  currentSurface: ReturnType<typeof useSessionRightSurfaces>['current']
  dispatchRightSurface: (action: RightSurfaceAction) => void
  setTurnDiffSelection: (selection: import('./hooks/useDiffReviewSelection').DiffReviewSelection | null) => void
  workspaceRefreshKey: number
  setWorkspaceDirty: (dirty: boolean) => void
  taRef: RefObject<HTMLTextAreaElement>
  setSlashHidden: Dispatch<SetStateAction<boolean>>
  viewRef: MutableRefObject<AppView>
  conversationProjection?: import('./components/ConversationView').ConversationProjection
  sessionEvidenceGap: import('./app-model').SessionEvidenceGap | null
  turnDiffSelection: import('./hooks/useDiffReviewSelection').DiffReviewSelection | null
  setSettingsTab: Dispatch<SetStateAction<import('./components/Modals').SettingsTab | null>>
  newConversation: () => Promise<void>
  unbindProject: () => Promise<void>
  pickRecent: (cwd: string) => Promise<void>
  setSessionLoading: Dispatch<SetStateAction<boolean>>
}
