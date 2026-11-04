import { useMemo, type ReactNode, type RefObject } from 'react'
import type { RightSurfaceAction, RightSurfaceState } from '../right-surface'
import type { RemoteProviderRef, RemoteSessionRef } from '@shared/desktop-remote'
import { useWorkspaceSelection } from '../hooks/useWorkspaceSelection'
import type { ComposerDraftStore } from '../composer-drafts'
import type { PreparedRemoteHistory } from '../app-types'
import { RemotePromptQueueStore } from '../remote-prompt-queue'
import './desktop-remote.css'
import './remote-location.css'
import { useRemoteChatFoundation } from './RemoteChatFoundation'
import { useRemoteChatControls } from './RemoteChatControls'
import { useRemoteChatPresentation } from './RemoteChatPresentation'
import { useRemoteChatExecution } from './RemoteChatExecution'
import { RemoteChatView } from './RemoteChatView'

// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.


export { errorText, remoteAgentId, remoteControlsValid, remoteDraftKey, remotePermissionOption, remoteRunControlCatalog } from './RemoteChatShared'

export interface RemoteChatProps {
  connectionId: string
  cwd: string
  session?: RemoteSessionRef
  preparedHistory?: PreparedRemoteHistory
  draftStore: ComposerDraftStore
  queueStore: RemotePromptQueueStore
  onDraftInput: (key: string, value: string) => void
  scrollRef: RefObject<HTMLDivElement>
  textareaRef: RefObject<HTMLTextAreaElement>
  renderLocationPicker: (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode
  onSessionAdopted: (externalSessionId: string, provider: RemoteProviderRef) => void
  surface: {
    target: HTMLElement | null
    primaryVisible: boolean
    state: RightSurfaceState
    scopeId?: string
    retainTerminal?: boolean
    onDirtyChange?: (dirty: boolean) => void
    onAction: (action: RightSurfaceAction) => void
  }
}

export function RemoteChat({
  connectionId,
  cwd,
  session,
  preparedHistory,
  draftStore,
  queueStore,
  onDraftInput,
  scrollRef,
  textareaRef,
  renderLocationPicker,
  onSessionAdopted,
  surface
}: RemoteChatProps) {
  const foundationState = useRemoteChatFoundation({ connectionId, cwd, session, preparedHistory, draftStore, queueStore, surface })
  const workspaceBackend = useMemo(() => ({
    read: (request: Parameters<typeof foundationState.api.workspaceChoices>[1]) => foundationState.api.workspaceChoices(connectionId, request),
    validateBranch: (request: { repositoryId: string; name: string }) => foundationState.api.validateWorkspaceBranch(connectionId, { cwd, ...request })
  }), [foundationState.api, connectionId, cwd])
  const workspaceSelection = useWorkspaceSelection({
    cwd, draftKey: foundationState.draftKey, draftStore,
    editable: foundationState.connected && foundationState.catalog?.managedWorktrees === 1 && !foundationState.sessionId,
    active: foundationState.connected && foundationState.catalog?.managedWorktrees === 1 && !foundationState.sessionId,
    busy: foundationState.submitting || foundationState.connecting,
    selectionEpoch: 0,
    backend: workspaceBackend
  })
  const controlsState = useRemoteChatControls(foundationState, { connectionId, cwd, draftStore, queueStore, onSessionAdopted })
  const { controlProvider } = controlsState
  const presentationState = useRemoteChatPresentation(foundationState, controlProvider, { scrollRef, cwd, queueStore, surface })
  const executionState = useRemoteChatExecution(foundationState, presentationState, { connectionId, draftStore, queueStore })
  return <RemoteChatView
    {...foundationState} {...presentationState} {...executionState} {...controlsState}
    connectionId={connectionId} cwd={cwd} session={session} draftStore={draftStore} queueStore={queueStore}
    onDraftInput={onDraftInput} scrollRef={scrollRef} textareaRef={textareaRef}
    renderLocationPicker={renderLocationPicker} onSessionAdopted={onSessionAdopted} surface={surface}
    workspaceSelection={workspaceSelection}
  />
}
