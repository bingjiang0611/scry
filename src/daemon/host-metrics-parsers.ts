import type { HostMemoryPressure, HostProviderUsage } from '../shared/host-metrics'

// Pure parsers for the platform readings the sampler depends on (P8 §3, §9).
// Each one refuses to answer rather than substituting a plausible number: a
// missing page count is null, and a field the command did not print is null.

export interface CpuTimes { idle: number; total: number }

export interface ProcessRow {
  pid: number
  ppid: number
  rssBytes: number
  cpuPercent: number
  /** Executable name only: arguments are never read (P8 §3, §5). */
  comm: string
}

export function cpuTimesFromCpus(cpus: ReadonlyArray<{ times: Record<string, number> }>): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const times = cpu.times ?? {}
    for (const [kind, value] of Object.entries(times)) {
      if (!Number.isFinite(value)) continue
      total += value
      if (kind === 'idle') idle += value
    }
  }
  return { idle, total }
}

/** Busy share of the interval between two samples, or null when it did not advance. */
export function cpuPercentBetween(previous: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - previous.total
  const idle = next.idle - previous.idle
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0) return null
  const busy = Math.min(total, Math.max(0, total - idle))
  return Math.min(100, Math.round((busy / total) * 100))
}

/**
 * macOS `vm_stat`. Available = free + inactive + speculative + purgeable: `os.freemem()`
 * only counts fully idle pages and would report "95% used" on a healthy Mac (P8 §3).
 */
export function parseVmStat(text: string): { pageSizeBytes: number; availableBytes: number } | null {
  const pageSize = text.match(/page size of (\d+) bytes/)
  if (!pageSize) return null
  const page = (label: string): number | null => {
    const match = text.match(new RegExp(`^Pages ${label}:\\s*(\\d+)\\.`, 'm'))
    return match ? Number(match[1]) : null
  }
  const free = page('free')
  const inactive = page('inactive')
  const speculative = page('speculative')
  const purgeable = page('purgeable')
  if (free === null || inactive === null || speculative === null || purgeable === null) return null
  const pageSizeBytes = Number(pageSize[1])
  if (!Number.isSafeInteger(pageSizeBytes) || pageSizeBytes <= 0) return null
  return { pageSizeBytes, availableBytes: (free + inactive + speculative + purgeable) * pageSizeBytes }
}

/**
 * `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical.
 * Any other value is not one of the three levels the UI shows.
 */
export function parseMemoryPressureLevel(text: string): HostMemoryPressure | null {
  const level = text.trim()
  if (level === '1') return 'low'
  if (level === '2') return 'medium'
  if (level === '4') return 'high'
  return null
}

/** `sysctl -n vm.swapusage`: used and configured totals, each null when unreadable. */
export function parseSwapUsage(text: string): { usedBytes: number | null; totalBytes: number | null } {
  const field = (name: 'used' | 'total'): number | null => {
    const match = text.match(new RegExp(`${name}\\s*=\\s*([\\d.]+)\\s*([KMG])?`))
    if (!match) return null
    const value = Number(match[1])
    if (!Number.isFinite(value)) return null
    const unit = match[2] === 'K' ? 1024 : match[2] === 'G' ? 1024 ** 3 : 1024 ** 2
    return Math.round(value * unit)
  }
  return { usedBytes: field('used'), totalBytes: field('total') }
}

/** Linux `/proc/meminfo`. `MemAvailable` is the system's own "usable" figure. */
export function parseProcMeminfo(text: string): {
  totalBytes: number | null
  availableBytes: number | null
  swapUsedBytes: number | null
  swapTotalBytes: number | null
} {
  const field = (name: string): number | null => {
    const match = text.match(new RegExp(`^${name}:\\s*(\\d+) kB`, 'm'))
    return match ? Number(match[1]) * 1024 : null
  }
  const total = field('MemTotal')
  const swapTotal = field('SwapTotal')
  const swapFree = field('SwapFree')
  return {
    totalBytes: Number.isSafeInteger(total) && total! > 0 ? total : null,
    availableBytes: field('MemAvailable'),
    swapUsedBytes: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null,
    swapTotalBytes: Number.isSafeInteger(swapTotal) && swapTotal! > 0 ? swapTotal : null
  }
}

