// 机器页的纯投影：把一份 HostMetricsSnapshot 变成卡片上的文字和条。
// 规则只有一条来源：读不到的数值是 null，界面写「不可用」，绝不写 0。
import {
  hostMetricsPercent, hostMetricsTone,
  type HostDiskRole, type HostMemoryPressure, type HostMetricsSnapshot, type HostProviderUsage
} from '@shared/host-metrics'

export type MeterTone = 'normal' | 'warn' | 'danger' | 'none'

export interface MeterView {
  key: 'cpu' | 'memory' | 'swap' | 'disk'
  label: string
  /** 0–100，null 表示这项读不到（不画条，写「不可用」）。 */
  percent: number | null
  valueText: string
  tone: MeterTone
}

const UNREADABLE = '不可用'
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return UNREADABLE
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1 }
  // 一位小数只在 1–10 之间有信息量；再大就取整，避免「212.4 GB」这种假精确。
  const shown = unit === 0 ? String(Math.round(value)) : value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  return `${shown} ${BYTE_UNITS[unit]}`
}

export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return UNREADABLE
  return `${Math.round(percent)}%`
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '开机时长不可用'
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `开机 ${days} 天`
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return `开机 ${hours} 小时`
  return `开机 ${Math.floor(seconds / 60)} 分钟`
}

const AGE_STEPS: ReadonlyArray<{ limitMs: number; unitMs: number; label: string }> = [
  { limitMs: 60_000, unitMs: 1_000, label: '秒' },
  { limitMs: 3_600_000, unitMs: 60_000, label: '分钟' },
  { limitMs: 86_400_000, unitMs: 3_600_000, label: '小时' }
]

export function formatSampleAge(sampledAt: number | null | undefined, now: number): string {
  if (sampledAt === null || sampledAt === undefined || !Number.isFinite(sampledAt)) return ''
  const elapsed = Math.max(0, now - sampledAt)
  for (const step of AGE_STEPS) {
    if (elapsed < step.limitMs) return `${Math.floor(elapsed / step.unitMs)} ${step.label}前更新`
  }
  return `${Math.floor(elapsed / 86_400_000)} 天前更新`
}

