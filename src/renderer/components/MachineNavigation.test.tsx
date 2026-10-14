import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopRemoteConnection } from '@shared/desktop-remote'
import { MachineNavigation, SavedRemoteHosts } from './MachineNavigation'
import { DesktopRemote } from './DesktopRemote'
import { refreshDesktopConnections } from '../hooks/useDesktopConnections'

const host: DesktopRemoteConnection = {
  id: 'mac2', label: 'mac2', hostId: 'host', anchorSHA256: 'anchor',
  ssh: { hostname: 'mac2.example', username: 'test', port: 22 }, state: 'connected', expiresAt: 4102444800000
}
const list = vi.fn<() => Promise<DesktopRemoteConnection[]>>()
const hosts = () => renderToStaticMarkup(<SavedRemoteHosts onOpen={() => {}} />)

beforeEach(async () => {
  vi.stubGlobal('window', { scry: { desktopRemote: { list } } })
  list.mockReset().mockResolvedValue([])
  await refreshDesktopConnections()
})
afterEach(() => vi.unstubAllGlobals())

describe('saved desktop host projection', () => {
  it('retains saved hosts when disconnected instead of treating them as unpaired', async () => {
    list.mockResolvedValue([{ ...host, state: 'disconnected' }])
    await refreshDesktopConnections()
    expect(hosts()).toContain('mac2')
    expect(hosts()).toContain('未连接')
    expect(hosts()).not.toContain('尚未添加')
  })

  it('keeps the last known identity but labels failed reads unknown and blocks remote execution', async () => {
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    list.mockRejectedValue(new Error('keychain unavailable'))
    await refreshDesktopConnections()
    expect(hosts()).toContain('mac2')
    expect(hosts()).toContain('状态未知')
    expect(hosts()).not.toContain('已连接')
    const workspace = renderToStaticMarkup(<DesktopRemote initialConnectionId="mac2" onBack={() => {}} />)
    expect(workspace).toContain('不能发送，也不会改成本机执行')
    expect(workspace).not.toContain('正在读取远端目录')
  })

  it('does not let an older connection read erase a newer result', async () => {
    let resolveOld!: (hosts: DesktopRemoteConnection[]) => void
    list.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    const old = refreshDesktopConnections()
    list.mockResolvedValue([host])
    await refreshDesktopConnections()
    resolveOld([])
    await old
    expect(hosts()).toContain('mac2')
  })

  it('keeps an unavailable remote target explicit rather than selecting the local default', () => {
    const html = renderToStaticMarkup(<MachineNavigation targetId="removed" onTarget={() => {}} onOpen={() => {}} onManage={() => {}} />)
    expect(html).toContain('<option value="removed" selected="">远程连接不可用</option>')
    const workspace = renderToStaticMarkup(<DesktopRemote initialConnectionId="removed" onBack={() => {}} />)
    expect(workspace).toContain('所选远程连接已不可用')
    expect(workspace).not.toContain('aria-label="执行位置：本机"')
  })
})
