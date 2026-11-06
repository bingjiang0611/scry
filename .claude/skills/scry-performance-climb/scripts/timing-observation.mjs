import { cpus } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'

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
  let previous = cpuTimes()
  let maxEventLoopDelayMs = null
  let samplesTruncated = false
  const samples = []
  loop.enable()

  function sample() {
    const current = cpuTimes()
    const total = current.total - previous.total
    const eventLoopMaxMs = loop.count ? loop.max / 1e6 : null
    if (eventLoopMaxMs !== null) maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs ?? 0, eventLoopMaxMs)
    if (samples.length < sampleLimit) {
      samples.push({ sampledAt: new Date().toISOString(),
        cpuBusyPercent: total > 0 ? 100 * (1 - (current.idle - previous.idle) / total) : null,
        eventLoopMaxMs })
    } else samplesTruncated = true
    previous = current
    loop.reset()
  }

  const timer = setInterval(sample, intervalMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    sample()
    loop.disable()
    const cpu = process.cpuUsage(cpuBefore)
    return { intervalMs, sampleLimit, samples, samplesTruncated, maxEventLoopDelayMs,
      observerCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 } }
  }
}
