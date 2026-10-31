import { describe, expect, it } from 'vitest'
import { summarizeProcessCpu, summarizeResources } from './session-concurrency-lanes.mjs'
import { minimalReport } from './session-concurrency-report-fixture.mjs'
import { validateConcurrencyReport } from './session-concurrency-validate.mjs'

// The per-process lane reads Electron's from-start counter, so a fixture only needs two snapshots with
// metrics; the assertions below are about which processes may be claimed, never about a percentage.
const snapshot = metrics => ({ status: 'measured', snapshot: { monotonicMs: 0, cpu: { user: 0, system: 0 },
  memory: { rss: 1, heapUsed: 1, external: 0, arrayBuffers: 0 }, metrics } })
const metric = (pid, creationTime, cumulativeCpuSeconds, type = 'Tab') =>
  ({ pid, creationTime, cumulativeCpuSeconds, type, workingSetKb: 100 })

describe('per-process cumulative CPU', () => {
  it('reports the counter delta in milliseconds per type and in total', () => {
    const lane = summarizeProcessCpu({
      before: snapshot([metric(10, 1000, 1.5, 'Browser'), metric(20, 2000, 0.25)]),
      after: snapshot([metric(10, 1000, 1.75, 'Browser'), metric(20, 2000, 0.5)])
    })
    expect(lane).toMatchObject({ status: 'measured', totalCpuMs: 500,
      byType: { Browser: { processes: 1, cpuMs: 250 }, Tab: { processes: 1, cpuMs: 250 } },
      coverage: { endProcesses: 2, matchedProcesses: 2, matchedShare: 1 } })
    expect(lane.attribution).toMatch(/never added to mainProcessCpu/)
  })

  // pid reuse is the reason creationTime is part of the identity: the two samples are different processes.
  it('refuses to subtract counters across a different creationTime for the same pid', () => {
    const lane = summarizeProcessCpu({
      before: snapshot([metric(10, 1000, 5), metric(30, 3000, 1)]),
      after: snapshot([metric(10, 9000, 9), metric(30, 3000, 1.5)])
    })
    // Only pid 30 is claimable; pid 10 is reported as a vanished plus a new process, never as 4 s of CPU.
    expect(lane).toMatchObject({ status: 'partial', totalCpuMs: 500, byType: { Tab: { processes: 1, cpuMs: 500 } } })
    expect(lane.added).toEqual([{ pid: 10, type: 'Tab' }])
    expect(lane.removed).toEqual([{ pid: 10, type: 'Tab' }])
    expect(lane.note).toMatch(/listed, not zeroed/)
  })

  it('reports a vanished, an identity-less and a counter-less process beside the claimable one', () => {
    const gone = summarizeProcessCpu({ before: snapshot([metric(10, 1000, 1), metric(11, 1000, 1)]),
      after: snapshot([metric(10, 1000, 1.25)]) })
    expect(gone).toMatchObject({ status: 'partial', totalCpuMs: 250, removed: [{ pid: 11, type: 'Tab' }] })
    const anonymous = summarizeProcessCpu({ before: snapshot([{ type: 'Tab', pid: 12, workingSetKb: 1 }, metric(10, 1000, 1)]),
      after: snapshot([metric(10, 1000, 1.5)]) })
    expect(anonymous).toMatchObject({ status: 'partial', totalCpuMs: 500 })
    expect(anonymous.unidentified).toEqual([{ pid: 12, type: 'Tab', sample: 'before' }])
    expect(anonymous.coverage.unidentifiedProcesses).toBe(1)
    const noCounter = summarizeProcessCpu({ before: snapshot([metric(10, 1000, null), metric(30, 3000, 1)]),
      after: snapshot([metric(10, 1000, 2), metric(30, 3000, 1.25)]) })
    expect(noCounter).toMatchObject({ status: 'partial', totalCpuMs: 250, missingCounter: [{ pid: 10, type: 'Tab' }] })
  })

  it('does not claim a total when nothing can be matched', () => {
    const lane = summarizeProcessCpu({ before: snapshot([metric(10, 1000, 5)]), after: snapshot([metric(20, 2000, 1)]) })
    expect(lane.status).toBe('unavailable')
    expect(lane.totalCpuMs).toBeUndefined()
    expect(lane.coverage).toMatchObject({ matchedProcesses: 0, addedProcesses: 1, removedProcesses: 1 })
  })

  it('reports a backwards counter as a regression and never as a negative contribution', () => {
    const lane = summarizeProcessCpu({ before: snapshot([metric(10, 1000, 3)]), after: snapshot([metric(10, 1000, 1)]) })
    expect(lane.status).toBe('unavailable')
    expect(lane.regressed).toEqual([{ pid: 10, type: 'Tab', deltaMs: -2000 }])
    expect(lane.totalCpuMs).toBeUndefined()
  })

  // Active and quiet are two windows of the same counter: each delta starts where the previous ended, and
  // the second is never added to the first.
  it('measures active and quiet as consecutive windows instead of summing them', () => {
    const active = summarizeProcessCpu({ before: snapshot([metric(10, 1000, 1)]), after: snapshot([metric(10, 1000, 1.25)]) })
    const quiet = summarizeProcessCpu({ before: snapshot([metric(10, 1000, 1.25)]), after: snapshot([metric(10, 1000, 1.4)]) })
    expect([active.totalCpuMs, quiet.totalCpuMs]).toEqual([250, 150])
    expect(active.totalCpuMs + quiet.totalCpuMs).not.toBe(quiet.totalCpuMs)
  })

  // A scenario without a quiet window calls this with an undefined pair, exactly like summarizeBoundaries;
  // the lane has to answer unavailable instead of throwing while the run is already over.
  it('accepts an undefined boundary pair as the no-quiet-window case', () => {
    const lane = summarizeProcessCpu(undefined)
    expect(lane.status).toBe('unavailable')
    expect(lane.totalCpuMs).toBeUndefined()
    expect(lane.reason).toMatch(/no boundary pair for this lane/)
  })

  it('stays unavailable when a boundary is missing, so no CPU is inferred', () => {
    expect(summarizeProcessCpu({ before: null, after: snapshot([]) }).status).toBe('unavailable')
    expect(summarizeProcessCpu({ before: { status: 'unavailable', reason: 'dead channel' }, after: snapshot([]) }))
      .toMatchObject({ status: 'unavailable', reason: expect.stringContaining('dead channel') })
  })
})

