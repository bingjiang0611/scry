import { cpus } from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { observeRunnerProcesses } from '../../../../scripts/performance-runner-snapshot.mjs'

const intervalMs = 250
const sampleLimit = 4096

function cpuTimes() {
  const processors = cpus()
  const total = processors.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0)
  const idle = processors.reduce((sum, cpu) => sum + cpu.times.idle, 0)
  return { total, idle }
}

// Observe the quiet timing parent, not the workload's event loop. Correlated stalls
// help distinguish host scheduling from application-local blocking; neither this
// signal nor CPU activity is subtracted from timings or used to excuse a failure.
export function observeTimingEnvironment() {
  const loop = monitorEventLoopDelay({ resolution: 20 })
  const cpuBefore = process.cpuUsage()
  const finishProcesses = process.env.SCRY_TIMING_PROCESS_SNAPSHOTS === '1' ? observeRunnerProcesses() : null
  let previous = cpuTimes()
  let previousAt = performance.now()
  let maxEventLoopDelayMs = null
  let samplesTruncated = false
  const samples = []
  loop.enable()

  function sample() {
    const current = cpuTimes()
    const sampledAt = performance.now()
    const total = current.total - previous.total
    const idle = current.idle - previous.idle
    const eventLoopMaxMs = loop.count ? loop.max / 1e6 : null
    if (eventLoopMaxMs !== null) maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs ?? 0, eventLoopMaxMs)
    if (samples.length < sampleLimit) {
      samples.push({ sampledAt: new Date().toISOString(),
        windowMs: sampledAt - previousAt, cpuTotalTickMs: total, cpuIdleTickMs: idle,
        cpuBusyPercent: total > 0 ? 100 * (1 - idle / total) : null,
        eventLoopMaxMs })
    } else samplesTruncated = true
    previous = current
    previousAt = sampledAt
    loop.reset()
  }

  const timer = setInterval(sample, intervalMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    sample()
    loop.disable()
    const processSnapshots = finishProcesses?.()
    const cpu = process.cpuUsage(cpuBefore)
    return { intervalMs, sampleLimit, samples, samplesTruncated, maxEventLoopDelayMs,
      observerCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
      ...(processSnapshots ? { processSnapshots } : {}) }
  }
}
