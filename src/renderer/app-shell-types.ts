import type { ComponentProps, Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import type { RuntimeProvider } from '@shared/runtime'
import type { WorkspaceEntry } from '@shared/workspace'
import type { ConversationSummary } from '@shared/conversation-api'
import type { SessionRef } from './env'
import type { AppView, AppStyle, RemoteTarget } from './app-types'
import type { useWorkspaceState } from './hooks/useWorkspaceState'
import type { useIntegrations } from './hooks/useIntegrations'
import type { useAgentSession } from './hooks/useAgentSession'
import type { useDesktopConnections } from './hooks/useDesktopConnections'
import type { useSessionRightSurfaces } from './hooks/useSessionRightSurfaces'
import type { SettingsTab } from './components/Modals'
import type { RightSurfaceAction } from './right-surface'
import type { WorkspaceOpenRequest } from './components/WorkspacePanel'
import type { ExecutionLocation } from './components/LocationPicker'
import type { ConversationProjection } from './components/ConversationView'
import type { SessionChatView } from './components/ChatView'

export interface AppShellProps {
  appStyle: AppStyle
  view: AppView
  sidebarPane: ReturnType<typeof import('./hooks/useResizablePane').useResizablePane>
  surfacePane: ReturnType<typeof import('./hooks/useResizablePane').useResizablePane>
  shellPanelMounted: boolean
  shellPanelVisible: boolean
  shellPanelMaximized: boolean
  summaryVisible: boolean
  summaryPersistent: boolean
  draftStore: ReturnType<typeof import('./composer-drafts').createComposerDraftStore>
  chatProps: ComponentProps<typeof SessionChatView>
  sidebarActions: Record<string, unknown>
  projects: ReturnType<typeof useWorkspaceState>['projects']
  cwd: string | null
  activeSessionId: string | null
  logicalConversation?: ConversationSummary
  conversationError?: string
  conversationAgent?: string
  loadProjects: ReturnType<typeof useWorkspaceState>['loadProjects']
  setConversationProjection: (projection: ConversationProjection | undefined) => void
  pickConversation: (conversation: ConversationSummary) => void
  desktopConnections: ReturnType<typeof useDesktopConnections>
  remoteTarget: RemoteTarget | null
  remoteQueueStore: import('./remote-prompt-queue').RemotePromptQueueStore
  setRemoteDraft: (key: string, value: string) => void
  scrollRef: RefObject<HTMLDivElement>
  taRef: RefObject<HTMLTextAreaElement>
  renderLocationPicker: (current: ExecutionLocation) => (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => JSX.Element
  remoteSurfaceKey: string
  remoteSurfaces: ReturnType<typeof useSessionRightSurfaces>
  remoteSurfaceTarget: HTMLDivElement | null
  setRemoteSurfaceTarget: (target: HTMLDivElement | null) => void
  remoteSurface: ReturnType<typeof useSessionRightSurfaces>['current']['state']
  remotePanelVisible: boolean
  remoteAdoptedSession?: string
  setRemoteAdoptedSession: (session: string | undefined) => void
  setRemoteTarget: Dispatch<SetStateAction<RemoteTarget | null>>
  dispatchRemoteSurface: (action: RightSurfaceAction) => void
  returnFromMetaPrompts: () => void
  insertMetaPrompt: (body: string) => void
  metaPromptTarget: MutableRefObject<{ view: 'chat' | 'conversation' | 'remote'; draftKey: string }>
  integrations: ReturnType<typeof useIntegrations>
  session: ReturnType<typeof useAgentSession>
  displayedTurns: ComponentProps<typeof SessionChatView>['turns']
  displayedBusy: boolean
  selectedProviderSessionId: string | null
  panelRuntimeProvider: RuntimeProvider
  showSessionOverview: boolean
  panelVisible: boolean
  currentSurface: ReturnType<typeof useSessionRightSurfaces>['current']
  rightSurface: ReturnType<typeof useSessionRightSurfaces>['current']['state']
  rightSurfaces: ReturnType<typeof useSessionRightSurfaces>
  handleRightSurfaceAction: (action: RightSurfaceAction) => void
  openTurnInChat: (runId: string, event?: import('@shared/trace').TraceEvent | null, target?: 'turn' | 'event') => void
  diffInspector: ReturnType<typeof import('./hooks/useDiffInspector').useDiffInspector>
  openWorkspaceDiff: () => void
  workspaceRefreshKey: number
  workspaceOpenRequests: ReadonlyMap<string, WorkspaceOpenRequest>
  setScopeDirty: (id: string, dirty: boolean) => void
  addWorkspaceReference: (entry: WorkspaceEntry) => void
  showLlmPerformance: boolean
  setShowLlmPerformance: (show: boolean) => void
  showSkills: boolean
  showMcp: boolean
  openSkills: () => void
  openMcp: () => void
  settingsTab: SettingsTab | null
  setSettingsTab: (tab: SettingsTab | null) => void
  theme: import('./theme').AppTheme
  changeTheme: (theme: import('./theme').AppTheme) => void
  archiveUndo: { ref: SessionRef; preview: string } | null
  setArchiveUndo: (value: { ref: SessionRef; preview: string } | null) => void
  workspace: ReturnType<typeof useWorkspaceState>
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
  unreadSessionKeys: ReadonlySet<string>
  backgroundWorkByRun: ReturnType<typeof import('./hooks/useBackgroundWork').useBackgroundWork>
  catalogHealth: ReturnType<typeof useWorkspaceState>['catalogHealth']
  summary: ReturnType<typeof import('./components/PinnedSummary').usePinnedSummaryVisibility>
  sidebarMin: number
  sidebarMax: number
  panelMin: number
  panelMax: number
  rightPanelMounted: boolean
  mountedSurfaces: ReturnType<typeof useSessionRightSurfaces>['surfaces']
  setRemoteWorkspaceDirty: (dirty: boolean) => void
  toggleOverviewPanel: () => void
  changeView: (view: AppView) => boolean
  openRemoteLocation: (connectionId: string, cwd: string, session?: import('@shared/desktop-remote').RemoteSessionRef) => void
  setShowSkills: (show: boolean) => void
  setShowMcp: (show: boolean) => void
}
