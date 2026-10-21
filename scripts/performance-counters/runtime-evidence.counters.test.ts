import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, writeCollector } from '../performance-counters.mjs'
import type { LlmPerformanceHistoryRow } from '../../src/shared/llm-performance'
import { piRpcEnvironment } from '../../src/main/providers/pi'
import { appendLlmPerformance, readUsageStats, usageJsonlPath } from '../../src/main/usage-jsonl'

const meter = vi.hoisted(() => ({ active: false, file: '', probes: 0, reads: 0, bytes: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (meter.active && args[1]?.[0] === '-p') meter.probes++
    return actual.spawn(...args)
  } }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    const result = actual.readFileSync(...args)
    if (meter.active && String(args[0]) === meter.file) {
      meter.reads++
      meter.bytes += Buffer.byteLength(result)
    }
    return result
  } }
})

const timestamp = '2026-10-16T00:00:00.000Z'
const sample: LlmPerformanceHistoryRow = {
  runId: 'performance', ts: timestamp, providerId: 'pi', model: 'offline', networkLabel: '', failed: false,
  performance: { state: 'complete', observedAt: timestamp, networkLabel: '', streamCharacters: 100,
    recentOutput: [], windowMs: 1000, streamDurationMs: 1000 }
}

async function nodeEnvironmentWorkload(calls: number): Promise<{ probes: number; durationMs: number }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-node-counter-')))
  symlinkSync(process.execPath, join(root, 'node'))
  meter.probes = 0
  meter.active = true
  const started = performance.now()
  try {
    for (let index = 0; index < calls; index++) {
      const env = await piRpcEnvironment({ id: 'pi:rotom', label: 'Rotom', executable: join(root, 'rotom') }, { PATH: root, HOME: root })
      // Probe/cache workload is identical on App CI (Node 22) and Node 24;
      // only a runtime satisfying Rotom's >=24 contract may be selected.
      expect(env.ROTOM_NODE).toBe(Number(process.versions.node.split('.')[0]) >= 24 ? realpathSync(process.execPath) : undefined)
    }
    return { probes: meter.probes, durationMs: performance.now() - started }
  } finally {
    meter.active = false
    rmSync(root, { recursive: true, force: true })
  }
}

async function usageWorkload(): Promise<{ reads: number; bytes: number; durationMs: number }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-usage-counter-')))
  const file = usageJsonlPath(root)
  const line = JSON.stringify({ providerId: 'pi', cwd: '/offline', cost: 1, tin: 2, tout: 3, ts: timestamp }) + '\n'
  writeFileSync(file, line.repeat(10_000))
  const expected = readUsageStats(root)
  expect(expected).toMatchObject({ status: 'ready', turns: 10_000, cost: 10_000, tin: 20_000, tout: 30_000 })
  meter.file = file
  meter.reads = 0
  meter.bytes = 0
  meter.active = true
  const started = performance.now()
  try {
    for (let index = 0; index < 5; index++) {
      await appendLlmPerformance(root, { cwd: '/offline' }, { ...sample, runId: `performance-${index}` })
      const stats = readUsageStats(root)
      expect(stats).toMatchObject({ status: 'ready', turns: expected.turns, cost: expected.cost,
        tin: expected.tin, tout: expected.tout, invalidLines: 0 })
      expect(stats.sourceBytes).toBeGreaterThan(expected.sourceBytes)
    }
    return { reads: meter.reads, bytes: meter.bytes, durationMs: performance.now() - started }
  } finally {
    meter.active = false
    rmSync(root, { recursive: true, force: true })
  }
}

describe('runtime and evidence fixed workloads', () => {
  // Each cold repeat has its own test deadline; all original workloads and
  // counters must complete before the collector can emit a measurement.
  const nodeResults: Awaited<ReturnType<typeof nodeEnvironmentWorkload>>[] = []
  const usageResults: Awaited<ReturnType<typeof usageWorkload>>[] = []
  const repeats = Array.from({ length: defaultRepeats }, (_, index) => index)

  it.each(repeats)('counts cold Node environment workload %i', async () => {
    nodeResults.push(await nodeEnvironmentWorkload(5))
  })

  it.each(repeats)('counts unchanged mixed usage workload %i', async () => {
    usageResults.push(await usageWorkload())
  })

  afterAll(() => {
    expect(nodeResults).toHaveLength(defaultRepeats)
    expect(usageResults).toHaveLength(defaultRepeats)
    const source = 'pass-through subprocess and file-read counters around production Pi environment and mixed usage append/read'
    writeCollector('runtime-evidence', [
      measured({ scenario: 'providers.pi-environment', metric: 'subprocess.node', layer: 'main', unit: 'count',
        workload: 'native-node=1;environment-resolutions=5;cold-first=1', source }, nodeResults.map(result => result.probes)),
      measured({ scenario: 'analytics.usage-mixed-append', metric: 'io.read.calls', layer: 'io', unit: 'count',
        workload: 'usage-rows=10000;warm-cache=1;performance-append-and-stats=5', source }, usageResults.map(result => result.reads)),
      measured({ scenario: 'analytics.usage-mixed-append', metric: 'io.read.bytes', layer: 'io', unit: 'bytes',
        workload: 'usage-rows=10000;warm-cache=1;performance-append-and-stats=5', source }, usageResults.map(result => result.bytes))
    ])
    if (process.env.SCRY_RUNTIME_EVIDENCE_TIMINGS) writeFileSync(process.env.SCRY_RUNTIME_EVIDENCE_TIMINGS,
      JSON.stringify({ nodeEnvironmentMs: nodeResults.map(result => result.durationMs), usageMixedAppendMs: usageResults.map(result => result.durationMs) }, null, 2))
  })

  it('observes an additional real child process', async () => {
    const { spawn } = await import('node:child_process')
    meter.probes = 0
    meter.active = true
    try {
      const child = spawn(process.execPath, ['-p', 'process.versions.node'], { stdio: 'ignore' })
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Node exited ${code}`)))
      })
      expect(meter.probes).toBe(1)
    } finally { meter.active = false }
  })
})
