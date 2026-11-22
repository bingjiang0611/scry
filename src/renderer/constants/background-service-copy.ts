import type {
  BackgroundServiceConfigField,
  BackgroundServiceRelayMode,
  BackgroundServiceRemoteConfig,
  BackgroundServiceRuntimeNotice,
  LoginStartStatus
} from '../../shared/background-service'

// Visible UX copy for the «后台服务» settings section and the run-path warning strip
// (P5-2, DESIGN.md copy rules: verb-first actions, honest unavailable reasons, no fake zeros).

export const LOGIN_START_COPY = {
  sectionTitle: '登录时启动',
  enableButton: '开启登录时启动',
  enablingButton: '开启登录时启动…',
  disableButton: '关闭登录时启动',
  disablingButton: '关闭登录时启动…',
  openSettingsButton: '打开后台服务设置',
  dismissButton: '收起',
  enabledDone: '已开启登录时启动。下次登录系统后后台服务会自动启动。',
  disabledDone: '已关闭登录时启动；当前正在运行的后台服务没有被停止。',
  cancelled: '已取消，没有修改系统登录服务。',
  appRunningWillSwitchAtNextLogin: '当前由 App 启动；下次登录起由系统服务启动。',
  policySnapshotPrefix: '服务文件已写入策略快照：',
  policySnapshotHint: '修改环境变量后，请先关闭再重新开启登录时启动以更新快照。',
  linuxLingerNo: '当前用户未开启 systemd linger（Linger=no）：注销登录会话后后台服务会停止。如需开机无登录常驻，请自行执行 loginctl enable-linger。',
  launchedByApp: '由 App 启动',
  launchedByServiceVerified: '由系统服务拉起（已核对）',
  launchedByServiceSelfReported: '由系统服务拉起（自报）'
} as const

export const CLI_APPROVAL_COPY = {
  sectionTitle: '允许命令行批准',
  enableButton: '开启允许命令行批准',
  enablingButton: '开启允许命令行批准…',
  disableButton: '关闭允许命令行批准',
  disablingButton: '关闭允许命令行批准…',
  stateEnabled: '已开启',
  stateDisabled: '已关闭',
  stateUnavailable: (reason: string) => `不可用（${reason}）`,
  copyPathButton: '复制 scry-host 路径',
  copiedPathButton: '已复制 scry-host 路径',
  pathPrefix: '命令行入口：',
  riskHint: '开启后，本机当前用户在终端运行 scry-host 可发起邀请并批准新设备；Scry 管理的 Agent 与终端内仍会拒绝。',
  enabledDone: '已开启允许命令行批准。',
  disabledDone: '已关闭允许命令行批准。',
  cancelled: '已取消，没有修改命令行批准开关。'
} as const

const RELAY_LABELS: Record<BackgroundServiceRelayMode, string> = {
  public: '公共中继',
  custom_ws: '自定义中继（WS）',
  custom_tcp: '自定义中继（TCP）',
  disabled: '仅直连 / SSH（未连中继）'
}

const CONFIG_FIELD_LABELS: Record<BackgroundServiceConfigField, string> = {
  remoteHostEnabled: '远程访问开关',
  relayMode: '中继方式',
  permissionModeOverride: '远程权限模式覆盖',
  disabledProviders: '禁用 Provider',
  runControlsEnabled: '运行控制',
  providerManifestUrl: 'Provider 清单来源'
}

export function formatRemoteConfigSummary(config: BackgroundServiceRemoteConfig): string {
  const parts = [
    config.remoteHostEnabled ? '远程访问已开启' : '远程访问已关闭',
    RELAY_LABELS[config.relayMode]
  ]
  if (config.permissionModeOverride) parts.push(`权限覆盖 ${config.permissionModeOverride}`)
  if (config.disabledProviders.length > 0) parts.push(`禁用 ${config.disabledProviders.join('、')}`)
  if (!config.runControlsEnabled) parts.push('运行控制已关闭')
  if (config.providerManifestUrl) parts.push('自定义清单来源')
  return parts.join(' · ')
}

