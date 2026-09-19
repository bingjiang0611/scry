import { monitorEventLoopDelay } from 'node:perf_hooks'

export interface ElectronProcessMetricLike {
  pid: number
  type: string
  cpu?: { percentCPUUsage?: number }
  memory?: {
    workingSetSize?: number
    peakWorkingSetSize?: number
    privateBytes?: number
  }
}

export interface PerformanceResourceSample {
  name: 'app.resources'
  sampledAt: string
  windowMs: number
  main: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    arrayBuffersBytes: number
    eventLoopP95Ms: number
    eventLoopMaxMs: number
  }
  processes: Array<{
    pid: number
    type: string
    cpuPercentOfOneCore: number
    workingSetBytes: number
    peakWorkingSetBytes: number
    privateBytes: number
  }>
  counters: Readonly<Record<string, number>>
}

const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const mibToBytes = (value: unknown): number => Math.max(0, Math.round(finite(value) * 1024))
const nsToMs = (value: unknown): number => Math.round(Math.max(0, finite(value)) / 100_000) / 10

export function buildPerformanceResourceSample(args: {
  sampledAt?: string
  windowMs: number
  memory: NodeJS.MemoryUsage
  eventLoopP95Ns: number
  eventLoopMaxNs: number
  processes: ElectronProcessMetricLike[]
  counters?: Readonly<Record<string, number>>
}): PerformanceResourceSample {
  return {
    name: 'app.resources',
    sampledAt: args.sampledAt ?? new Date().toISOString(),
    windowMs: args.windowMs,
    main: {
      rssBytes: args.memory.rss,
      heapUsedBytes: args.memory.heapUsed,
      heapTotalBytes: args.memory.heapTotal,
      externalBytes: args.memory.external,
      arrayBuffersBytes: args.memory.arrayBuffers,
      eventLoopP95Ms: nsToMs(args.eventLoopP95Ns),
      eventLoopMaxMs: nsToMs(args.eventLoopMaxNs)
    },
    processes: args.processes.map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      // Electron documents this as percentage of one CPU core, not a fraction of total machine CPU.
      cpuPercentOfOneCore: Math.max(0, finite(metric.cpu?.percentCPUUsage)),
      // Electron exposes these memory values in KiB.
      workingSetBytes: mibToBytes(metric.memory?.workingSetSize),
      peakWorkingSetBytes: mibToBytes(metric.memory?.peakWorkingSetSize),
      privateBytes: mibToBytes(metric.memory?.privateBytes)
    })),
    counters: { ...(args.counters ?? {}) }
  }
}

export interface PerformanceResourceMonitor {
  stop(): void
}

/**
 * Diagnostic-only, content-free resource sampling. Nothing is scheduled unless SCRY_PERF_LOG=1.
 * The histogram is reset every window, keeping overhead and output bounded during long soaks.
 */
export function startPerformanceResourceMonitor(options: {
  enabled?: boolean
  intervalMs?: number
  getAppMetrics: () => ElectronProcessMetricLike[]
  counters?: () => Readonly<Record<string, number>>
  sink?: (sample: PerformanceResourceSample) => void
}): PerformanceResourceMonitor {
  if (!(options.enabled ?? process.env.SCRY_PERF_LOG === '1')) return { stop() {} }
  const intervalMs = Math.max(1_000, options.intervalMs ?? 2_000)
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const sink = options.sink ?? ((sample) => console.info(`[scry:resource] ${JSON.stringify(sample)}`))
  const timer = setInterval(() => {
    sink(buildPerformanceResourceSample({
      windowMs: intervalMs,
      memory: process.memoryUsage(),
      eventLoopP95Ns: histogram.percentile(95),
      eventLoopMaxNs: histogram.max,
      processes: options.getAppMetrics(),
      counters: options.counters?.()
    }))
    histogram.reset()
  }, intervalMs)
  timer.unref()
  return {
    stop(): void {
      clearInterval(timer)
      histogram.disable()
    }
  }
}
