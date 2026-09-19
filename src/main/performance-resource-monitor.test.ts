import { describe, expect, it } from 'vitest'
import { buildPerformanceResourceSample, startPerformanceResourceMonitor } from './performance-resource-monitor'

describe('performance resource monitor', () => {
  it('normalizes content-free per-process and event-loop metrics', () => {
    const sample = buildPerformanceResourceSample({
      sampledAt: '2026-09-16T00:00:00.000Z',
      windowMs: 2_000,
      memory: {
        rss: 100,
        heapTotal: 80,
        heapUsed: 60,
        external: 20,
        arrayBuffers: 10
      },
      eventLoopP95Ns: 1_260_000,
      eventLoopMaxNs: 8_880_000,
      processes: [{
        pid: 42,
        type: 'Tab',
        cpu: { percentCPUUsage: 3.5 },
        memory: { workingSetSize: 128, peakWorkingSetSize: 256, privateBytes: 64 }
      }],
      counters: { traceBufferedBytes: 12 }
    })

    expect(sample).toEqual({
      name: 'app.resources',
      sampledAt: '2026-09-16T00:00:00.000Z',
      windowMs: 2_000,
      main: {
        rssBytes: 100,
        heapUsedBytes: 60,
        heapTotalBytes: 80,
        externalBytes: 20,
        arrayBuffersBytes: 10,
        eventLoopP95Ms: 1.3,
        eventLoopMaxMs: 8.9
      },
      processes: [{
        pid: 42,
        type: 'Tab',
        cpuPercentOfOneCore: 3.5,
        workingSetBytes: 128 * 1024,
        peakWorkingSetBytes: 256 * 1024,
        privateBytes: 64 * 1024
      }],
      counters: { traceBufferedBytes: 12 }
    })
  })

  it('does not schedule a monitor when diagnostics are disabled', () => {
    const monitor = startPerformanceResourceMonitor({ enabled: false, getAppMetrics: () => [] })
    expect(() => monitor.stop()).not.toThrow()
  })
})
