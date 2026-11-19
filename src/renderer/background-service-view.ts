import {
  daemonCredentialUnavailableMessage, isDaemonCredentialUnavailable,
  type BackgroundServiceAction, type BackgroundServiceActionResult,
  type BackgroundServiceStatus, type LoginStartPolicyEntry
} from '../shared/background-service'
import {
  LOGIN_START_COPY,
  formatLoginStartConflictDetail,
  formatLoginStartStatus,
  formatRemoteConfigSummary,
  runtimeNoticeMessages
} from './constants/background-service-copy'
import { detectRendererPlatform, type RendererPlatform } from './platform'

// What the «后台服务» section shows for one status read. Values main could not establish
// arrive as null and are shown as 未知, never as 0 or as a healthy default.

export const UNKNOWN = '未知'

export interface BackgroundServiceRow { label: string; value: string; unknown: boolean }
export type NoticeTone = 'info' | 'warn' | 'bad'
export interface BackgroundServiceNotice { tone: NoticeTone; text: string }

export interface BackgroundServiceLoginStartView {
  stateText: string
  enabled: boolean
  canToggle: boolean
  policyEnv: LoginStartPolicyEntry[]
  notices: BackgroundServiceNotice[]
}

export interface BackgroundServiceView {
  rows: BackgroundServiceRow[]
  notice?: BackgroundServiceNotice
  runtimeNotices: BackgroundServiceNotice[]
  loginStart?: BackgroundServiceLoginStartView
  /** Which actions this state offers; `restartPrimary` when restarting is the fix. */
  actions: { restart: boolean; restartPrimary: boolean; reconnect: boolean; quit: boolean }
}

const row = (label: string, value: string | null): BackgroundServiceRow =>
  ({ label, value: value ?? UNKNOWN, unknown: value === null })

