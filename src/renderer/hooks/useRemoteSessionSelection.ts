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
    sessionNavigationSeqRef.current += 1
    const request = { sequence: sessionSelectionSeqRef.current, navigationSequence: sessionNavigationSeqRef.current, key }
    pendingSelection.current = request
    const sourceView = viewRef.current
    const commit = (preparedHistory?: PreparedRemoteHistory): void => {
      if (pendingSelection.current !== request || request.sequence !== sessionSelectionSeqRef.current || request.navigationSequence !== sessionNavigationSeqRef.current) return
      if (sourceView === 'remote' && workspaceDirty.current && !window.confirm(REMOTE_ACCESS_COPY.discardWorkspaceChanges)) return
      sessionSelectionSeqRef.current += 1
      setRemoteWorkspaceDirty(false)
      setSessionLoading(false)
      closeOverlays()
      cancelPaneMotion()
      runStructuralTransition('page', () => {
        setRemoteTarget((current) => ({ connectionId, cwd, session, preparedHistory, generation: (current?.generation ?? 0) + 1 }))
        setRemoteAdoptedSession(session?.externalSessionId)
        setView('remote')
      })
    }
    if (!session) { commit(); pendingSelection.current = null; return }
    // Read once before publishing the new context, then seed its controller with
    // that exact result. A failed read opens an explicit error, not stale content.
    void window.scry.desktopRemote.history(connectionId, {
      cwd, providerId: session.providerId, agentProfileId: session.agentProfileId,
      externalSessionId: session.externalSessionId
    }, undefined, undefined).then(history => commit({ status: 'ready', history }),
      error => commit({ status: 'error', error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { if (pendingSelection.current === request) pendingSelection.current = null })
  }
}
