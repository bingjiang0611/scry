import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BackgroundServiceStatus } from '../../shared/background-service'
import { describeActionResult, formatUptime } from '../background-service-view'
import { BackgroundServicePanel } from './BackgroundServiceSettings'
import { SettingsModal } from './Modals'

// The «后台服务» section's states as the user sees them. A value main could not
// establish is 未知; the actions offered follow the connection state.

const NOW = 1_700_000_000_000

function daemon(overrides: Partial<Extract<BackgroundServiceStatus, { mode: 'daemon' }>> = {}): BackgroundServiceStatus {
  return {
    mode: 'daemon', userDataDir: '/Users/me/Library/Application Support/Scry', connection: { state: 'ready' },
    version: '2.0.0', pid: 4242, startedAt: NOW - 2 * 3_600_000 - 5 * 60_000,
    devices: { state: 'known', paired: 2 }, activeRuns: 1, checkedAt: NOW,
    ...overrides
  }
}

const render = (status: BackgroundServiceStatus | null, extra: Partial<Parameters<typeof BackgroundServicePanel>[0]> = {}) =>
  renderToStaticMarkup(<BackgroundServicePanel status={status} readError={null} busy={null} result={null} now={NOW} onRefresh={() => {}} onAction={() => {}} {...extra} />)

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(([, label]) => label)

describe('BackgroundServicePanel', () => {
  it('shows the connected service with every field and the restart and quit actions', () => {
    const html = render(daemon())
    for (const text of ['已连接', '2.0.0', 'pid 4242', '2 小时 5 分钟', 'Application Support/Scry', '2 台', '1 个']) expect(html).toContain(text)
    expect(buttons(html)).toEqual(['刷新', '重启后台服务', '退出 Scry 与后台服务'])
    expect(html).not.toContain('class="unknown"')
    expect(html).toContain('普通的退出 Scry 不会停止后台服务')
  })

  it('offers restart first on a version mismatch and shows what it does not know as 未知', () => {
    const html = render(daemon({
      connection: { state: 'version-mismatch', running: '1.0.0', expected: '2.0.0' },
      version: '1.0.0', startedAt: null, devices: null, activeRuns: null
    }))
    expect(html).toContain('后台服务的版本（1.0.0）与本 App（2.0.0）不一致')
    expect(html).toContain('class="btn primary "')
    expect(html.match(/class="unknown"/g)?.length).toBe(3)
    // Unknown is never a count.
    expect(html).not.toContain('0 台')
    expect(html).not.toContain('0 个')
  })

  it('offers reconnect only after the local grant was refused, and says it never happens by itself', () => {
    const revoked = render(daemon({ connection: { state: 'device-not-authorized' }, version: null, startedAt: null, devices: null, activeRuns: null }))
    expect(buttons(revoked)).toEqual(['刷新', '重新连接本机后台服务', '重启后台服务', '退出 Scry 与后台服务'])
    expect(revoked).toContain('不会自动重新连接')
    expect(buttons(render(daemon()))).not.toContain('重新连接本机后台服务')
  })

  it('names why the service is unavailable', () => {
    const html = render(daemon({ connection: { state: 'unavailable', reason: 'daemon_userdata_owned' }, version: null, pid: null, startedAt: null, devices: null, activeRuns: null }))
    expect(html).toContain('不可用（daemon_userdata_owned）')
    expect(html).toContain('<dt>进程</dt><dd class="unknown">未知</dd>')
    expect(html.match(/class="unknown"/g)?.length).toBe(5)
  })

  it('says remote access is off instead of counting zero devices', () => {
    const html = render(daemon({ devices: { state: 'remote-disabled' } }))
    expect(html).toContain('远程访问未启用')
  })

  it('offers nothing to operate with the switch off', () => {
    const html = render({ mode: 'in-process', userDataDir: '/u' })
    expect(html).toContain('后台服务模式未启用')
    expect(buttons(html)).toEqual(['刷新'])
  })

  it('disables every button while an action or a read is running', () => {
    const html = render(daemon(), { busy: 'restart' })
    expect(html).toContain('重启后台服务…')
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(3)
  })

  it('shows read failures and action results', () => {
    expect(render(null, { readError: 'daemon_not_running' })).toContain('读取后台服务状态失败：daemon_not_running')
    expect(render(daemon(), { result: describeActionResult('quit', { status: 'failed', reason: 'stop-timeout', message: '没有退出' }) })).toContain('没有退出')
    expect(describeActionResult('restart', { status: 'cancelled' }).text).toContain('没有被停止')
  })
})

describe('formatUptime', () => {
  it('formats a known start time and keeps an unknown one unknown', () => {
    expect(formatUptime(null, NOW)).toBeNull()
    expect(formatUptime(NOW + 1, NOW)).toBeNull()
    expect(formatUptime(NOW - 30_000, NOW)).toBe('不到 1 分钟')
    expect(formatUptime(NOW - 3 * 86_400_000 - 4 * 3_600_000, NOW)).toBe('3 天 4 小时')
  })
})

describe('Settings «后台服务» tab', () => {
  it('is a settings section of its own', () => {
    const html = renderToStaticMarkup(<SettingsModal initialTab="service" theme="dark" onThemeChange={() => {}} onSessionsChanged={() => {}} onNewRemoteSession={() => {}} onClose={() => {}} />)
    expect(html).toContain('后台服务')
    expect(html).toContain('读取中…')
  })
})
