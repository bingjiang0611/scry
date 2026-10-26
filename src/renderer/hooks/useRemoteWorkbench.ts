import { useEffect, useState } from 'react'
import { animatePaneChange } from '../pane-motion'
import { RemotePromptQueueStore } from '../remote-prompt-queue'
import { remoteDraftKey } from '../components/RemoteChat'
import { useDesktopConnections } from './useDesktopConnections'
import { useConnectedCatalogLoader, useViewedRemoteSession } from './useRemoteCatalogs'
import { useSessionRightSurfaces } from './useSessionRightSurfaces'
import type { ResizablePaneState } from './useResizablePane'
import type { AppView, RemoteTarget } from '../app-types'
import type { RightSurfaceAction } from '../right-surface'

// 远程主机的选择、右侧面板身份与重连队列都是独立于本机会话的一组状态；
// 单独成 hook 后 app-interaction 只保留编排，不再堆远端细节。
export function useRemoteWorkbench({ view, surfacePane }: {
  view: AppView
  surfacePane: ResizablePaneState
}) {
  const [remoteTarget, setRemoteTarget] = useState<RemoteTarget | null>(null)
  const [remoteQueueStore] = useState(() => new RemotePromptQueueStore())
  // Native session id adopted after the first run; keeps sidebar and workbench ownership aligned.
  const [remoteAdoptedSession, setRemoteAdoptedSession] = useState<string | undefined>()
  useViewedRemoteSession(view === 'remote' ? remoteTarget?.connectionId : undefined, view === 'remote' ? remoteTarget?.session : undefined)
  const remoteSurfaceKey = remoteTarget
    ? remoteDraftKey(remoteTarget.connectionId, remoteTarget.cwd, remoteAdoptedSession)
    : 'remote:none'
  const remoteSurfaces = useSessionRightSurfaces(remoteSurfaceKey, remoteTarget?.cwd ?? null, 'scry.remote-session-right-surfaces.v1')
  const remoteSurface = remoteSurfaces.current.state
  const [remoteWorkspaceDirty, setRemoteWorkspaceDirty] = useState(false)
  const [remoteSurfaceTarget, setRemoteSurfaceTarget] = useState<HTMLDivElement | null>(null)
  const remotePanelVisible = view === 'remote' && remoteSurface.visible && !surfacePane.collapsed
  const dispatchRemoteSurface = (action: RightSurfaceAction): void => {
    const commit = (): void => {
      if (action.type === 'open' || action.type === 'show') surfacePane.restore()
      remoteSurfaces.dispatch(action)
    }
    if (action.type === 'activate') commit()
    else animatePaneChange(commit)
  }
  const desktopConnections = useDesktopConnections()
  useConnectedCatalogLoader(desktopConnections.connections, desktopConnections.error, desktopConnections.refreshing)
  useEffect(() => {
    if (desktopConnections.refreshing) return
    const connected = new Set(desktopConnections.error ? [] : desktopConnections.connections.filter(connection => connection.state === 'connected').map(connection => connection.id))
    remoteQueueStore.pauseDisconnected(connected)
  }, [desktopConnections.connections, desktopConnections.error, desktopConnections.refreshing, remoteQueueStore])
  return {
    remoteTarget, setRemoteTarget, remoteQueueStore, remoteAdoptedSession, setRemoteAdoptedSession,
    remoteSurfaces, remoteSurface, remoteSurfaceKey, remoteWorkspaceDirty, setRemoteWorkspaceDirty,
    remoteSurfaceTarget, setRemoteSurfaceTarget, remotePanelVisible, dispatchRemoteSurface, desktopConnections
  }
}
