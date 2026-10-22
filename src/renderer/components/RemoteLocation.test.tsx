import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopRemoteCatalog, DesktopRemoteConnection, RemoteProviderRef } from '@shared/desktop-remote'
import { refreshDesktopConnections } from '../hooks/useDesktopConnections'
import { forgetRemoteCatalog, refreshRemoteCatalog } from '../hooks/useRemoteCatalogs'
import { SidebarRemoteProjects, useRemoteProjectGroups } from './SidebarRemoteProjects'
import { createComposerDraftStore } from '../composer-drafts'
import { RemotePromptQueueStore } from '../remote-prompt-queue'
import { RemotePairing } from './RemotePairing'
import { SettingsModal } from './Modals'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import { LocationPicker, LOCAL_MACHINE } from './LocationPicker'
import { WorkdirPicker } from './Pickers'
import { RemoteChat, remoteDraftKey, remotePermissionOption, remoteRunControlCatalog } from './RemoteChat'
import { createRightSurfaceState } from '../right-surface'
import { RightSurfacePanel } from './RightSurfacePanel'
import { TerminalSurface } from './TerminalSurface'

const host: DesktopRemoteConnection = {
  id: 'mac2', label: 'mac2', hostId: 'host', anchorSHA256: 'anchor',
  ssh: { hostname: 'mac2.example', username: 'test', port: 22 }, state: 'connected', expiresAt: 4102444800000
}
const list = vi.fn<() => Promise<DesktopRemoteConnection[]>>()
const catalog = vi.fn<() => Promise<DesktopRemoteCatalog>>()
function RemoteSidebar() {
  const groups = useRemoteProjectGroups('')
  return <SidebarRemoteProjects groups={groups} active={null} collapsed={new Set()} onToggle={() => {}} onPickSession={() => {}} onNewProjectChat={() => {}} />
}
const hosts = () => renderToStaticMarkup(<RemotePairing onNewSession={() => {}} />)
const picker = (machineId = LOCAL_MACHINE) => renderToStaticMarkup(<LocationPicker
  current={{ machineId, cwd: machineId === LOCAL_MACHINE ? '/work/app' : '/remote/app' }}
  localCwd="/work/app" recent={['/work/app', '/work/other']}
  onPickLocal={() => {}} onChooseLocalFolder={() => {}} onRemoveRecent={() => {}}
  onPickRemote={() => {}} onManageHosts={() => {}}
/>)
const remoteChat = (connectionId: string, draft = '') => {
  const draftStore = createComposerDraftStore(new Map(draft ? [[remoteDraftKey(connectionId, '/remote/app'), { input: draft, attachments: [] }]] : []))
  return renderToStaticMarkup(<RemoteChat
    connectionId={connectionId} cwd="/remote/app" draftStore={draftStore} queueStore={new RemotePromptQueueStore()} onDraftInput={() => {}}
    scrollRef={createRef()} textareaRef={createRef()} renderLocationPicker={() => null}
    onSessionAdopted={() => {}} surface={{ target: null, state: createRightSurfaceState(), onAction: () => {} }}
  />)
}

beforeEach(async () => {
  vi.stubGlobal('window', { scry: { desktopRemote: { list, catalog } } })
  forgetRemoteCatalog(host.id)
  catalog.mockReset().mockResolvedValue({
    projects: [{ path: '/remote/app', label: 'Remote app' }], providers: [], providerEvidence: 'host_snapshot',
    sessions: [{ sessionId: 'remote-session', externalSessionId: 'native', providerId: 'pi', cwd: '/remote/app', label: 'Remote work', ts: 10, isActive: true }]
  })
  list.mockReset().mockResolvedValue([])
  await refreshDesktopConnections()
})
afterEach(() => vi.unstubAllGlobals())

describe('saved host projection', () => {
  it('retains saved hosts when disconnected instead of treating them as unpaired', async () => {
    list.mockResolvedValue([{ ...host, state: 'disconnected' }])
    await refreshDesktopConnections()
    expect(hosts()).toContain('mac2')
    expect(hosts()).toContain('未连接')
    expect(hosts()).not.toContain('还没有添加主机')
  })

  it('keeps outbound hosts and inbound device access as separate sections', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    const html = hosts()
    expect(html).toContain(`aria-label="${copy.outboundTitle}"`)
    expect(html).toContain(`aria-label="${copy.inboundTitle}"`)
    expect(html).not.toContain('打开主机页')
    expect(html).not.toContain('通过 SSH 访问本机')
  })

  it('opens the remote settings tab without claiming unread devices or access are ready', () => {
    const html = renderToStaticMarkup(<SettingsModal initialTab="remote" theme="dark" onThemeChange={() => {}} onSessionsChanged={() => {}} onNewRemoteSession={() => {}} onClose={() => {}} />)
    expect(html).toContain(`class="settings-tab active" aria-current="page"`)
    expect(html).toContain(`class="remote-connections-settings"`)
    expect(html).toContain(copy.loadingDesktopStatus)
    expect(html).not.toContain(copy.noAuthorizedDevices)
    expect(html).not.toContain(copy.relayOnline)
    expect(html).not.toContain('modal-foot')
  })

  it('does not present a failed saved-host read as an empty list', async () => {
    list.mockRejectedValue(new Error('keychain unavailable'))
    await refreshDesktopConnections()
    const html = hosts()
    expect(html).toContain('keychain unavailable')
    expect(html).not.toContain(copy.noHostsHint)
  })

  it('coalesces overlapping connection reads instead of issuing competing snapshots', async () => {
    let resolve!: (hosts: DesktopRemoteConnection[]) => void
    list.mockClear().mockReturnValueOnce(new Promise(done => { resolve = done }))
    const first = refreshDesktopConnections()
    const overlapping = refreshDesktopConnections()
    expect(list).toHaveBeenCalledTimes(1)
    resolve([host])
    await Promise.all([first, overlapping])
    expect(hosts()).toContain('mac2')
    expect(hosts()).toContain(copy.status.connected)
  })
})

