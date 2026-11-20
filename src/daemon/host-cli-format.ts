import type { RemoteDevice, RemotePendingPairing } from '../shared/remote'
import type { LoginStartStatus } from '../shared/background-service'
import { UUID } from '../main/remote/pairing-state'

export function groupFingerprint64(hex: string): string {
  return hex.toUpperCase().replace(/(.{4})/g, '$1 ').trim()
}

export function shortFingerprint16(hex: string): string {
  return hex.slice(0, 16).toUpperCase().replace(/(.{4})/g, '$1 ').trim()
}

export function normalizeHexPrefix(raw: string): string {
  return raw.replace(/\s+/g, '').toLowerCase()
}

export function formatRemainingSeconds(expiresAt: number, now: number): string {
  const sec = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${sec}s`
}

export function formatApprovedVia(approvedVia: RemoteDevice['approvedVia']): string {
  if (approvedVia === 'app') return 'App'
  if (approvedVia === 'host_cli') return '命令行'
  return '未记录'
}

export function resolveIdQuery<T>(
  items: readonly T[],
  getId: (item: T) => string,
  query: string,
  options: { allowPrefix: boolean }
): { ok: true; item: T } | { ok: false; error: string } {
  const normalized = query.trim().toLowerCase()
  if (!options.allowPrefix) {
    if (!UUID.test(normalized)) return { ok: false, error: 'non_interactive_requires_full_id' }
    const exact = items.find((item) => getId(item).toLowerCase() === normalized)
    return exact ? { ok: true, item: exact } : { ok: false, error: 'id_not_found' }
  }
  if (normalized.length < 8) return { ok: false, error: 'id_prefix_too_short' }
  const matches = items.filter((item) => getId(item).toLowerCase().startsWith(normalized))
  if (matches.length === 0) return { ok: false, error: 'id_not_found' }
  if (matches.length > 1) return { ok: false, error: 'id_prefix_ambiguous' }
  return { ok: true, item: matches[0]! }
}

export function formatPendingList(pending: readonly RemotePendingPairing[], now: number): string {
  if (pending.length === 0) return '当前没有待确认配对。\n'
  const lines: string[] = []
  for (const item of pending) {
    const rem = formatRemainingSeconds(item.expiresAt, now)
    if (item.state === 'created') {
      lines.push(`- ${item.pairingId.slice(0, 8)}  等待设备  剩余 ${rem}`)
    } else {
      lines.push(
        `- ${item.pairingId.slice(0, 8)}  ${item.deviceLabel ?? '未命名设备'}  待确认  剩余 ${rem}\n` +
        `  指纹前 16 位: ${item.publicKeySHA256 ? shortFingerprint16(item.publicKeySHA256) : '未知'}\n` +
        `  完整指纹:     ${item.publicKeySHA256 ? groupFingerprint64(item.publicKeySHA256) : '未知'}`
      )
    }
  }
  return `${lines.join('\n')}\n`
}

export function formatDeviceList(devices: readonly RemoteDevice[]): string {
  const active = devices.filter((d) => !d.revoked)
  if (active.length === 0) return '当前没有已配对设备。\n'
  const lines = active.map((d) =>
    `- ${d.deviceId}  ${d.deviceLabel}  批准方式（记录为）：${formatApprovedVia(d.approvedVia)}`
  )
  return `${lines.join('\n')}\n`
}

export interface HostAdminStatusPayload {
  daemon: {
    version: string
    build?: string
    pid: number
    startedAt: number
    launchedBy?: 'app' | 'service'
    supervisorPid?: number
  }
  activeRuns: number
  remoteEnabled: boolean
  remoteConfig?: Record<string, unknown>
  desktopAccess?: { enabled: boolean; pairPort?: number; runPort?: number; reason?: string }
  cliApproval: { enabled: boolean; updatedAt: number | null }
  pairingCapacity: { pairings: number; grants: number; limit: number } | null
}

export function formatStatusReport(
  status: HostAdminStatusPayload,
  loginStart?: LoginStartStatus
): string {
  const lines = [
    `后台服务: 运行中 (pid ${status.daemon.pid}, 版本 ${status.daemon.version}${status.daemon.build ? `, build ${status.daemon.build}` : ''})`,
    `拉起方: ${status.daemon.launchedBy ?? '未知'}`,
    `进行中的任务: ${status.activeRuns}`,
    `登录时启动: ${loginStart ? loginStart.state : '未知'}`,
    `远程访问: ${status.remoteEnabled ? '已启用' : '未启用'}`,
    `桌面访问: ${status.desktopAccess?.enabled ? `已启用 (pair ${status.desktopAccess.pairPort}, run ${status.desktopAccess.runPort})` : '未启用'}`,
    `允许命令行批准: ${status.cliApproval.enabled ? '已开启' : '已关闭'}`
  ]
  if (status.pairingCapacity) {
    lines.push(
      `配对记录用量: pairings ${status.pairingCapacity.pairings}/${status.pairingCapacity.limit}, grants ${status.pairingCapacity.grants}/${status.pairingCapacity.limit}`
    )
  }
  if (status.remoteConfig) {
    lines.push(`有效远程配置: ${JSON.stringify(status.remoteConfig)}`)
  }
  return `${lines.join('\n')}\n`
}
