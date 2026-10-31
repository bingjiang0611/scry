import { describe, expect, it } from 'vitest'
import { classifyWindowPhase, pairBoundaries, summarizeBoundaries, summarizeObservedConcurrency,
  summarizeRendererMount, summarizeRendererTask } from './session-concurrency-lanes.mjs'
import { createDiagnosticReader, createOutputCapture } from './session-concurrency-electron.mjs'
import { historyReadinessScript } from './session-concurrency-ui.mjs'
import { evaluateStatus, selectScenario, summarizeSwitches } from './session-concurrency-contract.mjs'
import { MEASURED_MAIN, minimalReport } from './session-concurrency-report-fixture.mjs'
import { validateConcurrencyReport } from './session-concurrency-validate.mjs'

// Lanes for the real P0 call chain: boundary snapshots, CDP counters, overlap, framing, UI gates.

const snapshot = ({ user, system, monotonicMs, rss = 100, heapUsed = 50 }) => ({
  status: 'measured',
  snapshot: { cpu: { user, system }, monotonicMs, memory: { rss, heapUsed, external: 5, arrayBuffers: 2 },
    metrics: [{ type: 'browser', workingSetKb: 1024 }, { type: 'renderer', workingSetKb: 2048 },
      { type: 'renderer', workingSetKb: 512 }] }
})

describe('main process boundaries', () => {
  const before = snapshot({ user: 1_000_000, system: 500_000, monotonicMs: 10_000 })
  const after = snapshot({ user: 3_000_000, system: 1_000_000, monotonicMs: 11_000, rss: 300, heapUsed: 90 })

  it('turns a user+system delta over the main monotonic clock into main CPU', () => {
    const lane = summarizeBoundaries({ before, after, cpuCount: 10, startedAtEpochMs: 5, endedAtEpochMs: 15 })
    expect(lane.status).toBe('measured')
    // (2_000_000 + 500_000) us over 1000 ms = 2500 ms of CPU time = 2.5 cores busy.
    expect(lane.cpuMs).toBe(2_500)
    expect(lane.window).toMatchObject({ wallMs: 1_000 })
    expect(lane.avgCoresBusy).toBe(2.5)
    expect(lane.cpuPercentOfOneCore).toBe(250)
    expect(lane.cpuPercentOfMachine).toBe(25)
    expect(lane.main).toMatchObject({ rssBytesStart: 100, rssBytesEnd: 300, rssDeltaBytes: 200 })
    expect(lane.appMetricsEnd.processes).toBe(3)
    expect(lane.appMetricsEnd.byType.renderer).toMatchObject({ processes: 2, workingSetBytes: 2_560 * 1024 })
    // The attribution string is what stops this being read as Provider CPU or as a peak.
    expect(lane.attribution).toMatch(/in-process offline smoke Provider; not an isolated Provider CPU/)
    expect(lane.note).toMatch(/peak working set would need continuous sampling/)
  })

  it('reports unavailable when a boundary is missing or the clock went backwards', () => {
    const missing = summarizeBoundaries({ before: { status: 'unavailable', reason: 'no snapshot reply' },
      after, cpuCount: 10, startedAtEpochMs: 1, endedAtEpochMs: 2 })
    expect(missing.status).toBe('unavailable')
    expect(missing.reason).toMatch(/no snapshot reply/)
    expect(missing).not.toHaveProperty('cpuMs')
    const backwards = summarizeBoundaries({ before: after, after: before, cpuCount: 10,
      startedAtEpochMs: 1, endedAtEpochMs: 2 })
    expect(backwards.status).toBe('unavailable')
    expect(backwards.reason).toMatch(/not usable/)
  })

  it('turns renderer TaskDuration into task time without calling it CPU or commit', () => {
    const lane = summarizeRendererTask({
      before: { timestampSeconds: 100, taskDurationSeconds: 10, jsHeapUsedBytes: 1_000, nodes: 100 },
      after: { timestampSeconds: 101.5, taskDurationSeconds: 10.25, jsHeapUsedBytes: 2_000, nodes: 140 },
      cpuCount: 10
    })
    expect(lane).toMatchObject({ status: 'measured', taskMs: 250, wallMs: 1_500 })
    expect(lane.attribution).toMatch(/not React commit latency/)
    expect(lane).not.toHaveProperty('cpuMs')
    const missing = summarizeRendererTask({ before: null, after: { timestampSeconds: 1, taskDurationSeconds: 1 }, cpuCount: 10 })
    expect(missing.status).toBe('unavailable')
    expect(missing.reason).toMatch(/TaskDuration/)
  })
})

