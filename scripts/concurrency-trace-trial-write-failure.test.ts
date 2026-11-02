import { describe, expect, it, vi } from 'vitest'
import { runConcurrencyTraceTrial } from './fixtures/concurrency-trace-trial'
import type { TrialResult } from './fixtures/concurrency-trace-trial-report'

// Partial-write lane, split from the completed-cell file by responsibility: this file owns the
// question "what does a wave that failed mid-write leave behind". The writer fixture itself is
// intercepted, so the real writer still runs and the failure is injected between two real seeds.

const ITEMS = 1000

// Two writer calls happen for real and the second one throws right after writing, so the wave is
// half written and the trial must not pretend the other half was ever produced.
const writeCalls = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./fixtures/concurrency-trace-workload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fixtures/concurrency-trace-workload')>()
  return {
    ...actual,
    applyWorkloadStep: (
      run: Parameters<typeof actual.applyWorkloadStep>[0],
      step: Parameters<typeof actual.applyWorkloadStep>[1],
      k: number
    ): void => {
      writeCalls.calls += 1
      const call = writeCalls.calls
      actual.applyWorkloadStep(run, step, k)
      if (call === 2) throw new Error('injected writer failure')
    }
  }
})

describe('concurrency trace trial partial write', () => {
  it('keeps the observed counts and the writer CPU of a wave that failed mid-write', async () => {
    // Deterministic CPU: every fresh snapshot advances by a fixed 7/3, so both a
    // `cpuUsage(previous)` delta and a manual subtraction of two snapshots answer the same
    // value. No assertion below depends on real elapsed CPU time.
    const originalCpuUsage = process.cpuUsage
    let snapshotUser = 0
    let snapshotSystem = 0
    const cpuSpy = vi.spyOn(process, 'cpuUsage').mockImplementation(((previous?: NodeJS.CpuUsage) => {
      if (previous !== undefined) return { user: 7, system: 3 }
      snapshotUser += 7
      snapshotSystem += 3
      return { user: snapshotUser, system: snapshotSystem }
    }) as typeof originalCpuUsage)
    let result: TrialResult | undefined
    try {
      result = await runConcurrencyTraceTrial({ limit: 4, readers: 0, items: ITEMS })
    } finally {
      cpuSpy.mockRestore()
    }

    if (!result) throw new Error('the trial returned no result')
    expect(result.status).toBe('incomplete')
    if (result.status !== 'incomplete') throw new Error('unreachable')
    expect(result.error.stage).toBe('write')
    expect(result.error.step).toBe('seed')
    expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['seed:incomplete'])
    expect(result.steps[0].runs).toBe(4)
    expect(result.steps[0].expectedItemsPerRun).toBe(ITEMS)
    // Two runs were really seeded; the other two are the empty runs they actually are. The
    // contract target must not be filled in for a write that never happened.
    expect(result.steps[0].itemsObserved).toEqual([1000, 1000, 0, 0])
    // The aborted batch still spent writer CPU, and the recorded value is the observed delta.
    expect(result.steps[0].writerCpu).toEqual({ userMicros: 7, systemMicros: 3 })
    // No reader exists in this cell, so no reader evidence may be invented for it.
    expect(result.peers).toEqual([])
    expect(result.steps[0].host.logicalPolls).toBe(0)
    expect(result.steps[0].clientAttempts).toBe(0)
    // Not retried: exactly two writer calls, and the wave never reached a second step.
    expect(writeCalls.calls).toBe(2)
    // Nothing was verified, so no run may be reported complete or reconciled.
    expect(result.tasks).toEqual({ total: 16, completed: 0, notStarted: 12, startedIncomplete: 4 })
    expect(result.reconciliation).toEqual([])
    // A write-phase failure must not skip teardown.
    expect(result.cleanup).toBe('completed')
    expect(result.directory).toBeUndefined()
  })
})
