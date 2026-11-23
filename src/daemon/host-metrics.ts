import { execFile } from 'node:child_process'
import { readFileSync, statfsSync, statSync } from 'node:fs'
import { cpus, loadavg, totalmem, uptime } from 'node:os'
import {
  HOST_METRICS_CACHE_MS,
  HOST_METRICS_COLD_CPU_GAP_MS,
  HOST_METRICS_MIN_INTERVAL_MS,
  redactHostMetricsForRemote,
  type HostDiskRole,
  type HostMetricsScope,
  type HostMetricsSnapshot,
  type HostProviderUsage
} from '../shared/host-metrics'
import {
  attributeProcessTree,
  cpuPercentBetween,
  cpuTimesFromCpus,
  parseMemoryPressureLevel,
  parseProcMeminfo,
  parsePsiMemory,
  parsePsTable,
  parseSwapUsage,
  parseVmStat,
  type CpuTimes
} from './host-metrics-parsers'

/** One bounded command run: at most `maxBytes` of output, killed at `timeoutMs`. */
export interface HostMetricsCommand {
  run(file: string, args: string[], options: { timeoutMs: number; maxBytes: number }): Promise<string | null>
  readFile(path: string): string | null
}

/**
 * Everything the sampler reads. Split from the sampler so a fixture can answer
 * each one: the tests exercise the arithmetic and the failure rules, not macOS.
 */
export interface HostMetricsSources {
  platform: NodeJS.Platform
  now(): number
  sleep(ms: number): Promise<void>
  cpuTimes(): CpuTimes
  cores: number
  load1(): number | null
  uptimeSec(): number | null
  totalBytes(): number
  /** vm_stat on macOS, /proc/meminfo on Linux; null when unreadable. */
  memoryText(): Promise<string | null>
  /** sysctl pressure level on macOS, /proc/pressure/memory on Linux. */
  pressureText(): Promise<string | null>
  /** sysctl vm.swapusage on macOS; Linux reads swap from memoryText. */
  swapText(): Promise<string | null>
  /** `ps` table text; null when it failed or timed out. */
  processTable(): Promise<string | null>
  /** The volumes to report, with the role each one is shown under. */
  diskRoots(): Array<{ role: HostDiskRole; path: string }>
  statfs(path: string): { totalBytes: number; freeBytes: number } | null
  volumeId(path: string): string | null
  daemonCpuUsage(): { user: number; system: number }
  daemonRss(): number
  daemonPid(): number
  /** W20's per-session provider roots when available; empty means unknown. */
  providerRoots(): Array<{ providerId: string; pid: number }>
  activeRuns(): { active: number; queued: number | null }
}

const COMMAND_TIMEOUT_MS = 2_000
const PROCESS_TABLE_MAX_BYTES = 2 * 1024 * 1024
// ucomm 只给可执行名（不含参数、不含完整路径），正是 Provider 归属需要的字段；
// 比 comm 少一次路径解析，单次采样实测省约 10 ms。
const PROCESS_TABLE_ARGS = ['-axo', 'pid=,ppid=,rss=,%cpu=,ucomm=']
// Bounded so one answer always fits the protocol's 8 KiB; anything beyond is
// folded into 「其他」 rather than dropped.
const MAX_PROVIDER_ROWS = 12

/**
 * Reads the machine's resources on demand and caches the answer (P8 §4).
 * Nobody opening the page means no sampling at all; two callers inside the
 * cache window share one snapshot.
 */
export class HostMetricsSampler {
  #sources: HostMetricsSources
  #cached: HostMetricsSnapshot | undefined
  #sampledAt = 0
  #cpu: CpuTimes | undefined
  #daemonCpu: { usage: { user: number; system: number }; at: number } | undefined

  constructor(sources: HostMetricsSources) {
    this.#sources = sources
  }

