import type { RemoteSessionRef } from '@shared/desktop-remote'
import type { ProjectMeta } from './env'
import type { RemotePromptQueueStore } from './remote-prompt-queue'
import type { AppView, RemoteTarget } from './app-types'
import { remoteDraftKey } from './components/RemoteChat'
import { useEventCallback } from './hooks/useEventCallback'

export interface AppSidebarActionsContext {
  startNewConversation: () => Promise<void>
  openRemoteLocation: (connectionId: string, cwd: string, session?: RemoteSessionRef) => void
  remoteQueueStore: RemotePromptQueueStore
  view: AppView
  remoteTarget: RemoteTarget | null
  remoteAdoptedSession?: string
  pickSession: (...args: [string, string, import('@shared/provider').SessionProviderId, string?, string?, string?, string?, string?]) => Promise<void>
  togglePinSession: (...args: Parameters<ReturnType<typeof import('./app-session-actions').createSessionActions>['togglePinSession']>) => Promise<void>
  archiveSession: (...args: Parameters<ReturnType<typeof import('./app-session-actions').createSessionActions>['archiveSession']>) => Promise<void>
  renameSession: (...args: Parameters<ReturnType<typeof import('./app-session-actions').createSessionActions>['renameSession']>) => Promise<void>
  newConversationInProject: (cwd: string) => Promise<void>
  pickConversation: (conversation: import('@shared/conversation-api').ConversationSummary) => void
  toggleProjectPin: (project: ProjectMeta) => Promise<void>
  renameProject: (project: ProjectMeta, name: string) => Promise<void>
  removeProject: (project: ProjectMeta) => Promise<void>
  undoArchive: () => Promise<void>
  changeView: (view: AppView) => boolean
  openLlmPerformance: () => void
  openSkills: () => void
  openMcp: () => void
  openMetaPrompts: () => void
  setSettingsTab: (tab: import('./components/Modals').SettingsTab | null) => void
}

export function useAppSidebarActions(context: AppSidebarActionsContext) {
  const { startNewConversation, openRemoteLocation, remoteQueueStore, view, remoteTarget, remoteAdoptedSession, pickSession,
    togglePinSession, archiveSession, renameSession, newConversationInProject, pickConversation, toggleProjectPin, renameProject,
    removeProject, undoArchive, changeView, openLlmPerformance, openSkills, openMcp, openMetaPrompts, setSettingsTab } = context

  const sidebarActions = {
    onNewChat: useEventCallback(startNewConversation),
    onPickRemoteSession: useEventCallback((connectionId: string, remoteSession: RemoteSessionRef) => openRemoteLocation(connectionId, remoteSession.cwd, remoteSession)),
    onNewRemoteProjectChat: useEventCallback((connectionId: string, remoteCwd: string) => openRemoteLocation(connectionId, remoteCwd)),
    onArchiveRemoteSession: useEventCallback((connectionId: string, remoteSession: RemoteSessionRef) => {
      remoteQueueStore.clearSession(remoteDraftKey(connectionId, remoteSession.cwd, remoteSession.externalSessionId))
    }),
    onArchivedRemoteSession: useEventCallback((connectionId: string, remoteSession: RemoteSessionRef) => {
      if (view === 'remote' && remoteTarget?.connectionId === connectionId && remoteTarget.cwd === remoteSession.cwd &&
        remoteAdoptedSession === remoteSession.externalSessionId && remoteTarget.session?.providerId === remoteSession.providerId &&
        (remoteTarget.session?.agentProfileId ?? '') === (remoteSession.agentProfileId ?? '')) {
        openRemoteLocation(connectionId, remoteSession.cwd)
      }
    }),
    onPick: useEventCallback(pickSession),
    onTogglePin: useEventCallback(togglePinSession),
    onArchive: useEventCallback(archiveSession),
    onRenameSession: useEventCallback(renameSession),
    onNewProjectChat: useEventCallback(newConversationInProject),
    onPickConversation: useEventCallback(pickConversation),
    onToggleProjectPin: useEventCallback(toggleProjectPin),
    onRenameProject: useEventCallback(renameProject),
    onRemoveProject: useEventCallback(removeProject),
    onRevealProject: useEventCallback((project: ProjectMeta) => window.scry.revealProject(project.cwd)),
    onUndoArchive: useEventCallback(undoArchive),
    onAnalytics: useEventCallback(() => changeView('analytics')),
    onLlmPerformance: useEventCallback(openLlmPerformance),
    onSkills: useEventCallback(openSkills),
    onMcp: useEventCallback(openMcp),
    onMetaPrompts: useEventCallback(openMetaPrompts),
    onSettings: useEventCallback(() => setSettingsTab('appearance'))
  }
  return sidebarActions
}
