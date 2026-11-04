import { useRef } from 'react'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import type { AppViewContext } from '../app-view-types'
import type { PreparedRemoteHistory } from '../app-types'
import { REMOTE_ACCESS_COPY } from '../constants/copy'
import { cancelPaneMotion } from '../pane-motion'
import { runStructuralTransition } from '../structural-motion'

export function useRemoteSessionSelection({
  remoteWorkspaceDirty, viewRef, sessionSelectionSeqRef, sessionNavigationSeqRef,
  setRemoteWorkspaceDirty, setSessionLoading, setRemoteTarget, setRemoteAdoptedSession, setView
}: Pick<AppViewContext, 'remoteWorkspaceDirty' | 'viewRef' | 'sessionSelectionSeqRef' | 'sessionNavigationSeqRef' |
  'setRemoteWorkspaceDirty' | 'setSessionLoading' | 'setRemoteTarget' | 'setRemoteAdoptedSession' | 'setView'>,
closeOverlays: () => void) {
  const pendingSelection = useRef<{ sequence: number; navigationSequence: number; key: string } | null>(null)
  const workspaceDirty = useRef(remoteWorkspaceDirty)
  workspaceDirty.current = remoteWorkspaceDirty

  return (connectionId: string, cwd: string, session?: RemoteSessionRef): void => {
    const key = JSON.stringify([connectionId, cwd, session?.providerId, session?.agentProfileId, session?.externalSessionId])
    const pending = pendingSelection.current
    if (pending?.sequence === sessionSelectionSeqRef.current && pending.navigationSequence === sessionNavigationSeqRef.current && pending.key === key) return
    const sourceView = viewRef.current
    if (sourceView === 'remote' && workspaceDirty.current && !window.confirm(REMOTE_ACCESS_COPY.discardWorkspaceChanges)) return
    sessionNavigationSeqRef.current += 1
    const request = { sequence: sessionSelectionSeqRef.current, navigationSequence: sessionNavigationSeqRef.current, key }
    pendingSelection.current = request
    const open = (preparedHistory?: PreparedRemoteHistory): boolean => {
      if (pendingSelection.current !== request || request.sequence !== sessionSelectionSeqRef.current || request.navigationSequence !== sessionNavigationSeqRef.current) return false
      request.sequence = ++sessionSelectionSeqRef.current
      setRemoteWorkspaceDirty(false)
      setSessionLoading(preparedHistory?.status === 'loading')
      closeOverlays()
      cancelPaneMotion()
      runStructuralTransition('page', () => {
        setRemoteTarget((current) => ({ connectionId, cwd, session, preparedHistory, generation: (current?.generation ?? 0) + 1 }))
        setRemoteAdoptedSession(session?.externalSessionId)
        setView('remote')
      })
      return true
    }
    const finish = (preparedHistory: PreparedRemoteHistory): void => {
      if (pendingSelection.current !== request || request.sequence !== sessionSelectionSeqRef.current || request.navigationSequence !== sessionNavigationSeqRef.current) return
      setSessionLoading(false)
      setRemoteTarget((current) => current ? { ...current, preparedHistory } : current)
    }
    if (!session) { open(); pendingSelection.current = null; return }
    // Publish the selected session immediately with an empty loading transcript.
    // The old session must never remain visible while the host history read is pending.
    if (!open({ status: 'loading' })) return
    void window.scry.desktopRemote.history(connectionId, {
      cwd, providerId: session.providerId, agentProfileId: session.agentProfileId,
      externalSessionId: session.externalSessionId
    }, undefined, undefined).then(history => finish({ status: 'ready', history }),
      error => finish({ status: 'error', error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { if (pendingSelection.current === request) pendingSelection.current = null })
  }
}
