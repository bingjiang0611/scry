import { describe, expect, it, vi } from 'vitest'
import { hostMetricsLocalOps } from './host-metrics'

// The App's own machine reads through a local-only op (P8 §5). The handler is
// thin on purpose: the sampler does the work, and every argument is refused.

function group(read?: () => Promise<unknown>) {
  return hostMetricsLocalOps({ hostMetrics: read } as never)
}

describe('daemon host metrics local op', () => {
  it('answers hostMetrics:read from the sampler', async () => {
    const snapshot = { sampledAt: 1, cpu: { percent: 10, cores: 8, load1: 1 }, scry: { daemon: { pid: 42 } } }
    const ops = group(async () => snapshot)
    await expect(ops['hostMetrics:read']!()).resolves.toBe(snapshot)
  })

  it('refuses arguments: the op takes none', async () => {
    const read = vi.fn(async () => ({}))
    const ops = group(read)
    await expect(ops['hostMetrics:read']!({ scope: 'remote' })).rejects.toThrow('invalid_request')
    expect(read).not.toHaveBeenCalled()
  })

  it('reports a missing sampler by name instead of an empty snapshot', async () => {
    const ops = group(undefined)
    await expect(ops['hostMetrics:read']!()).rejects.toThrow('host_metrics_unavailable')
  })
})