describe('remote sidebar activity evidence', () => {
  it.each(['connected', 'disconnected', 'pairing'] as const)('only shows live activity on a connected host (%s)', async (state) => {
    list.mockResolvedValue([{ ...host, state }])
    await refreshDesktopConnections()
    await refreshRemoteCatalog(host.id)
    const html = renderToStaticMarkup(<RemoteSidebar />)
    expect(html).toContain('Remote work')
    expect(html.includes('class="sb-running"')).toBe(state === 'connected')
  })

  it('keeps cached history but not activity after a failed catalog read, including while refreshing', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    await refreshRemoteCatalog(host.id)
    catalog.mockRejectedValueOnce(new Error('catalog unavailable'))
    await refreshRemoteCatalog(host.id)
    let resolve!: (value: DesktopRemoteCatalog) => void
    catalog.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const pending = refreshRemoteCatalog(host.id)
    const html = renderToStaticMarkup(<RemoteSidebar />)
    expect(html).toContain('Remote work')
    expect(html).toContain('data-state="unknown"')
    expect(html).not.toContain('class="sb-running"')
    resolve({ projects: [], providers: [], sessions: [], providerEvidence: 'host_snapshot' })
    await pending
  })
})

describe('composer execution location', () => {
  it('names the authenticated terminal host instead of labeling every terminal local', () => {
    const html = renderToStaticMarkup(<TerminalSurface cwd="/remote/app" active={false} machineLabel="mac2" />)
    expect(html).toContain('aria-label="mac2终端"')
    expect(html).not.toContain('aria-label="本机终端"')
  })

  it('renders exactly the local workdir picker when no host is saved', () => {
    const local = renderToStaticMarkup(<WorkdirPicker cwd="/work/app" recent={['/work/app', '/work/other']}
      onChoose={() => {}} onUnbind={() => {}} onPick={() => {}} onRemove={() => {}} />)
    expect(picker()).toBe(local)
  })

  it('names the machine once a host is saved', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    expect(picker()).toContain('执行位置：本机 / /work/app')
    expect(picker('mac2')).toContain('执行位置：mac2 / /remote/app')
  })

  it('keeps a forgotten remote target explicit instead of showing the local machine', () => {
    const html = picker('removed')
    expect(html).toContain('远程主机不可用')
    expect(html).not.toContain('执行位置：本机')
  })
})

describe('remote conversation guards', () => {
  it('blocks send for a forgotten host and keeps the draft', () => {
    const html = remoteChat('removed', 'unsent draft')
    expect(html).toContain('这台主机已不在保存列表中')
    expect(html).toContain('unsent draft')
    expect(html).toMatch(/<button[^>]*class="send"[^>]*disabled=""/)
  })

  it('labels a failed status read unknown and never as connected', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    list.mockRejectedValue(new Error('keychain unavailable'))
    await refreshDesktopConnections()
    const html = remoteChat('mac2', 'draft')
    expect(html).toContain('无法确认 mac2 的连接状态')
    expect(html).toMatch(/<button[^>]*class="send"[^>]*disabled=""/)
  })

  it('offers an explicit connect action for a disconnected host', async () => {
    list.mockResolvedValue([{ ...host, state: 'disconnected' }])
    await refreshDesktopConnections()
    const html = remoteChat('mac2')
    expect(html).toContain('mac2 未连接。草稿会保留，连接后不会自动发送。')
    expect(html).toContain('>连接</button>')
  })

  it('does not advertise a local Shell for an unavailable remote terminal', () => {
    const html = renderToStaticMarkup(<RightSurfacePanel
      openIds={[]} activeId={null} contents={{}} maximized={false}
      unavailable={{ terminal: 'mac2 暂未提供终端；不会启动本机 Shell。' }}
      onOpen={() => {}} onActivate={() => {}} onClose={() => {}} onHide={() => {}} onToggleMaximized={() => {}}
    />)
    expect(html).toContain('mac2 暂未提供终端；不会启动本机 Shell。')
    expect(html).not.toContain('启动本机 Shell；未绑定时从用户主目录开始。')
  })

  it('names the executing host in permission copy instead of this Mac', () => {
    const full = remotePermissionOption({ id: 'full_access', label: '本机完全访问' }, 'mac2')
    expect(full.label).toBe('完全访问 · mac2')
    expect(full.description).toContain('mac2 上的用户权限')
    const provider: RemoteProviderRef = {
      id: 'claude', label: 'Claude', available: true,
      models: [{ id: 'm1', label: 'M1' }], efforts: [{ id: 'high', label: 'High' }],
      permissions: [{ id: 'default', label: '默认审批' }]
    }
    const catalog = remoteRunControlCatalog(provider, 'mac2')
    expect(catalog.permissions[0].label).toBe('默认审批 · mac2')
    expect(catalog.models[0].efforts.map(effort => effort.id)).toEqual(['high'])
  })
})