describe('observed concurrency', () => {
  const interval = (runId, requestedStartEpochMs, requestedEndEpochMs, acceptedStartEpochMs) =>
    ({ runId, requestedStartEpochMs, requestedEndEpochMs, acceptedStartEpochMs })

  it('reports requested overlap and accepted overlap separately', () => {
    const lane = summarizeObservedConcurrency({ configured: 4, intervals: [
      interval('a', 0, 400, 300), interval('b', 10, 410, 310),
      interval('c', 20, 420, 320), interval('d', 30, 500, 490)
    ] })
    expect(lane).toMatchObject({ status: 'measured', runs: 4,
      requested: { peakConcurrentRuns: 4, verdict: 'overlap-confirmed' },
      acceptedActive: { peakConcurrentRuns: 3, verdict: 'below-configured', terminalBeforeReplyRuns: 0 } })
    expect(lane.note).toMatch(/neither number proves CPU-level parallelism/)
  })

  // Negative control: four requests overlap while awaiting acceptance, but acceptance is serial.
  it('reports four overlapping requests accepted serially', () => {
    const lane = summarizeObservedConcurrency({ configured: 4, intervals: [
      interval('a', 0, 100, 50), interval('b', 10, 200, 150),
      interval('c', 20, 300, 250), interval('d', 30, 400, 350)
    ] })
    expect(lane.requested).toMatchObject({ peakConcurrentRuns: 4, verdict: 'overlap-confirmed' })
    expect(lane.acceptedActive).toMatchObject({ peakConcurrentRuns: 1, verdict: 'below-configured' })
    expect(lane.acceptedActive.peakConcurrentRuns).toBeLessThan(lane.requested.peakConcurrentRuns)
  })

  it('records a terminal before the reply as a zero-length accepted window', () => {
    const lane = summarizeObservedConcurrency({ configured: 4, intervals: [interval('a', 0, 5, 100)] })
    expect(lane.acceptedActive.terminalBeforeReplyRuns).toBe(1)
    const span = lane.acceptedActive.intervals[0]
    expect(span.terminalBeforeReply).toBe(true)
    expect(span.durationMs).toBe(0)
    expect(span.start).toBe(span.end)
    expect(lane.acceptedActive.note).toMatch(/zero-length accepted window/)
  })

  it('counts touching intervals as sequential', () => {
    const lane = summarizeObservedConcurrency({ configured: 4, intervals: [interval('a', 0, 100, 0), interval('b', 100, 200, 100)] })
    expect(lane.requested.peakConcurrentRuns).toBe(1)
    expect(lane.acceptedActive.peakConcurrentRuns).toBe(1)
  })

  it('reports unavailable without intervals and flags a missing reply', () => {
    expect(summarizeObservedConcurrency({ configured: 4, intervals: [] }).status).toBe('unavailable')
    const lane = summarizeObservedConcurrency({ configured: 4, intervals: [interval('a', 0, 100, undefined)] })
    expect(lane.status).toBe('measured')
    expect(lane.requested.peakConcurrentRuns).toBe(1)
    expect(lane.acceptedActive).toMatchObject({ status: 'unavailable' })
    expect(lane.acceptedActive.reason).toMatch(/start reply time is missing/)
  })
})

describe('active and quiet boundary pairing', () => {
  const sample = (label, takenAtEpochMs, cpuMs) => ({ label, takenAtEpochMs,
    main: { status: 'measured', snapshot: { cpu: { user: cpuMs * 1000, system: 0 }, monotonicMs: takenAtEpochMs,
      memory: { rss: 1, heapUsed: 1, external: 0, arrayBuffers: 0 }, metrics: [] } },
    renderer: { timestampSeconds: takenAtEpochMs / 1000, taskDurationSeconds: cpuMs / 1000 } })
  const before = sample('before', 1_000, 0)
  const afterTerminal = sample('after-terminal', 2_000, 250)
  const afterQuiet = sample('after-quiet', 7_000, 270)

  it('ends the active pair at the terminal boundary even when a quiet window follows', () => {
    const pairs = pairBoundaries({ before, afterTerminal, afterQuiet, quietWindowMs: 5000 })
    expect(pairs.active.main.startedAtEpochMs).toBe(1_000)
    expect(pairs.active.main.endedAtEpochMs).toBe(2_000)
    expect(pairs.quiet.main.startedAtEpochMs).toBe(2_000)
    expect(pairs.quiet.main.endedAtEpochMs).toBe(7_000)
    const active = summarizeBoundaries({ ...pairs.active.main, cpuCount: 10 })
    expect(active.window.wallMs).toBe(1_000)
    expect(active.cpuMs).toBe(250)
    const quiet = summarizeBoundaries({ ...pairs.quiet.main, cpuCount: 10 })
    expect(quiet.window.wallMs).toBe(5_000)
    expect(quiet.cpuMs).toBe(20)
  })

  it('produces no quiet pair and flags an incomplete quiet window', () => {
    expect(pairBoundaries({ before, afterTerminal, afterQuiet, quietWindowMs: 0 }).quiet).toBeNull()
    const missing = pairBoundaries({ before, afterTerminal, afterQuiet: null, quietWindowMs: 5000 })
    expect(missing.quiet).toBeNull()
    expect(missing.quietIncomplete).toBe(true)
  })
})

