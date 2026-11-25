// P8 §4 的性能门限：单次采样 p95 < 50 ms（macOS 实测）。
//
// 这条用例不在默认 suite 里跑：它要真实调用 ps / sysctl / statfs，还要等缓存
// 过期才会重新采样。用 `npm run bench:host-metrics -- <output.json>` 显式跑，结果写入指定文件。
// 采样代码本身没有为测量让步：每次都用 createHostMetricsSources 的真实来源。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createHostMetricsSources, HostMetricsSampler } from './host-metrics'
import { HOST_METRICS_CACHE_MS, HOST_METRICS_MIN_INTERVAL_MS } from '../shared/host-metrics'

const enabled = process.env.SCRY_HOST_METRICS_P95 === '1'
const samples = Number(process.env.SCRY_HOST_METRICS_P95_SAMPLES ?? 20)
// 缓存 5 秒、最小间隔 2 秒：要等到缓存过期才会真的再采一次。
const minInterval = Math.max(HOST_METRICS_CACHE_MS, HOST_METRICS_MIN_INTERVAL_MS) + 100

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

describe.runIf(enabled)('host metrics sampling latency', () => {
  it('keeps one sample under 50 ms at p95 on this machine', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'scry-host-metrics-p95-'))
    try {
      const sources = createHostMetricsSources({
        platform: process.platform, userDataDir,
        workspaceRoots: () => [userDataDir],
        providerRoots: () => [],
        activeRuns: () => ({ active: 0, queued: 0 })
      })
      const sampler = new HostMetricsSampler(sources)
      // 冷启动那次包含 500 ms 的 CPU 间隔，单独记录，不混进稳态分布。
      const coldStarted = performance.now()
      await sampler.read('local')
      const coldMs = performance.now() - coldStarted
      const durations: number[] = []
      for (let index = 0; index < samples; index++) {
        await new Promise((resolve) => setTimeout(resolve, minInterval))
        const started = performance.now()
        await sampler.read('local')
        durations.push(performance.now() - started)
      }
      const report = {
        platform: process.platform, samples, coldMs,
        p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), maxMs: Math.max(...durations),
        durationsMs: durations.map((value) => Math.round(value * 100) / 100)
      }
      const output = process.env.SCRY_HOST_METRICS_P95_OUTPUT
      if (output) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
      }
      console.log('host metrics p95:', JSON.stringify(report))
      expect(report.p95Ms).toBeLessThan(50)
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }, 240_000)
})