export function formatLoginStartUnavailable(reason: string): string {
  switch (reason) {
    case 'linux_unverified':
      return '不可用：Linux 登录时启动尚未通过真机验收（linux_unverified）'
    case 'systemd_unavailable':
      return '不可用：未检测到 /usr/bin/systemctl（systemd_unavailable）'
    case 'unpackaged_build':
      return '不可用：仅打包版支持登录时启动（unpackaged_build）'
    case 'test_instance':
      return '不可用：测试实例默认不改动系统登录服务（test_instance）'
    case 'login_start_ephemeral_app_path':
      return '不可用：请先把 Scry 移至「应用程序」目录后再开启登录时启动（login_start_ephemeral_app_path）'
    default:
      if (reason.startsWith('login_start_read_failed:')) {
        return `不可用：无法读取系统服务文件（${reason}）`
      }
      return `不可用（${reason}）`
  }
}

export function formatLoginStartStatus(status: LoginStartStatus): string {
  if (status.state === 'unavailable') return formatLoginStartUnavailable(status.reason)
  if (status.state === 'disabled') return status.loaded ? '已关闭（原服务仍在当前会话加载）' : '已关闭'
  if (status.state === 'enabled') return status.loaded ? '已开启（已加载）' : '已开启（未加载）'
  if (status.reason === 'login_start_other_userdata') {
    return `冲突：已指向另一数据目录${status.otherUserDataDir ? `（${status.otherUserDataDir}）` : ''}`
  }
  if (status.reason === 'login_start_other_app') {
    return `冲突：已指向另一份仍存在的 Scry 程序${status.otherExecutable ? `（${status.otherExecutable}）` : ''}`
  }
  return '冲突：已有非 Scry 生成的同名系统服务文件（login_start_foreign_service）'
}

export function formatLoginStartConflictDetail(status: Extract<LoginStartStatus, { state: 'conflict' }>): string {
  if (status.reason === 'login_start_other_userdata') {
    return `系统登录服务当前指向另一个数据目录（${status.otherUserDataDir ?? '未知'}），Scry 没有覆盖它（login_start_other_userdata）。`
  }
  if (status.reason === 'login_start_other_app') {
    return `系统登录服务指向另一份仍存在的 Scry 程序（${status.otherExecutable ?? '未知'}），Scry 没有自动改写（login_start_other_app）。`
  }
  return '已有同名系统服务文件，但内容不是 Scry 生成的，Scry 没有修改它（login_start_foreign_service）。'
}

export function formatServiceLaunchFallbackNotice(
  fallback: NonNullable<BackgroundServiceRuntimeNotice['serviceLaunchFallback']>
): string {
  const code = fallback.exitCode !== undefined
    ? `${fallback.reason}，退出码 ${fallback.exitCode}`
    : fallback.reason
  return `通过系统服务拉起后台服务失败（${code}），已退回由 App 直接拉起；关闭 App 后登录自动启动可能仍不可用，可在「设置 → 后台服务」检查登录项与服务状态。`
}

export function formatRemoteConfigMismatchNotice(
  mismatch: NonNullable<BackgroundServiceRuntimeNotice['remoteConfigMismatch']>
): string {
  const fields = mismatch.diffs.map((field) => CONFIG_FIELD_LABELS[field]).join('、')
  return `当前运行的后台服务由系统服务启动，其生效配置与本 App 当前环境不一致（差异：${fields}）。如需应用当前环境，请关闭再重新开启「登录时启动」，然后重启后台服务。`
}

export function runtimeNoticeMessages(notice: BackgroundServiceRuntimeNotice | null | undefined): string[] {
  if (!notice) return []
  const lines: string[] = []
  if (notice.serviceLaunchFallback) lines.push(formatServiceLaunchFallbackNotice(notice.serviceLaunchFallback))
  if (notice.remoteConfigMismatch) lines.push(formatRemoteConfigMismatchNotice(notice.remoteConfigMismatch))
  return lines
}
