import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopRemoteCatalog, DesktopRemoteConnection } from '@shared/desktop-remote'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { ArchivedRemoteChatsPanel } from './ArchivedRemoteChatsPanel'
import { useRemoteProjectGroups } from './SidebarRemoteProjects'

vi.mock('../hooks/useDesktopConnections', () => ({ useDesktopConnections: vi.fn() }))
vi.mock('../hooks/useRemoteCatalogs', () => ({ useRemoteCatalogs: vi.fn(), refreshRemoteCatalog: vi.fn() }))

const connection: DesktopRemoteConnection = {
  id: 'host-a', label: 'Mac A', hostId: 'a', anchorSHA256: 'anchor',
  ssh: { hostname: 'mac-a', username: 'owner', port: 22 }, state: 'connected', expiresAt: 1
}
const catalog: DesktopRemoteCatalog = {
  projects: [{ path: '/mixed', label: 'Mixed project' }, { path: '/archived-only', label: 'Archived-only project' }],
  providers: [], providerEvidence: 'host_snapshot', sessionActions: true, sessionDelete: true,
  sessions: [
    { sessionId: 'live', externalSessionId: 'live', providerId: 'claude', cwd: '/mixed', label: 'Live session', ts: 1 },
    { sessionId: 'archived', externalSessionId: 'archived', providerId: 'claude', agentProfileId: 'alternate', cwd: '/mixed', label: 'Archived session', ts: 9, archivedAt: 10, pinnedAt: 2 },
    { sessionId: 'only', externalSessionId: 'only', providerId: 'pi', cwd: '/archived-only', label: 'Archived only', ts: 4, archivedAt: 10 }
  ]
}

function Groups({ archived = false }: { archived?: boolean }) {
  const groups = useRemoteProjectGroups('', archived)
  return archived ? <ArchivedRemoteChatsPanel groups={groups} /> : <pre>{JSON.stringify(groups)}</pre>
}

beforeEach(() => {
  vi.mocked(useDesktopConnections).mockReturnValue({ connections: [connection], loaded: true, refreshing: false, error: null })
  vi.mocked(useRemoteCatalogs).mockReturnValue(new Map([[connection.id, { catalog, loading: false }]]))
})

describe('remote archive location', () => {
  it('excludes archived sessions and archived-only projects from sidebar groups and recency', () => {
    const html = renderToStaticMarkup(<Groups />)
    expect(html).toContain('Live session')
    expect(html).not.toContain('Archived session')
    expect(html).not.toContain('Archived-only project')
    expect(html).toContain('&quot;mtime&quot;:1')
  })

  it('lists remote archives by host and project with restore and deletion actions', () => {
    const html = renderToStaticMarkup(<Groups archived />)
    expect(html).toContain('Mac A')
    expect(html).toContain('Archived-only project')
    expect(html).toContain('Archived session')
    expect(html).not.toContain('Live session')
    expect(html).toContain('取消存档：Archived session')
    expect(html).toContain('删除 Scry 副本')
    expect(html).not.toContain('disabled=""')
  })

  it('keeps cached archives visible but disables mutation when disconnected', () => {
    vi.mocked(useDesktopConnections).mockReturnValue({ connections: [{ ...connection, state: 'disconnected' }], loaded: true, refreshing: false, error: null })
    const html = renderToStaticMarkup(<Groups archived />)
    expect(html).toContain('Archived session')
    expect(html.match(/disabled=""/g)).toHaveLength(4)
  })

  it.each(['connections', 'catalog'] as const)('retains history but withdraws live authority during a %s visibility refresh', (source) => {
    vi.mocked(useDesktopConnections).mockReturnValue({ connections: [connection], loaded: true, refreshing: source === 'connections', error: null })
    vi.mocked(useRemoteCatalogs).mockReturnValue(new Map([[connection.id, { catalog, loading: true, stale: source === 'catalog' }]]))
    const html = renderToStaticMarkup(<Groups />)
    expect(html).toContain('Live session')
    expect(html).toContain('&quot;state&quot;:&quot;unknown&quot;')
    expect(html).toContain('&quot;canManage&quot;:false')
    const archived = renderToStaticMarkup(<Groups archived />)
    expect(archived.match(/disabled=""/g)).toHaveLength(4)
  })

  it('disables deletion for legacy sessions without a Provider identity instead of silently doing nothing', () => {
    vi.mocked(useRemoteCatalogs).mockReturnValue(new Map([[connection.id, {
      catalog: { ...catalog, sessions: [{ sessionId: 'legacy', externalSessionId: 'legacy', providerId: 'legacy_unknown', cwd: '/mixed', label: 'Legacy archive', ts: 1, archivedAt: 2 }] }, loading: false
    }]]))
    const html = renderToStaticMarkup(<Groups archived />)
    expect(html).toContain('class="arch-del" disabled=""')
    expect(html).toContain('此历史会话缺少可用的 Provider 身份，无法删除。')
    expect(html).not.toContain('class="arch-unarch" disabled=""')
  })

  it('does not enable operations absent from an older host capability snapshot', () => {
    vi.mocked(useRemoteCatalogs).mockReturnValue(new Map([[connection.id, {
      catalog: { ...catalog, sessionActions: undefined, sessionDelete: undefined }, loading: false
    }]]))
    const html = renderToStaticMarkup(<Groups archived />)
    expect(html.match(/disabled=""/g)).toHaveLength(4)
  })
})
