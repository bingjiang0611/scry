import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useDesktopConnections as useProductionDesktopConnections } from '../../src/renderer/hooks/useDesktopConnections'

// Local Sidebar work-count fixture: remote state is a fixed dependency, not a
// claim about production polling. Returning [] from list() would still publish
// fresh store snapshots every three seconds and contaminate the stream count.
const snapshot: ReturnType<typeof useProductionDesktopConnections> = {
  connections: [], loaded: true, refreshing: false, error: null
}
export function useDesktopConnections() { return snapshot }

// Controlled causality check only. The real store polls with the same missing
// preload API as the original fixture, but its subscriber is outside Sidebar.
function RemotePollProbe() {
  const remote = useProductionDesktopConnections()
  useLayoutEffect(() => {
    document.body.dataset.remoteProbePublication = document.body.dataset.remotePublications ?? '0'
    document.body.dataset.remoteProbeError = remote.error ?? ''
  }, [remote])
  return null
}
export function startRemotePollProbe() {
  const target = document.createElement('div')
  document.body.append(target)
  createRoot(target).render(<RemotePollProbe />)
}
