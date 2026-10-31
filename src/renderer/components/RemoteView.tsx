import type { ComponentProps } from 'react'
import type { RemoteTarget } from '../app-types'
import type { useDesktopConnections } from '../hooks/useDesktopConnections'
import { REMOTE_ACCESS_COPY } from '../constants/remote-copy'
import { ViewChrome } from './ViewChrome'
import { RemoteChat } from './RemoteChat'
import { hostState } from './LocationPicker'

export function RemoteView({ target, connections, showPanel, onTogglePanel, ...chat }: {
  target: RemoteTarget
  connections: ReturnType<typeof useDesktopConnections>
  showPanel: boolean
  onTogglePanel: () => void
} & Omit<ComponentProps<typeof RemoteChat>, 'connectionId' | 'cwd' | 'session'>) {
  const connection = connections.connections.find(item => item.id === target.connectionId)
  return <>
    <ViewChrome cwd={target.cwd} showSummary={false} showPanel={showPanel} onTogglePanel={onTogglePanel}
      machine={{
        label: connection?.label ?? REMOTE_ACCESS_COPY.hostUnavailable,
        remote: true,
        state: connection ? hostState(connection, connections.error, connections.refreshing) : 'unknown'
      }} />
    <div className="main-content">
      <RemoteChat key={target.generation} connectionId={target.connectionId} cwd={target.cwd}
        session={target.session} preparedHistory={target.preparedHistory} {...chat} />
    </div>
  </>
}