/** Maps Linux PSI avg10 to the shared UI bands (P8 §3). */
export function parsePsiMemory(text: string): HostMemoryPressure | null {
  const avg10 = text.match(/avg10=([\d.]+)/)
  if (!avg10) return null
  const value = Number(avg10[1])
  if (!Number.isFinite(value)) return null
  if (value < 10) return 'low'
  if (value < 40) return 'medium'
  return 'high'
}

/** `ps -axo pid=,ppid=,rss=,%cpu=,ucomm=` rows. Malformed lines are skipped. */
export function parsePsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4]),
      comm: match[5]
    })
  }
  return rows
}

// Executable basenames are a fallback after recorded Provider roots and inherited attribution.
// If neither applies and the basename is unknown, use 「其他」. Arguments are not inspected.
const PROVIDER_EXECUTABLES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  qoder: 'qoder',
  qodercli: 'qoder',
  'qoder-agent': 'qoder',
  antigravity: 'antigravity',
  agy: 'antigravity'
}

function executableName(comm: string): string {
  const parts = comm.split('/')
  return (parts[parts.length - 1] ?? comm).toLowerCase()
}

/**
 * 采样自己起的命令（`ps` 就是读出这张表的那个进程，`nice` 是它的降优先级包装，
 * `sysctl`/`vm_stat` 读内存）。它们一定挂在 daemon 底下，但不是 Scry 的工作负载，
 * 算进去就会凭空多出一个「其他」进程和几 MB 内存。
 */
const SAMPLER_COMMANDS = new Set(['ps', 'nice', 'sysctl', 'vm_stat'])

/**
 * Groups the daemon's own descendants by Provider (P8 §3). Only processes below
 * `rootPid` count; a remembered Provider root that now names an unrelated
 * process (PID reuse) is simply not in the tree and contributes nothing.
 */
export function attributeProcessTree(
  rows: readonly ProcessRow[],
  rootPid: number,
  providerRoots: ReadonlyArray<{ providerId: string; pid: number }>
): HostProviderUsage[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pid === rootPid || row.pid <= 1) continue
    // 只放过 daemon *直接*起的同名命令；Provider 自己起的 ps 仍在 Provider 下面。
    if (row.ppid === rootPid && SAMPLER_COMMANDS.has(executableName(row.comm))) continue
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const recorded = new Map(providerRoots.map((entry) => [entry.pid, entry.providerId]))
  const totals = new Map<string, { processes: number; cpuPercent: number; rssBytes: number }>()
  const visit = (parentPid: number, inherited: string | undefined): void => {
    for (const row of children.get(parentPid) ?? []) {
      const provider = recorded.get(row.pid) ?? inherited ?? PROVIDER_EXECUTABLES[executableName(row.comm)] ?? 'other'
      const current = totals.get(provider) ?? { processes: 0, cpuPercent: 0, rssBytes: 0 }
      current.processes += 1
      current.cpuPercent += row.cpuPercent
      current.rssBytes += row.rssBytes
      totals.set(provider, current)
      visit(row.pid, provider)
    }
  }
  visit(rootPid, undefined)
  return [...totals.entries()]
    .map(([providerId, entry]): HostProviderUsage => ({
      providerId,
      processes: entry.processes,
      cpuPercent: Math.round(entry.cpuPercent * 10) / 10,
      rssBytes: entry.rssBytes
    }))
    .sort((left, right) => left.providerId === 'other' ? 1 : right.providerId === 'other' ? -1 : left.providerId.localeCompare(right.providerId))
}