describe('journal window CPU is not claimed', () => {
  it('keeps memory and process counts but reports the legacy percent as unavailable', () => {
    const window = { sampledAt: '2024-01-01T00:00:02.000Z', windowMs: 2000,
      main: { rssBytes: 200, heapUsedBytes: 120, externalBytes: 10, arrayBuffersBytes: 4, eventLoopP95Ms: 5, eventLoopMaxMs: 9 },
      processes: [{ type: 'renderer', cpuPercentOfOneCore: 40, workingSetBytes: 50, peakWorkingSetBytes: 60 }] }
    const lane = summarizeResources([window], 'active')
    expect(lane.status).toBe('measured')
    expect(lane.cpuPercent).toMatchObject({ status: 'unavailable' })
    expect(lane.cpuPercent.reason).toMatch(/since the previous getAppMetrics\(\) call/)
    expect(lane.cpuPercentOfOneCorePerWindow).toBeUndefined()
    expect(lane.processesPerWindow).toMatchObject({ max: 1 })
    expect(lane.workingSetBytesPerWindow).toMatchObject({ max: 50 })
  })
})

describe('report honesty for process CPU, GC and remote readers', () => {
  it('carries the process CPU lane without merging it into main CPU', () => {
    const report = minimalReport()
    expect(validateConcurrencyReport(report)).toBe(true)
    expect(report.lanes.processCpu.status).toBe('measured')
    expect(report.lanes.quietProcessCpu.status).toBe('unavailable')
    // The real non-quiet path: the builder must survive a lane built from an undefined quiet pair.
    const nonQuiet = minimalReport({ quietProcessCpu: summarizeProcessCpu(undefined) })
    expect(nonQuiet.lanes.quietProcessCpu).toMatchObject({ status: 'unavailable' })
    expect(validateConcurrencyReport(nonQuiet)).toBe(true)
    expect(report.honesty.processCpuAttribution).toMatch(/never added to mainProcessCpu/)
    expect(report.honesty.legacyWindowCpu).toMatch(/since-last-call/)
  })

  it('refuses a process CPU lane whose attribution does not exclude main CPU', () => {
    const report = minimalReport()
    const merged = { ...report, lanes: { ...report.lanes,
      processCpu: { ...report.lanes.processCpu, attribution: 'total Electron process CPU' } } }
    expect(() => validateConcurrencyReport(merged)).toThrow(/not summed into mainProcessCpu/)
  })

  it('states that GC residency is unobservable and that no remote reader exists yet', () => {
    const report = minimalReport()
    expect(report.lanes.gc).toMatchObject({ forced: false })
    expect(report.lanes.gc.postCollectionResidency.status).toBe('unavailable')
    expect(report.lanes.gc.note).toMatch(/not evidence that a natural collection ran/)
    expect(report.lanes.remoteReaders.reason).toBe('not yet implemented in this concurrency harness')
    expect(report.honesty.remoteReaders).toMatch(/remote trace host fixture exists/)
  })
})
