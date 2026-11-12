import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { applyTraceBatch } from '../src/renderer/format'
import {
  activeTurn,
  assertCompleteProjection,
  deliverTrace,
  duplicateTraceControl,
  events,
  makeFixture,
  type Counters,
  type Scenario,
  history,
  type Fixture
} from './performance-baseline-fixture'
import { scenarioCatalogue, scenariosFor } from './performance-baseline-scenarios'

export { activeTurn, assertCompleteProjection, deliverTrace, duplicateTraceControl, events, history, makeFixture, scenarioCatalogue, scenariosFor }
export type { Counters, Fixture, Scenario }

if (process.env.SCRY_ABAB_WORKER !== '1') describe('fixed production-path performance harness', () => {
  it('covers every user-path group with correct, measured local work', async () => {
    const fixture = makeFixture()
    const garbageCollections: Array<{ startedAtMs: number; durationMs: number }> = []
    const collectGarbageCollections = (entries: PerformanceEntry[]): void => {
      for (const entry of entries) garbageCollections.push({ startedAtMs: entry.startTime, durationMs: entry.duration })
    }
    const observer = new PerformanceObserver(list => collectGarbageCollections(list.getEntries()))
    observer.observe({ entryTypes: ['gc'] })
    const batches: Array<{
      scenario: string; sample: number; startedAtMs: number; endedAtMs: number
      cpuUserMs: number; cpuSystemMs: number; eventLoopActiveMs: number; eventLoopIdleMs: number
    }> = []
    try {
      const scenarios = scenariosFor(fixture)
      expect(Object.keys(scenarios)).toHaveLength(17)
      const results: Record<string, { counters: Counters; durationMs: number[]; iterations: number; warmups: number; samples: number; lane: Scenario['lane']; workload: string; outcome: 'completed' }> = {}
      for (const [name, scenario] of Object.entries(scenarios)) {
        const warmups = scenario.warmups ?? 1
        const samples = scenario.samples ?? 7
        for (let warmup = 0; warmup < warmups; warmup++) for (let iteration = 0; iteration < scenario.iterations; iteration++) await scenario.run()
        const durationMs: number[] = []
        let counters: Counters | undefined
        for (let sample = 0; sample < samples; sample++) {
          const cpuBefore = process.cpuUsage()
          const loopBefore = performance.eventLoopUtilization()
          const started = performance.now()
          let next: Counters | undefined
          for (let iteration = 0; iteration < scenario.iterations; iteration++) next = await scenario.run()
          const ended = performance.now()
          durationMs.push((ended - started) / scenario.iterations)
          const cpu = process.cpuUsage(cpuBefore)
          const loop = performance.eventLoopUtilization(loopBefore)
          batches.push({ scenario: name, sample, startedAtMs: started, endedAtMs: ended,
            cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
            eventLoopActiveMs: loop.active, eventLoopIdleMs: loop.idle })
          if (counters) expect(next).toEqual(counters)
          counters = next
        }
        results[name] = { counters: counters!, durationMs, iterations: scenario.iterations, warmups, samples, lane: scenario.lane, workload: scenario.workload, outcome: 'completed' }
      }
      expect(results['trace.delivery'].counters.events).toBe(events.length)
      expect(results['renderer.batch'].counters.turns).toBe(1)
      expect(results['history.page'].counters.turns).toBe(40)
      expect(results['terminal.delivery'].counters.outputBytes).toBeGreaterThan(0)
      collectGarbageCollections(observer.takeRecords())
      expect(batches).toHaveLength(Object.values(results).reduce((count, result) => count + result.samples, 0))
      for (const batch of batches) {
        const result = results[batch.scenario]
        expect((batch.endedAtMs - batch.startedAtMs) / result.iterations).toBe(result.durationMs[batch.sample])
        expect(batch.cpuUserMs + batch.cpuSystemMs).toBeGreaterThanOrEqual(0)
      }
      const output = process.env.SCRY_PERFORMANCE_OUTPUT
      if (output) writeFileSync(output, JSON.stringify({
        schema: 1,
        measurement: { kind: 'batch-mean-ms', warmups: 3, samples: 15, iterationsPerSample: 20, perScenario: true },
        harness: createHash('sha256')
          .update(readFileSync('scripts/performance-baseline.test.ts'))
          .update(readFileSync('scripts/performance-baseline-fixture.ts'))
          .update(readFileSync('scripts/performance-baseline-scenarios.ts'))
          .update(readFileSync('vitest.config.ts'))
          .update(readFileSync('src/main/providers/fixtures/codex-app-server.mjs'))
          .digest('hex'),
        revision: process.env.SCRY_PERFORMANCE_REVISION ?? 'working-tree',
        environment: { node: process.versions.node, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
        results,
        diagnostics: { timeOriginEpochMs: performance.timeOrigin, batches, garbageCollections }
      }, null, 2))
    } finally {
      observer.disconnect()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('negative control: real duplicate publication increases transfer work', () => {
    const normal = deliverTrace(events)
    const duplicated = duplicateTraceControl()
    expect(duplicated.events).toBe(normal.events * 2)
    expect(duplicated.bytes).toBeGreaterThan(normal.bytes * 1.9)
    expect(duplicated.messages).toBeGreaterThan(normal.messages)
    expect(() => assertCompleteProjection(applyTraceBatch([activeTurn], events.slice(0, 1), new Set()))).toThrow()
  })
})
