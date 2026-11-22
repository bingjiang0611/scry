
export const HOST_CHILD_ENV = 'SCRY_HOST_CHILD'
export const HOST_ADMIN_RATE_LIMITS = {
  approve: { max: 3, windowMs: 60 * 60 * 1000 },
  invite: { max: 6, windowMs: 60 * 60 * 1000 }
} as const

export type HostAdminRateAction = keyof typeof HOST_ADMIN_RATE_LIMITS

export type HostAdminNoticeKind =
  | 'cli_approval_enabled'
  | 'device_approved_via_cli'
  | 'device_revoked_via_cli'
  | 'pairing_cancelled_via_cli'
  | 'desktop_disabled_via_cli'

/**
 * Sanitized security notice emitted when the CLI approval switch is enabled or
 * `scry-host` performs an approve / cancel / revoke / desktop-off action.
 * Never carries pairing secrets, invite strings, or private keys.
 */
export interface HostAdminNotice {
  id: string
  kind: HostAdminNoticeKind
  ts: number
  deviceId?: string
  deviceLabel?: string
  pairingId?: string
  /** First 16 hex characters of the device public key fingerprint (display-only). */
  fingerprintPrefix?: string
}

export interface HostCliApprovalSelfReport {
  enabled: boolean
  updatedAt: number | null
}

export type CliApprovalStatus =
  | { state: 'enabled'; updatedAt: number | null; hostCliPath?: string }
  | { state: 'disabled'; updatedAt: number | null; hostCliPath?: string }
  | { state: 'unavailable'; reason: string }

/**
 * True when running inside a Scry-managed Provider run or Scry terminal.
 * Blocks compliant Agents and Scry's own terminals from invoking `scry-host invite/approve`
 * or `login-start enable` (P5-host-security §4.2).
 */
export function isInsideHostChild(env: NodeJS.ProcessEnv = process.env): boolean {
  const runId = env.SCRY_MANAGED_RUN_ID?.trim()
  const child = env[HOST_CHILD_ENV]?.trim()
  return Boolean(runId || child)
}

const VALID_NOTICE_KINDS: ReadonlySet<string> = new Set<HostAdminNoticeKind>([
  'cli_approval_enabled',
  'device_approved_via_cli',
  'device_revoked_via_cli',
  'pairing_cancelled_via_cli',
  'desktop_disabled_via_cli'
])

export function isHostAdminNotice(value: unknown): value is HostAdminNotice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 64) return false
  if (typeof raw.kind !== 'string' || !VALID_NOTICE_KINDS.has(raw.kind)) return false
  if (!Number.isSafeInteger(raw.ts) || (raw.ts as number) < 0) return false
  if (raw.deviceId !== undefined && (typeof raw.deviceId !== 'string' || raw.deviceId.length > 64)) return false
  if (raw.deviceLabel !== undefined && (typeof raw.deviceLabel !== 'string' || raw.deviceLabel.length > 320)) return false
  if (raw.pairingId !== undefined && (typeof raw.pairingId !== 'string' || raw.pairingId.length > 64)) return false
  if (raw.fingerprintPrefix !== undefined && (typeof raw.fingerprintPrefix !== 'string' || !/^[0-9a-f]{8,16}$/i.test(raw.fingerprintPrefix))) return false
  return true
}

export function formatHostAdminNoticeText(notice: HostAdminNotice): string {
  const device = notice.deviceLabel || notice.deviceId?.slice(0, 8) || '未知设备'
  const fp = notice.fingerprintPrefix ? `（指纹前 16 位 ${notice.fingerprintPrefix.toUpperCase()}）` : ''
  switch (notice.kind) {
    case 'cli_approval_enabled':
      return '执行端已开启「允许命令行批准」。如非本人操作，请在执行端「设置 → 后台服务」关闭该开关。'
    case 'device_approved_via_cli':
      return `执行端用命令行批准了设备「${device}」${fp}。如非本人操作，请在执行端 Scry「设置 → 远程访问」或运行 scry-host revoke ${notice.deviceId ?? '<设备ID>'} 撤销。`
    case 'device_revoked_via_cli':
      return `执行端用命令行撤销了设备「${device}」。`
    case 'pairing_cancelled_via_cli':
      return `执行端用命令行取消了待确认配对${notice.pairingId ? `（${notice.pairingId.slice(0, 8)}）` : ''}。`
    case 'desktop_disabled_via_cli':
      return '执行端用命令行关闭了桌面远程访问（未撤销已配对设备）。'
  }
}