describe('resource window phases', () => {
  const phases = [
    { name: 'startup', since: 0, until: 1_000 },
    { name: 'active', since: 1_000, until: 5_000 },
    { name: 'quiet', since: 5_000, until: 9_000 }
  ]
  const window = (sampledAt, windowMs = 5_000) => ({ sampledAt: new Date(sampledAt).toISOString(), windowMs })

  it('assigns a window only when it lies inside one phase', () => {
    expect(classifyWindowPhase(window(4_000, 2_000), phases)).toBe('active')
    expect(classifyWindowPhase(window(8_000, 2_000), phases)).toBe('quiet')
    expect(classifyWindowPhase(window(1_000, 2_000), phases)).toBe('startup')
  })

  it('reports a window that crosses a boundary as spanning rather than picking the closer phase', () => {
    // Tail 4000..9000 crosses active -> quiet; the sample end point alone would have said "quiet".
    expect(classifyWindowPhase(window(9_000, 5_000), phases)).toBe('spanning')
    expect(classifyWindowPhase(window(6_000, 5_000), phases)).toBe('spanning')
  })

  it('reports an unparseable or outside-every-phase window as unknown', () => {
    expect(classifyWindowPhase({ sampledAt: 'not-a-date', windowMs: 5_000 }, phases)).toBe('unknown')
    expect(classifyWindowPhase(window(50_000, 1_000), phases)).toBe('unknown')
  })
})

describe('diagnostic stream framing', () => {
  it('reassembles a diagnostic line split across chunks instead of calling it malformed', () => {
    const lines = []
    const reader = createDiagnosticReader(line => lines.push(line))
    reader.push('{"a":')
    reader.push('1}\nsecond line\n')
    reader.flush()
    expect(lines).toEqual(['{"a":1}', 'second line'])
  })

  it('keeps the trailing line that has no final newline', () => {
    const lines = []
    const reader = createDiagnosticReader(line => lines.push(line))
    reader.push('first\nlast-without-newline')
    reader.flush()
    expect(lines).toEqual(['first', 'last-without-newline'])
  })

  it('captures both streams, keeps a truncated marker and reports the actual text', () => {
    const lines = []
    const capture = createOutputCapture({ limitChars: 12, onLine: line => lines.push(line) })
    capture.stdout('hello ')
    capture.stdout('world\n')
    capture.stderr('oops\n')
    expect(capture.truncated()).toBe(true)
    expect(lines).toEqual(['hello world', 'oops'])
    // The retained text stops at the cap but still reports that it was cut.
    expect(capture.finish().length).toBe(12)
  })
})

describe('report lanes for the new measurements', () => {
  it('rejects a report that relabels main CPU as Provider CPU', () => {
    const report = minimalReport()
    expect(validateConcurrencyReport(report)).toBe(true)
    const relabelled = { ...report, lanes: { ...report.lanes,
      mainProcessCpu: { ...report.lanes.mainProcessCpu, providerProcessCpu: 12 } } }
    expect(() => validateConcurrencyReport(relabelled)).toThrow(/Provider CPU/)
  })

  it('rejects a measured main CPU lane with no attribution of what it includes', () => {
    const report = minimalReport()
    const vague = { ...report, lanes: { ...report.lanes, mainProcessCpu: { ...MEASURED_MAIN, attribution: 'main process' } } }
    expect(() => validateConcurrencyReport(vague)).toThrow(/must name what it includes/)
  })

  it('rejects an overlap verdict that contradicts the measured peak', () => {
    const report = minimalReport()
    const faked = { ...report, lanes: { ...report.lanes, observedConcurrency: { status: 'measured', configured: 4,
      requested: { peakConcurrentRuns: 4, verdict: 'overlap-confirmed' },
      acceptedActive: { peakConcurrentRuns: 3, verdict: 'overlap-confirmed', terminalBeforeReplyRuns: 0 },
      note: 'neither number proves CPU-level parallelism or a native Provider process count' } } }
    expect(() => validateConcurrencyReport(faked)).toThrow(/verdict must follow its own measured peak/)
  })

  it('rejects an accepted overlap larger than the requested overlap it is contained in', () => {
    const report = minimalReport()
    const impossible = { ...report, lanes: { ...report.lanes, observedConcurrency: { status: 'measured', configured: 4,
      requested: { peakConcurrentRuns: 2, verdict: 'below-configured' },
      acceptedActive: { peakConcurrentRuns: 3, verdict: 'below-configured', terminalBeforeReplyRuns: 0 },
      note: 'neither number proves CPU-level parallelism or a native Provider process count' } } }
    expect(() => validateConcurrencyReport(impossible)).toThrow(/cannot exceed the requested overlap/)
  })

  it('refuses a quiet CPU lane for a scenario with no quiet window', () => {
    const report = minimalReport()
    const faked = { ...report, lanes: { ...report.lanes, quietMainProcessCpu: { status: 'measured', cpuMs: 5,
      window: { startedAtEpochMs: 1, endedAtEpochMs: 2, wallMs: 1 } } } }
    expect(() => validateConcurrencyReport(faked)).toThrow(/must not report quiet CPU/)
  })

  it('refuses a quiet window that starts before the active window ended', () => {
    const withQuiet = (report) => ({ ...report,
      workload: { ...report.workload, quietWindowMs: 5000 },
      lanes: { ...report.lanes,
        mainProcessCpu: { ...MEASURED_MAIN, window: { startedAtEpochMs: 1_000, endedAtEpochMs: 2_000, wallMs: 1_000 } },
        quietMainProcessCpu: { status: 'measured', cpuMs: 5, window: { startedAtEpochMs: 1_500, endedAtEpochMs: 6_500, wallMs: 5_000 } },
        quietRendererTask: { status: 'unavailable', reason: 'CDP Performance.getMetrics TaskDuration was not readable at both boundaries' } } })
    expect(() => validateConcurrencyReport(withQuiet(minimalReport()))).toThrow(/must begin at the active window end/)
  })
})

