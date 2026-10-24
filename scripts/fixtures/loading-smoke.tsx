import { createRoot } from 'react-dom/client'
import { invalidateCache, page } from './session-cache-smoke'
import { LocationPicker } from '../../src/renderer/components/LocationPicker'
import { RemoteDirectoryPicker } from '../../src/renderer/components/RemoteDirectoryPicker'
import { forgetRemoteCatalog } from '../../src/renderer/hooks/useRemoteCatalogs'
import { refreshDesktopConnections } from '../../src/renderer/hooks/useDesktopConnections'
import type { DesktopDirectoryPage, DesktopRemoteCatalog, DesktopRemoteConnection } from '../../src/shared/desktop-remote'

// Reuse the isolated full production App/bridge. Only asynchronous read boundaries
// differ from the existing cache fixture; no Provider or network is available.
document.getElementById('cache-state')!.parentElement!.style.display = 'none'
let delay = 60
let fail = false
let remoteVisible = false
const records: Array<{ kind: string; start: number; end?: number; failed?: boolean }> = []
function request<T>(kind: string, value: () => T): Promise<T> {
  const record = { kind, start: performance.now() } as (typeof records)[number]
  records.push(record)
  const rejectRead = fail
  return new Promise((resolve, reject) => setTimeout(() => {
    record.end = performance.now(); record.failed = rejectRead
    if (rejectRead) reject(new Error('fixture source unavailable'))
    else resolve(value())
  }, delay))
}
const connection: DesktopRemoteConnection = {
  id: 'loading-remote', hostId: 'fixture-host', label: 'Fixture remote', anchorSHA256: 'fixture',
  ssh: { hostname: 'fixture.invalid', username: 'fixture', port: 22 }, state: 'connected', expiresAt: Date.now() + 60_000
}
const catalog: DesktopRemoteCatalog = {
  projects: [{ path: '/remote', label: 'Remote fixture' }], providers: [], sessions: [],
  providerEvidence: 'host_snapshot', directorySelection: true
}
Object.assign(window.scry, {
  loadSession: (context: { externalSessionId?: string }) => request('session', () => page(context.externalSessionId!)),
  listSkills: () => request('skills', () => ({ state: 'ready', mode: 'read', data: [], providerId: 'claude', cwd: '/fixture/cache' })),
  mcpSnapshot: () => request('mcp', () => ({ state: 'ready', mode: 'read', data: { configured: [], runtime: [], operations: { authenticate: [] } }, providerId: 'claude', cwd: '/fixture/cache' })),
  usageAnalytics: () => request('analytics', () => null),
  desktopRemote: {
    list: async () => remoteVisible ? [connection] : [],
    catalog: () => request('projects', () => catalog),
    directories: (_id: string, path = '/remote') => request<DesktopDirectoryPage>('directory', () => ({
      current: { path, label: path }, parent: path === '/remote' ? undefined : { path: '/remote', label: '/remote' },
      directories: path === '/remote' ? [{ path: '/remote/child', label: 'child' }] : [],
      cursor: 0, total: path === '/remote' ? 1 : 0, hasMore: false, snapshot: 'fixture-directory'
    }))
  }
})
function RemoteProjects() {
  return <div id="loading-projects" style={{ position: 'fixed', top: 100, left: 330, width: 600, padding: 20, background: 'var(--bg)', zIndex: 900 }}>
    <LocationPicker current={{ machineId: connection.id, cwd: null }} localCwd={null} recent={[]} open
      onPickLocal={() => {}} onChooseLocalFolder={() => {}} onRemoveRecent={() => {}}
      onPickRemote={() => {}} onManageHosts={() => {}} />
  </div>
}
const extra = document.createElement('div')
extra.id = 'loading-extra'
document.body.append(extra)
const extraRoot = createRoot(extra)
Object.assign(window, { loadingFixture: {
  records,
  configure: (nextDelay: number, nextFail = false) => { delay = nextDelay; fail = nextFail },
  invalidateCache,
  remote: async (kind: 'projects' | 'directory') => {
    forgetRemoteCatalog(connection.id)
    remoteVisible = true
    await refreshDesktopConnections()
    extraRoot.render(kind === 'projects' ? <RemoteProjects key={records.length} />
      : <RemoteDirectoryPicker key={records.length} connection={connection} initialPath="/remote" onPick={() => {}} onClose={() => extraRoot.render(null)} />)
  },
  closeRemote: async () => { extraRoot.render(null); remoteVisible = false; await refreshDesktopConnections() }
} })
