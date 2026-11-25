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
    expect(html).toContain('class="btn primary"')
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

  it('names the system keyring when the local credential cannot be kept, and does not push a restart (B4-S F2)', () => {
    const status = daemon({
      connection: { state: 'unavailable', reason: 'daemon_credential_unavailable:unsafe_credential_storage' },
      version: null, pid: null, startedAt: null, devices: null, activeRuns: null
    })
    const linux = render(status, { platform: 'linux' })
    expect(linux).toContain('系统密钥环不可用')
    expect(linux).toContain('无法保存本机后台服务的连接凭据')
    expect(linux).toContain('gnome-keyring')
    expect(linux).toContain('不可用（daemon_credential_unavailable:unsafe_credential_storage）')
    // Restarting the daemon does not bring a keyring; the restart button stays, but secondary.
    expect(linux).not.toContain('class="btn primary"')
    expect(buttons(linux)).toEqual(['刷新', '重启后台服务', '退出 Scry 与后台服务'])
    expect(render(status, { platform: 'macos' })).not.toContain('gnome-keyring')
  })

  it('says remote access is off instead of counting zero devices', () => {
    const html = render(daemon({ devices: { state: 'remote-disabled' } }))
    expect(html).toContain('远程访问未启用')
  })

  it('disables every button while an action or a read is running', () => {
    const html = render(daemon(), { busy: 'restart' })
    expect(html).toContain('重启后台服务…')
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(3)
  })

  it('shows read failures and action results', () => {
    const failed = render(null, { readError: 'daemon_not_running' })
    expect(failed).toContain('没能读取后台服务状态')
    expect(failed).toContain('刷新状态')
    expect(failed).not.toContain('daemon_not_running')
    expect(render(daemon(), { result: describeActionResult('quit', { status: 'failed', reason: 'stop-timeout', message: '没有退出' }) })).toContain('没有退出')
    expect(describeActionResult('restart', { status: 'cancelled' }).text).toContain('没有被停止')
  })

  it('shows login-start toggle, policy snapshot, platform unavailable, conflict, and runtime notices (P5-2)', () => {
    const enabled = render(daemon({
      launchedBy: 'app',
      loginStart: {
        state: 'enabled',
        loaded: true,
        policyEnv: [{ key: 'SCRY_REMOTE_HOST', value: '1' }],
        linuxLinger: 'no'
      }
    }), { onToggleLoginStart: () => {} })
    expect(enabled).toContain('role="switch" aria-label="登录时启动" aria-checked="true"')
    expect(enabled).toContain('SCRY_REMOTE_HOST=1')
    expect(enabled).toContain('当前由 App 启动；下次登录起由系统服务启动。')
    expect(enabled).toContain('loginctl enable-linger')

    const linuxUnavailable = render(daemon({
      loginStart: { state: 'unavailable', reason: 'linux_unverified' }
    }), { onToggleLoginStart: () => {} })
    expect(linuxUnavailable).toContain('linux_unverified')
    expect(linuxUnavailable).not.toContain('role="switch"')

    const conflict = render(daemon({
      loginStart: { state: 'conflict', reason: 'login_start_other_userdata', otherUserDataDir: '/Users/other/Scry' }
    }), { onToggleLoginStart: () => {} })
    expect(conflict).toContain('/Users/other/Scry')
    expect(conflict).toContain('login_start_other_userdata')

    const withNotices = render(daemon({
      launchedBy: 'service',
      launchedByVerified: false,
      runtimeNotice: {
        serviceLaunchFallback: { reason: 'login_start_service_launch_failed', exitCode: 113 },
        remoteConfigMismatch: {
          diffs: ['permissionModeOverride'],
          expected: { remoteHostEnabled: true, relayMode: 'public', permissionModeOverride: null, disabledProviders: [], runControlsEnabled: true, providerManifestUrl: null },
          actual: { remoteHostEnabled: true, relayMode: 'public', permissionModeOverride: 'auto_review', disabledProviders: [], runControlsEnabled: true, providerManifestUrl: null }
        }
      }
    }))
    expect(withNotices).toContain('由系统服务拉起（自报）')
    expect(withNotices).toContain('login_start_service_launch_failed')
    expect(withNotices).toContain('退出码 113')
    expect(withNotices).toContain('远程权限模式覆盖')
    expect(withNotices).toContain('关闭再重新开启「登录时启动」，然后重启后台服务')
  })

  it('hides the CLI approval switch when cliApproval is absent (flag off) and shows toggle + copy path when present (P5-7)', () => {
    const offHtml = render(daemon())
    expect(offHtml).not.toContain('允许命令行批准')
    expect(offHtml).not.toContain('scry-host')

    const onDisabled = render(daemon({
      cliApproval: {
        state: 'disabled',
        updatedAt: null,
        hostCliPath: '/Applications/Scry.app/Contents/Resources/bin/scry-host'
      }
    }), { onToggleCliApproval: () => {} } as Partial<Parameters<typeof BackgroundServicePanel>[0]>)
    expect(onDisabled).toContain('允许命令行批准')
    expect(onDisabled).toContain('开启允许命令行批准')
    expect(onDisabled).toContain('复制 scry-host 路径')

    const onEnabled = render(daemon({
      cliApproval: { state: 'enabled', updatedAt: NOW }
    }), { onToggleCliApproval: () => {} } as Partial<Parameters<typeof BackgroundServicePanel>[0]>)
    expect(onEnabled).toContain('关闭允许命令行批准')
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
    const html = renderToStaticMarkup(<SettingsModal initialTab="service" theme="dark" onThemeChange={() => {}} onSessionsChanged={() => {}} onOpenMachines={() => {}} onClose={() => {}} />)
    expect(html).toContain('后台服务')
    expect(html).toContain('读取中…')
  })

  it('C4: draws the automatic-resume switch as a switch, off until the user turns it on', () => {
    const off = render(daemon(), { usageLimitResume: { enabled: false }, onToggleUsageLimitResume: () => {} })
    expect(off).toContain('用量限额到期后自动继续')
    expect(off).toContain('未开启')
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/)
    expect(off).toContain('没有重置时间就不重试')

    const on = render(daemon(), { usageLimitResume: { enabled: true }, onToggleUsageLimitResume: () => {} })
    expect(on).toContain('已开启')
    expect(on).toContain('aria-checked="true"')

    // Without a switch state nothing is drawn: off and unknown must not look the same.
    expect(render(daemon())).not.toContain('用量限额到期后自动继续')
  })
})
