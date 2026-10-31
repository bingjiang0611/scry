import { describe, expect, it, vi } from 'vitest'
import { createDesktopHostReader } from '../../src/main/remote/desktop-host-reader'
import { runConcurrencyTraceTrial } from '../fixtures/concurrency-trace-trial'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_CWD } from '../fixtures/concurrency-trace-workload'
import {
  buildObservations, defaultRepeats, registerProbeControl, startProbe, totalsMatchPhases, writeCollector,
  type ProbePhase, type ProbeSample
} from './concurrency-trace-probe'

// The accepted R4 cell, unchanged: 16 tasks, limit 4, one in-process reader, 1000 client items, 7 write
// stages, 112 polls per reader with independent oracles and 4 waves. Only phase attribution is added, by
// call-through wrappers that keep the production and fixture implementations exactly as they are.
const R4_CONFIG = { limit: 4, readers: 1, items: 1000 } as const
const R4_WORKLOAD = 'trace-r4-cell;tasks=16;limit=4;readers=1;items=1000;waves=4;stages=7;polls=112;oracles=112'
const R4_SOURCE = 'real runConcurrencyTraceTrial(limit 4, readers 1, items 1000) unchanged; counts node:crypto createHash calls, bytes accepted by Hash.update and JSON.stringify UTF-8 output bytes per phase; native digest internals, subprocesses, other hash APIs and byte copies are not counted, so this is not a CPU total and no millisecond result is read from the instrumented cell'

// Read at every counter increment: the wrappers below only move this value around a real call.
const phases = vi.hoisted(() => ({ current: 'other' as ProbePhase }))

// Call-through on the real write stage. The fixture keeps its implementation, its error handling and its own
// count contract; only the phase bucket changes while the real function runs.
vi.mock('../fixtures/concurrency-trace-workload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fixtures/concurrency-trace-workload')>()
  return {
    ...actual,
    applyWorkloadStep: (...args: Parameters<typeof actual.applyWorkloadStep>): void => {
      const previous = phases.current
      phases.current = 'writer'
      try {
        actual.applyWorkloadStep(...args)
      } finally {
        phases.current = previous
      }
    }
  }
})

// The reader bucket is the production host reader itself: the real factory is called through, and the
// function it returns is wrapped so the whole read (getRun access, bounded projection, revision hashing and
// the host's own response encoding) is attributed to the reader. The client and the fixture stay in 'other'.
vi.mock('../../src/main/remote/desktop-host-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/remote/desktop-host-reader')>()
  return {
    ...actual,
    createDesktopHostReader: (deps: Parameters<typeof actual.createDesktopHostReader>[0]) => {
      const reader = actual.createDesktopHostReader(deps)
      return async (query: Parameters<typeof reader>[0]): ReturnType<typeof reader> => {
        const previous = phases.current
        phases.current = 'reader'
        try {
          return await reader(query)
        } finally {
          phases.current = previous
        }
      }
    }
  }
})

const samples: ProbeSample[] = []

describe('concurrency trace R4 cell work counters', () => {
  registerProbeControl()

  // Boundary control: a known JSON.stringify inside the real reader's getRun callback has to land in the
  // reader bucket, and the same call outside any reader call has to land in 'other'. This fails if the
  // attribution wrapped a different seam.
  it('attributes host reader work to the reader bucket and leaves other work outside it', async () => {
    phases.current = 'other'
    const probe = startProbe(() => phases.current)
    try {
      const run = createWorkloadRun({ runId: 'run-boundary', k: 12 })
      applyWorkloadStep(run, 'seed', 12)
      const reader = createDesktopHostReader({
        userDataDir: '/fixture/concurrency-trace-boundary',
        hostId: () => 'host-boundary',
        authorizeWorkspace: (cwd: string) => cwd,
        getRun: (runId: string) => {
          JSON.stringify({ marker: 'inside-getRun', runId })
          return runId === run.runId ? run : null
        }
      })
      const result = await reader({
        kind: 'trace',
        context: { providerId: 'claude', cwd: WORKLOAD_CWD, externalSessionId: run.externalSessionId },
        runId: run.runId
      })
      expect(result.kind).toBe('trace')
      const insideReader = probe.read()
      // The getRun marker and the host's own response encoding are both inside the reader call.
      expect(insideReader.phases.reader.stringifyCalls).toBeGreaterThanOrEqual(2)
      const otherBefore = insideReader.phases.other.stringifyCalls
      JSON.stringify({ marker: 'outside-any-reader' })
      const afterOutside = probe.read()
      expect(afterOutside.phases.other.stringifyCalls).toBe(otherBefore + 1)
      expect(afterOutside.phases.reader.stringifyCalls).toBe(insideReader.phases.reader.stringifyCalls)
    } finally {
      probe.stop()
    }
  })

  it.each(Array.from({ length: defaultRepeats }, (_, index) => index + 1))('counts one complete cell (repeat %i)', async () => {
    phases.current = 'other'
    const probe = startProbe(() => phases.current)
    try {
      const result = await runConcurrencyTraceTrial({ ...R4_CONFIG })
      // The cell's own contract is the functional check; this lane adds no millisecond claim.
      expect(result.status).toBe('measured')
      expect(result.config).toEqual({ limit: 4, readers: 1, items: 1000 })
      expect(result.steps).toHaveLength(28)
      expect(result.peers).toHaveLength(1)
      const sample = probe.read()
      expect(totalsMatchPhases(sample)).toBe(true)
      samples.push(sample)
    } finally {
      probe.stop()
    }
  })

  it('aggregates the independent samples as unregistered candidates', () => {
    expect(samples).toHaveLength(defaultRepeats)
    writeCollector('concurrency-trace-r4', buildObservations({ scenario: 'trace.r4-cell', workload: R4_WORKLOAD, source: R4_SOURCE }, samples))
  })
})