/** Full timestamp of the sample, e.g. 「采样于 16:42:07」. */
export function formatSampleTime(sampledAt: number | null | undefined): string {
  if (sampledAt === null || sampledAt === undefined || !Number.isFinite(sampledAt)) return ''
  const date = new Date(sampledAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `采样于 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function memoryPressureText(pressure: HostMemoryPressure | null | undefined): string {
  if (pressure === 'low') return '低'
  if (pressure === 'medium') return '中'
  if (pressure === 'high') return '高'
  return UNREADABLE
}

const DISK_ROLE_TEXT: Readonly<Record<HostDiskRole, string>> = { data: '数据盘', workspace: '工作区' }

export function dispatchDiskRole(role: HostDiskRole): string {
  return DISK_ROLE_TEXT[role] ?? UNREADABLE
}

export function runsText(runs: HostMetricsSnapshot['runs']): string {
  if (runs.active === 0 && runs.queued === 0) return '没有运行'
  return `进行中 ${runs.active} · 排队 ${runs.queued}`
}

/** 「10 核 · 开机 3 天 · 运行中 2」 */
export function hostSummary(snapshot: HostMetricsSnapshot): string {
  const running = snapshot.runs.active === 0 ? '没有运行' : `运行中 ${snapshot.runs.active}`
  return `${snapshot.cpu.cores} 核 · ${formatUptime(snapshot.uptimeSec)} · ${running}`
}

/** The volume the card summarizes: the data disk, else whichever was measured. */
export function primaryDisk(snapshot: HostMetricsSnapshot): HostMetricsSnapshot['disks'][number] | undefined {
  return snapshot.disks.find((disk) => disk.role === 'data') ?? snapshot.disks[0]
}

function toneFor(percent: number | null): MeterTone {
  const tone = hostMetricsTone(percent)
  return tone === 'none' ? 'none' : tone
}

export function meterViews(snapshot: HostMetricsSnapshot): MeterView[] {
  const memoryUsed = hostMetricsPercent(snapshot.memory.usedBytes ?? Number.NaN, snapshot.memory.totalBytes)
  const swapPercent = snapshot.memory.swapUsedBytes === null || snapshot.memory.swapTotalBytes === null
    ? null
    : hostMetricsPercent(snapshot.memory.swapUsedBytes, snapshot.memory.swapTotalBytes)
  const disk = primaryDisk(snapshot)
  const diskPercent = disk && disk.totalBytes > 0 ? hostMetricsPercent(disk.totalBytes - disk.freeBytes, disk.totalBytes) : null
  return [
    { key: 'cpu', label: 'CPU', percent: snapshot.cpu.percent, valueText: formatPercent(snapshot.cpu.percent), tone: toneFor(snapshot.cpu.percent) },
    {
      key: 'memory', label: '内存', percent: memoryUsed, tone: toneFor(memoryUsed),
      valueText: snapshot.memory.usedBytes === null ? UNREADABLE : `已用 ${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`
    },
    {
      key: 'swap', label: '交换区', percent: swapPercent, tone: toneFor(swapPercent),
      valueText: snapshot.memory.swapUsedBytes === null ? UNREADABLE
        : snapshot.memory.swapTotalBytes === null ? `已用 ${formatBytes(snapshot.memory.swapUsedBytes)}`
          : `已用 ${formatBytes(snapshot.memory.swapUsedBytes)} / ${formatBytes(snapshot.memory.swapTotalBytes)}`
    },
    {
      key: 'disk', label: '磁盘', percent: diskPercent, tone: toneFor(diskPercent),
      valueText: disk && disk.totalBytes > 0 ? `剩余 ${formatBytes(disk.freeBytes)}` : UNREADABLE
    }
  ]
}

/** null = the process table could not be read；[] = it was read and held no provider child. */
export function providerUsageRows(snapshot: HostMetricsSnapshot): HostProviderUsage[] | null {
  return snapshot.scry.providers
}

const PROVIDER_NAME: Readonly<Record<string, string>> = { pi: 'Pi', claude: 'Claude Code', codex: 'Codex', other: '其他' }

export function providerName(providerId: string): string {
  return PROVIDER_NAME[providerId] ?? providerId
}

/** 只算 Provider 子进程树：卡片上它们和后台服务分两行写，不能混成一个数。 */
export function providerUsageTotals(snapshot: HostMetricsSnapshot): {
  processes: number | null
  cpuPercent: number | null
  rssBytes: number | null
} {
  const providers = snapshot.scry.providers
  if (providers === null) return { processes: null, cpuPercent: null, rssBytes: null }
  let cpuPercent: number | null = null
  let rssBytes = 0
  let processes = 0
  for (const row of providers) {
    processes += row.processes
    rssBytes += row.rssBytes
    if (row.cpuPercent !== null) cpuPercent = (cpuPercent ?? 0) + row.cpuPercent
  }
  return { processes, cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10, rssBytes }
}

export function scryUsageTotals(snapshot: HostMetricsSnapshot): {
  processes: number | null
  cpuPercent: number | null
  rssBytes: number | null
} {
  const providers = snapshot.scry.providers
  if (providers === null) return { processes: null, cpuPercent: null, rssBytes: null }
  let cpuPercent: number | null = null
  let rssBytes = 0
  let processes = 0
  for (const row of providers) {
    processes += row.processes
    rssBytes += row.rssBytes
    if (row.cpuPercent !== null) cpuPercent = (cpuPercent ?? 0) + row.cpuPercent
  }
  // 后台服务自己也占资源：合计要把 daemon 那一行走算在内。
  return {
    processes,
    cpuPercent: cpuPercent === null && snapshot.scry.daemon.cpuPercent === null
      ? null
      : Math.round(((cpuPercent ?? 0) + (snapshot.scry.daemon.cpuPercent ?? 0)) * 10) / 10,
    rssBytes: rssBytes + snapshot.scry.daemon.rssBytes
  }
}

export type TargetNoticeKind =
  | { kind: 'ready' }
  | { kind: 'offline' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; detail: string }
  | { kind: 'silent' }

export interface TargetNotice {
  tone: 'info' | 'warn' | 'bad'
  title: string
  detail?: string
}

/** What a target card says when it has no numbers to show. Never 「0%」. */
export function targetNotice(state: TargetNoticeKind): TargetNotice | null {
  if (state.kind === 'ready' || state.kind === 'silent') return null
  if (state.kind === 'offline') return { tone: 'info', title: '离线', detail: '连接后才能读取这台机器的资源。' }
  if (state.kind === 'unsupported') {
    return { tone: 'info', title: '该主机版本不支持，请升级', detail: '升级后即可显示这台机器的资源；会话和运行不受影响。' }
  }
  return { tone: 'bad', title: `读取资源失败：${state.detail}`, detail: '显示的仍是上次成功读取的数据；可以重试。' }
}