describe('history switch readiness', () => {
  it('waits for the latest seeded turn, not turn 0, in a settled transcript', () => {
    const script = historyReadinessScript({ sessionId: 'conc-2-history', latestIndex: 19 })
    expect(script).toContain('[data-run-id="conc-2-history-turn-19"]')
    expect(script).not.toContain('turn-0')
    expect(script).toContain('aria-busy="false"')
    expect(script).toMatch(/input\.disabled \|\| input\.readOnly/)
    expect(script).toContain('END conc-2-history 19')
  })
})

describe('UI switch and Overview gating', () => {
  const scenario = selectScenario('history-switch')
  const run = { settled: true, terminalConfirmed: true, archiveReadable: true, diskVerified: true, evaluation: { passed: true } }

  // Reported defect: four switches landed but every Overview stayed hidden.
  it('is incomplete when all history switches landed but no Overview became visible', () => {
    const summary = summarizeSwitches(scenario, Array.from({ length: 4 }, (_, index) =>
      ({ sessionId: `conc-${index}-history`, mode: 'native-click', overview: 'blocked-panel-hidden', switchMs: 40 })))
    expect(summary).toMatchObject({ status: 'incomplete', nativeClick: 4, overviewVisible: 0 })
    expect(summary.blocked).toHaveLength(4)
    expect(summary.reason).toMatch(/Overview panel was not visibly open/)
  })

  it('is measured only when every switch and every Overview is real', () => {
    const proven = Array.from({ length: 4 }, (_, index) => ({ sessionId: `conc-${index}-history`,
      mode: 'native-click', overview: 'visible', switchMs: 40 }))
    expect(summarizeSwitches(scenario, proven)).toMatchObject({ status: 'measured', nativeClick: 4, overviewVisible: 4 })
    const three = { status: 'measured', nativeClick: 4, overviewVisible: 3 }
    const status = switches => evaluateStatus({ scenario, concurrency: 1, runs: [run], failures: [], switches, cleanupConfirmed: true })
    expect(status(three)).toBe('incomplete')
    expect(status(summarizeSwitches(scenario, proven))).toBe('measured')
  })

  it('charges an unverified receipt as blocked', () => {
    const summary = summarizeSwitches(scenario, Array.from({ length: 4 }, () => ({ mode: 'click-unverified-receipt',
      readiness: 'not-waited-unproven-click', overview: 'not-attempted-unproven-history-click', switchMs: 5 })))
    expect(summary).toMatchObject({ status: 'incomplete', nativeClick: 0, overviewVisible: 0 })
  })
})

describe('history switch gating', () => {
  // Negative control: re-clicking the selected row is not a switch.
  it('counts an adjacent repeated target as incomplete', () => {
    const scenario = selectScenario('history-switch')
    const repeated = Array.from({ length: 4 }, () => ({ sessionId: 'conc-0-history', mode: 'native-click',
      overview: 'visible', switchMs: 8 }))
    const summary = summarizeSwitches(scenario, repeated)
    expect(summary).toMatchObject({ status: 'incomplete', nativeClick: 4, overviewVisible: 4, adjacentRepeats: 3 })
    // The first click was a real switch; the three repeats are the blocked operations.
    expect(summary.blocked).toEqual(repeated.slice(1))
    expect(summary.blocked).toHaveLength(3)
    expect(summary.reason).toMatch(/repeated the selected target/)
  })
})
