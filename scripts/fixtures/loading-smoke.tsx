import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CapabilitiesModal, McpModal, SkillsModal } from '../../src/renderer/components/Modals'
import { useIntegrations } from '../../src/renderer/hooks/useIntegrations'
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
const inventoryProjects: [] = []
let inventoryKey = 0
let startInventory: () => void
function InventoryRead({ kind, legacy }: { kind: 'skills' | 'mcp'; legacy: boolean }) {
  const [started, setStarted] = useState(false)
  startInventory = () => setStarted(true)
  const integrations = useIntegrations('/fixture/cache', null, inventoryProjects, started ? kind : null)
  const close = () => extraRoot.render(null)
  if (legacy && kind === 'skills') return <SkillsModal skills={integrations.skills} capability={integrations.skillCapability}
    refreshing={integrations.skillsRefreshing} onRefresh={integrations.refreshSkills} onClose={close} />
  if (legacy) return <McpModal mcps={integrations.mcps} capability={integrations.mcpCapability} status={integrations.mcpStatus}
    live={integrations.mcpLive} refreshing={integrations.mcpRefreshing} configRefreshing={integrations.mcpConfigRefreshing}
    onTest={integrations.testMcp} onRefresh={() => { void integrations.refreshMcp().catch(() => {}) }} onClose={close} />
  return <CapabilitiesModal view={kind} onViewChange={() => {}} skills={integrations.skills} skillCapability={integrations.skillCapability}
    skillsRefreshing={integrations.skillsRefreshing} onRefreshSkills={integrations.refreshSkills} mcps={integrations.mcps}
    mcpCapability={integrations.mcpCapability} status={integrations.mcpStatus} live={integrations.mcpLive}
    mcpRefreshing={integrations.mcpRefreshing} mcpConfigRefreshing={integrations.mcpConfigRefreshing}
    onTestMcp={integrations.testMcp} onRefreshMcp={integrations.pullMcpLive} onClose={close} />
}
Object.assign(window, { loadingFixture: {
  records,
  inventory: (kind: 'skills' | 'mcp', legacy: boolean) => extraRoot.render(<InventoryRead key={++inventoryKey} kind={kind} legacy={legacy} />),
  startInventory: () => startInventory(),
  closeInventory: () => extraRoot.render(null),
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