export function formatUptime(startedAt: number | null, now: number): string | null {
  if (startedAt === null || !Number.isFinite(startedAt) || now < startedAt) return null
  const minutes = Math.floor((now - startedAt) / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const rest = minutes % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${rest} 分钟`
  return `${rest} 分钟`
}

/** `platform` only decides whether the Linux keyring advice is shown. */
export function projectBackgroundService(
  status: BackgroundServiceStatus,
  now: number,
  platform: RendererPlatform = detectRendererPlatform()
): BackgroundServiceView {
  if (status.mode === 'in-process') {
    return {
      rows: [row('数据目录', status.userDataDir)],
      notice: { tone: 'info', text: '后台服务模式未启用（SCRY_HOST_DAEMON）：Agent 运行在 App 进程内，没有后台服务可以查看或操作。' },
      runtimeNotices: [],
      actions: { restart: false, restartPrimary: false, reconnect: false, quit: false }
    }
  }
  const { connection } = status
  let state: string
  let notice: BackgroundServiceNotice | undefined
  let credentialRefused = false
  if (connection.state === 'ready') {
    state = '已连接'
  } else if (connection.state === 'version-mismatch') {
    state = '版本不一致'
    notice = {
      tone: 'warn',
      text: `后台服务的版本（${connection.running ?? UNKNOWN}）与本 App（${connection.expected}）不一致，App 暂不与它通话。重启后台服务会启动与本 App 一致的版本。`
    }
  } else if (connection.state === 'device-not-authorized') {
    state = '本机连接已被撤销'
    notice = {
      tone: 'bad',
      text: '后台服务拒绝了本 App 的连接：本机连接已被撤销、已在另一个 Scry 实例入网，或本 App 保存的连接凭据已丢失。Scry 不会自动重新连接；需要时点「重新连接本机后台服务」。'
    }
  } else if (isDaemonCredentialUnavailable(connection.reason)) {
    // Restarting the daemon does not give the App a keyring, so it is not offered as the fix.
    credentialRefused = true
    state = `不可用（${connection.reason}）`
    notice = { tone: 'bad', text: daemonCredentialUnavailableMessage(connection.reason, platform === 'linux') }
  } else {
    state = `不可用（${connection.reason}）`
    notice = { tone: 'bad', text: `无法连接后台服务（${connection.reason}）。可以尝试重启后台服务。` }
  }
  const devices = status.devices === null ? null
    : status.devices.state === 'remote-disabled' ? '远程访问未启用'
      : `${status.devices.paired} 台`
  const rows: BackgroundServiceRow[] = [
    row('连接', state),
    row('版本', status.version),
    row('进程', status.pid === null ? null : `pid ${status.pid}`),
    row('运行时长', formatUptime(status.startedAt, now)),
    row('数据目录', status.userDataDir),
    row('已配对设备', devices),
    row('运行中的任务', status.activeRuns === null ? null : `${status.activeRuns} 个`)
  ]
  if (status.launchedBy !== undefined) {
    const launcherText = status.launchedBy === null ? null
      : status.launchedBy === 'app' ? LOGIN_START_COPY.launchedByApp
        : status.launchedByVerified ? LOGIN_START_COPY.launchedByServiceVerified : LOGIN_START_COPY.launchedByServiceSelfReported
    rows.push(row('启动方式', launcherText))
  }
  if (status.remoteConfig !== undefined) {
    rows.push(row('生效配置', status.remoteConfig ? formatRemoteConfigSummary(status.remoteConfig) : null))
  }

  let loginStartView: BackgroundServiceLoginStartView | undefined
  if (status.loginStart) {
    const ls = status.loginStart
    const lsNotices: BackgroundServiceNotice[] = []
    if (ls.state === 'enabled' && status.launchedBy === 'app') {
      lsNotices.push({ tone: 'info', text: LOGIN_START_COPY.appRunningWillSwitchAtNextLogin })
    }
    if (ls.state === 'enabled' && ls.rewrittenFromExecutable) {
      lsNotices.push({ tone: 'info', text: `检测到 Scry 已移动，已自动更新系统服务指向当前程序（原路径：${ls.rewrittenFromExecutable}）。` })
    }
    if ((ls.state === 'enabled' || ls.state === 'disabled') && ls.linuxLinger === 'no') {
      lsNotices.push({ tone: 'info', text: LOGIN_START_COPY.linuxLingerNo })
    }
    if (ls.state === 'conflict') {
      lsNotices.push({ tone: 'warn', text: formatLoginStartConflictDetail(ls) })
    }
    loginStartView = {
      stateText: formatLoginStartStatus(ls),
      enabled: ls.state === 'enabled',
      canToggle: ls.state === 'enabled' || ls.state === 'disabled',
      policyEnv: ls.state === 'enabled' ? ls.policyEnv : [],
      notices: lsNotices
    }
  }

  const runtimeNotices: BackgroundServiceNotice[] = runtimeNoticeMessages(status.runtimeNotice)
    .map((text) => ({ tone: 'warn', text }))

  return {
    rows,
    ...(notice ? { notice } : {}),
    runtimeNotices,
    ...(loginStartView ? { loginStart: loginStartView } : {}),
    actions: {
      restart: true,
      restartPrimary: connection.state === 'version-mismatch' || (connection.state === 'unavailable' && !credentialRefused),
      reconnect: connection.state === 'device-not-authorized',
      quit: true
    }
  }
}

const DONE: Record<BackgroundServiceAction, string> = {
  restart: '后台服务已重启并重新连接。',
  reconnect: '已重新连接本机后台服务。',
  quit: '后台服务已退出，Scry 正在退出。'
}

/** The line shown under the buttons once an action returns. */
export function describeActionResult(action: BackgroundServiceAction, result: BackgroundServiceActionResult): BackgroundServiceNotice {
  if (result.status === 'done') return { tone: 'info', text: DONE[action] }
  if (result.status === 'cancelled') return { tone: 'info', text: '已取消，后台服务没有被停止。' }
  return { tone: 'bad', text: result.message }
}

export function describeLoginStartResult(enabled: boolean, result: BackgroundServiceActionResult): BackgroundServiceNotice {
  if (result.status === 'done') return { tone: 'info', text: enabled ? LOGIN_START_COPY.enabledDone : LOGIN_START_COPY.disabledDone }
  if (result.status === 'cancelled') return { tone: 'info', text: LOGIN_START_COPY.cancelled }
  return { tone: 'bad', text: result.message }
}