  async read(scope: HostMetricsScope): Promise<HostMetricsSnapshot> {
    const sources = this.#sources
    const startedAt = sources.now()
    if (this.#cached && startedAt - this.#sampledAt < HOST_METRICS_CACHE_MS) return this.#project(scope)
    // A refresh loop cannot make the machine pay more than one sample per 2 s.
    if (this.#cached && startedAt - this.#sampledAt < HOST_METRICS_MIN_INTERVAL_MS) return this.#project(scope)
    const previousCpu = this.#cpu ?? sources.cpuTimes()
    if (!this.#cpu) await sources.sleep(HOST_METRICS_COLD_CPU_GAP_MS)
    const currentCpu = sources.cpuTimes()
    const cpuPercent = cpuPercentBetween(previousCpu, currentCpu)
    this.#cpu = currentCpu
    const snapshot = await this.#assemble(startedAt, cpuPercent)
    this.#cached = snapshot
    this.#sampledAt = startedAt
    return this.#project(scope)
  }

  #project(scope: HostMetricsScope): HostMetricsSnapshot {
    const snapshot = this.#cached!
    return scope === 'remote' ? redactHostMetricsForRemote(snapshot) : snapshot
  }

  async #assemble(sampledAt: number, cpuPercent: number | null): Promise<HostMetricsSnapshot> {
    const sources = this.#sources
    // 四个外部读取互不依赖：并行跑，一次采样的耗时才是最慢那一个，而不是四个相加。
    // ps 已经降优先级（nice），并行不会抢运行启动的 CPU。
    const [memoryText, pressureText, swapText, processTable] = await Promise.all([
      attempt(() => sources.memoryText()),
      attempt(() => sources.pressureText()),
      attempt(() => sources.swapText()),
      attempt(() => sources.processTable())
    ])
    const totalBytes = sources.totalBytes()

    let usedBytes: number | null = null
    let swapUsedBytes: number | null = null
    let swapTotalBytes: number | null = null
    let pressure: HostMetricsSnapshot['memory']['pressure'] = null
    if (sources.platform === 'linux') {
      const meminfo = parseProcMeminfo(memoryText ?? '')
      if (meminfo.availableBytes !== null) usedBytes = Math.max(0, totalBytes - meminfo.availableBytes)
      swapUsedBytes = meminfo.swapUsedBytes
      swapTotalBytes = meminfo.swapTotalBytes
      pressure = parsePsiMemory(pressureText ?? '')
    } else {
      const vmStat = parseVmStat(memoryText ?? '')
      if (vmStat) usedBytes = Math.max(0, totalBytes - vmStat.availableBytes)
      const swap = parseSwapUsage(swapText ?? '')
      swapUsedBytes = swap.usedBytes
      swapTotalBytes = swap.totalBytes
      pressure = parseMemoryPressureLevel(pressureText ?? '')
    }

    const providers = processTable === null ? null : attributeProcessTree(
      parsePsTable(processTable), sources.daemonPid(), sources.providerRoots()
    )

    return {
      sampledAt,
      uptimeSec: sources.uptimeSec(),
      cpu: { percent: cpuPercent, cores: sources.cores, load1: sources.load1() },
      memory: { totalBytes, usedBytes, pressure, swapUsedBytes, swapTotalBytes },
      disks: await this.#disks(),
      scry: {
        daemon: { cpuPercent: this.#daemonPercent(sampledAt), rssBytes: sources.daemonRss(), pid: sources.daemonPid() },
        providers: providers === null ? null : boundProviders(providers)
      },
      runs: sources.activeRuns()
    }
  }

  // Daemon CPU is the delta between this read and the previous one, so the first
  // answer of a session has no percentage yet (null, never a made-up 0).
  #daemonPercent(sampledAt: number): number | null {
    const usage = this.#sources.daemonCpuUsage()
    const previous = this.#daemonCpu
    this.#daemonCpu = { usage, at: sampledAt }
    if (!previous) return null
    const elapsedMs = sampledAt - previous.at
    if (elapsedMs <= 0) return null
    const busyMs = (usage.user + usage.system - previous.usage.user - previous.usage.system) / 1000
    if (!Number.isFinite(busyMs) || busyMs < 0) return null
    return Math.min(100, Math.round((busyMs / elapsedMs) * 100))
  }

  // One row per volume: the data volume and each workspace volume are reported
  // once, whichever path reached them first (P8 §3).
  async #disks(): Promise<HostMetricsSnapshot['disks']> {
    const seen = new Set<string>()
    const disks: HostMetricsSnapshot['disks'] = []
    for (const root of this.#sources.diskRoots()) {
      const volume = await attempt(() => this.#sources.volumeId(root.path))
      if (volume === null || seen.has(volume)) continue
      const usage = await attempt(() => this.#sources.statfs(root.path))
      if (!usage) continue
      seen.add(volume)
      disks.push({ role: root.role, totalBytes: usage.totalBytes, freeBytes: usage.freeBytes })
    }
    return disks
  }
}

async function attempt<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/** Folds rows past the cap into 「其他」 so a busy host cannot exceed the bound. */
function boundProviders(providers: HostProviderUsage[]): HostProviderUsage[] {
  if (providers.length <= MAX_PROVIDER_ROWS) return providers
  const kept = providers.slice(0, MAX_PROVIDER_ROWS)
  const rest = providers.slice(MAX_PROVIDER_ROWS)
  const other = kept.find((entry) => entry.providerId === 'other') ?? { providerId: 'other', processes: 0, cpuPercent: 0, rssBytes: 0 }
  for (const entry of rest) {
    other.processes += entry.processes
    other.cpuPercent = Math.round(((other.cpuPercent ?? 0) + (entry.cpuPercent ?? 0)) * 10) / 10
    other.rssBytes += entry.rssBytes
  }
  return [...kept.filter((entry) => entry.providerId !== 'other'), other]
}

export interface HostMetricsSourceOptions {
  platform: NodeJS.Platform
  userDataDir: string
  workspaceRoots: () => string[]
  providerRoots: () => Array<{ providerId: string; pid: number }>
  activeRuns: () => { active: number; queued: number | null }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  run?: HostMetricsCommand['run']
  readFile?: HostMetricsCommand['readFile']
  statfs?: (path: string) => { totalBytes: number; freeBytes: number } | null
  volumeId?: (path: string) => string | null
}

/** The production reads: bounded commands, no shell, no arguments printed. */
export function createHostMetricsSources(options: HostMetricsSourceOptions): HostMetricsSources {
  const platform = options.platform
  const now = options.now ?? Date.now
  const run = options.run ?? runCommand
  const readFile = options.readFile ?? ((path: string) => {
    try { return readFileSync(path, 'utf8') } catch { return null }
  })
  return {
    platform,
    now,
    sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    cpuTimes: () => cpuTimesFromCpus(cpus()),
    cores: cpus().length,
    load1: () => {
      const [load] = loadavg()
      return Number.isFinite(load) ? load : null
    },
    uptimeSec: () => {
      const value = uptime()
      return Number.isFinite(value) ? Math.round(value) : null
    },
    totalBytes: totalmem,
    memoryText: async () => platform === 'linux'
      ? readFile('/proc/meminfo')
      : await run('vm_stat', [], { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: PROCESS_TABLE_MAX_BYTES }),
    pressureText: async () => platform === 'linux'
      ? readFile('/proc/pressure/memory')
      : await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: 64 * 1024 }),
    swapText: async () => platform === 'linux'
      ? null
      : await run('sysctl', ['-n', 'vm.swapusage'], { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: 64 * 1024 }),
    processTable: async () => {
      const limits = { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: PROCESS_TABLE_MAX_BYTES }
      const runs = options.activeRuns()
      // 有运行在跑（或排队；排队数未知时按有算）时降优先级，采样不和它抢 CPU。
      // 没有运行时直接调用 ps，省掉一次 nice 进程：实测单次采样省约 8 ms。
      if (runs.active === 0 && runs.queued === 0) return run('ps', PROCESS_TABLE_ARGS, limits)
      const output = await run('nice', ['-n', '10', 'ps', ...PROCESS_TABLE_ARGS], limits)
      // `nice` is present on both targets; a missing one must not lose the table.
      return output ?? await run('ps', PROCESS_TABLE_ARGS, limits)
    },
    diskRoots: () => [
      { role: 'data', path: options.userDataDir },
      ...options.workspaceRoots().map((path) => ({ role: 'workspace' as const, path }))
    ],
    statfs: options.statfs ?? defaultStatfs,
    volumeId: options.volumeId ?? defaultVolumeId,
    daemonCpuUsage: () => process.cpuUsage(),
    daemonRss: () => process.memoryUsage().rss,
    daemonPid: () => process.pid,
    providerRoots: options.providerRoots,
    activeRuns: options.activeRuns
  }
}

function defaultStatfs(path: string): { totalBytes: number; freeBytes: number } | null {
  try {
    const stats = statfsSync(path)
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
  } catch {
    return null
  }
}

function defaultVolumeId(path: string): string | null {
  try {
    return `${statSync(path).dev}`
  } catch {
    return null
  }
}

function runCommand(file: string, args: string[], options: { timeoutMs: number; maxBytes: number }): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: options.timeoutMs, maxBuffer: options.maxBytes, encoding: 'utf8' }, (error, stdout) => {
      // A timeout and a missing executable both mean "not read this time": null.
      if (error && !stdout) return resolve(null)
      resolve(stdout)
    })
  })
}
