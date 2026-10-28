import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RENDERER_COMMIT_UNAVAILABLE, associateOutcomes, decideRetention, summarizeRendererObservation,
  summarizeTraceHealth } from './session-concurrency-aggregate.mjs'
import { summarizeObservedConcurrency, summarizePhases, summarizeRendererMount, summarizeResources }
  from './session-concurrency-lanes.mjs'
import { CONCURRENCY_SCENARIOS, evaluateArchiveEvidence, evaluateStatus, parseConcurrency, selectScenario,
  summarizeSwitches } from './session-concurrency-contract.mjs'
import { seedProjectPinning } from './session-concurrency-evidence.mjs'
import { buildConcurrencyReport } from './session-concurrency-report.mjs'
import { validateConcurrencyReport } from './session-concurrency-validate.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const smoke = readFileSync(join(root, 'src/main/providers/smoke.ts'), 'utf8')

describe('workload contract', () => {
  it('accepts only declared concurrency levels and defaults to 4', () => {
    expect(parseConcurrency(undefined)).toBe(4)
    expect(parseConcurrency('')).toBe(4)
    expect(parseConcurrency('16')).toBe(16)
    expect(() => parseConcurrency('8')).toThrow(/concurrency must be one of 4\/16/)
    expect(() => parseConcurrency('four')).toThrow(/concurrency must be one of 4\/16/)
  })

  it('names scenarios that exist in the offline fixture', () => {
    for (const [name, scenario] of Object.entries(CONCURRENCY_SCENARIOS)) {
      expect(typeof name).toBe('string')
      expect(smoke).toContain(`'${scenario.prompt}'`)
    }
    expect(() => selectScenario('nope')).toThrow(/unknown scenario/)
    expect(selectScenario('big-output').expect.toolResultPayloadBytes).toBe(12 * 1024 * 1024)
    expect(selectScenario('history-switch').switches).toBe(4)
    expect(selectScenario('quiet').quietMs).toBeGreaterThan(0)
  })
})

describe('archive evidence', () => {
  const streamEvidence = (overrides = {}) => ({
    userText: 'performance long stream',
    done: true,
    streamSections: 10,
    streamTokens: 12_800,
    toolResult: { textChars: 96, contentRef: { sha256: 'a'.repeat(64), bytes: 128 } },
    raw: { status: 'read', bytes: 128, sha256Match: true },
    ...overrides
  })

  it('passes only when the fixed stream structure and the re-read content digest match', () => {
    const result = evaluateArchiveEvidence(selectScenario('stream'), streamEvidence())
    expect(result.passed).toBe(true)
    expect(result.verifiedContentRef).toEqual({ sha256: 'a'.repeat(64), bytes: 128 })
  })

  it('fails a shrunk stream instead of reporting a faster run', () => {
    const result = evaluateArchiveEvidence(selectScenario('stream'), streamEvidence({ streamTokens: 11_200 }))
    expect(result.passed).toBe(false)
    expect(result.checks.find(check => check.name === 'streamTokens')).toMatchObject({
      observed: 11_200, expected: 12_800, passed: false
    })
  })

  it('fails when the referenced content blob is missing or has a different digest', () => {
    const missing = evaluateArchiveEvidence(selectScenario('stream'), streamEvidence({ raw: { status: 'missing-content-blob' } }))
    expect(missing.passed).toBe(false)
    expect(missing.checks.find(check => check.name === 'contentRefDigest').observed).toBe(false)
    const wrongBytes = evaluateArchiveEvidence(selectScenario('stream'),
      streamEvidence({ raw: { status: 'read', bytes: 64, sha256Match: true } }))
    expect(wrongBytes.checks.find(check => check.name === 'contentRefRawBytes')).toMatchObject({ observed: 64, expected: 128 })
  })

  it('requires the 12 MiB payload to be present in the re-read blob for big-output', () => {
    const payload = 12 * 1024 * 1024
    const evidence = {
      userText: 'packaged fake-provider smoke', done: true, streamSections: 0, streamTokens: 0,
      toolResult: { textChars: 8_192, contentRef: { sha256: 'b'.repeat(64), bytes: payload + 300 } },
      raw: { status: 'read', bytes: payload + 300, sha256Match: true, payloadRun: payload, tailPresent: true }
    }
    expect(evaluateArchiveEvidence(selectScenario('big-output'), evidence).passed).toBe(true)
    const truncated = evaluateArchiveEvidence(selectScenario('big-output'),
      { ...evidence, raw: { ...evidence.raw, payloadRun: payload / 2, tailPresent: false } })
    expect(truncated.passed).toBe(false)
    expect(truncated.checks.filter(check => !check.passed).map(check => check.name).sort())
      .toEqual(['contentRefPayloadRun', 'contentRefTailMarker'])
  })
})

describe('resource aggregation', () => {
  const window = (sampledAt, renderer, main) => ({
    sampledAt, windowMs: 2000, main,
    processes: [
      { type: 'browser', cpuPercentOfOneCore: 12, workingSetBytes: 100, peakWorkingSetBytes: 140 },
      { type: 'renderer', cpuPercentOfOneCore: renderer[0], workingSetBytes: 50, peakWorkingSetBytes: 60 },
      { type: 'renderer', cpuPercentOfOneCore: renderer[1], workingSetBytes: 25, peakWorkingSetBytes: 30 }
    ]
  })

  it('sums each window internally and distributes the per-window values', () => {
    const summary = summarizeResources([
      window('2024-01-01T00:00:02.000Z', [30, 10], { rssBytes: 200, heapUsedBytes: 120, externalBytes: 10, arrayBuffersBytes: 4, eventLoopP95Ms: 5, eventLoopMaxMs: 9 }),
      window('2024-01-01T00:00:04.000Z', [20, 2], { rssBytes: 400, heapUsedBytes: 160, externalBytes: 20, arrayBuffersBytes: 8, eventLoopP95Ms: 7, eventLoopMaxMs: 11 })
    ], 'active')
    expect(summary.status).toBe('measured')
    // The journal window's CPU percent is unclaimable; memory and process counts still aggregate per window.
    expect(summary.cpuPercent.status).toBe('unavailable')
    expect(summary.processesByType.renderer.processesPerWindow).toMatchObject({ count: 2, max: 2 })
    expect(summary.processesByType.renderer.workingSetBytesPerWindow.max).toBe(75)
    expect(summary.main.rssBytes.max).toBe(400)
    expect(summary.main.rssBytes.count).toBe(2)
  })

  it('reports unavailable without a reasonless number when no window exists', () => {
    const summary = summarizeResources([], 'active')
    expect(summary.status).toBe('unavailable')
    expect(summary.reason).toMatch(/no \[scry:resource\] window during active/)
  })
})

describe('renderer attribution honesty', () => {
  it('reports commit latency unavailable and explains why counters are not a substitute', () => {
    const probe = { batches: [{ batchId: 1, generation: 0, bytes: 4096, events: 12, runIds: ['run-a'], at: 5, firstTextAt: 3, firstTextRunId: 'run-a' }],
      health: [{ degraded: false, skippedEvents: 0, bufferedEvents: 1, bufferedBytes: 10, inFlightBytes: 0, resyncRequired: false }],
      longTasks: { supported: true, count: 1, totalMs: 60, maxMs: 60 }, domMutations: { observed: true, count: 4, lastAt: 9 } }
    const observation = summarizeRendererObservation(probe)
    expect(observation.status).toBe('measured')
    expect(observation).not.toHaveProperty('commitMs')
    expect(observation.domMutations.count).toBe(4)
    expect(summarizeTraceHealth(probe).status).toBe('measured')
    expect(summarizeRendererObservation(undefined)).toMatchObject({ status: 'unavailable' })
    expect(summarizeRendererObservation({ batches: [] }).status).toBe('unavailable')
    expect(summarizePhases([]).status).toBe('unavailable')
  })
})

describe('report status', () => {
  const run = (overrides = {}) => ({
    runId: 'run-a', prompt: 'performance long stream', externalSessionId: 'sess-a', startReceiptMs: 5,
    firstOutputReceiptMs: null, startToTerminalMs: 900, startRequestedAtEpochMs: 1_700_000_000_000,
    startReplyAtEpochMs: 1_700_000_000_005, terminalAtEpochMs: 1_700_000_000_900,
    traceEvents: 40, traceMirrored: false,
    settled: true, terminalConfirmed: true, archiveReadable: true, diskVerified: true,
    evidence: { userText: 'performance long stream', done: true, streamSections: 10, streamTokens: 12_800,
      toolResult: { textChars: 96, contentRef: { sha256: 'c'.repeat(64), bytes: 128 } },
      raw: { status: 'read', bytes: 128, sha256Match: true } },
    evaluation: { passed: true, checks: [
      { name: 'promptArchived', observed: 'performance long stream', expected: 'performance long stream', passed: true },
      { name: 'turnDone', observed: true, expected: true, passed: true },
      { name: 'toolResultPresent', observed: true, expected: true, passed: true },
      { name: 'toolResultTextChars', observed: 96, expected: { atLeast: 1 }, passed: true }
    ] },
    ...overrides
  })

  const report = (mutate = {}) => {
    const runs = [run(), run({ runId: 'run-b' }), run({ runId: 'run-c' }), run({ runId: 'run-d' })]
    const scenario = selectScenario('stream')
    const switches = summarizeSwitches(scenario, [])
    const parts = {
      scenario, concurrency: 4,
      identity: { sourceSha: 'd'.repeat(40), artifactSha256: 'e'.repeat(64), harnessSha256: 'f'.repeat(64),
        fixtureSha256: '1'.repeat(64), platform: 'darwin', arch: 'arm64', osRelease: '23.0.0', cpuModel: 'apple',
        cpuCount: 10, totalMemoryBytes: 1, node: 'v22.0.0', electron: '32.0.0', appVersion: '0.1.0' },
      runs, failures: [],
      // Boundary lanes come from the harness; this factory supplies a plausible measured set.
      mainCpu: { status: 'measured', source: 'fixture bootstrap Node IPC boundary snapshots',
        attribution: 'main process CPU including the in-process offline smoke Provider; not an isolated Provider CPU and not a peak',
        window: { startedAtEpochMs: 1_700_000_000_000, endedAtEpochMs: 1_700_000_001_000, wallMs: 1000 },
        cpuMs: 320, avgCoresBusy: 0.32, appMetricsEnd: { processes: 4 }, note: 'sample count 2 (start/end)' },
      rendererTask: { status: 'measured', source: 'CDP Performance.getMetrics TaskDuration delta across the same two boundaries',
        attribution: 'renderer main thread task time; not renderer process CPU, not frame time, not React commit latency',
        taskMs: 140, wallMs: 1000 },
      observedConcurrency: summarizeObservedConcurrency({ configured: 4, intervals: [
        { runId: 'run-a', requestedStartEpochMs: 1_700_000_000_000, requestedEndEpochMs: 1_700_000_000_900, acceptedStartEpochMs: 1_700_000_000_005 },
        { runId: 'run-b', requestedStartEpochMs: 1_700_000_000_010, requestedEndEpochMs: 1_700_000_000_910, acceptedStartEpochMs: 1_700_000_000_015 },
        { runId: 'run-c', requestedStartEpochMs: 1_700_000_000_020, requestedEndEpochMs: 1_700_000_000_920, acceptedStartEpochMs: 1_700_000_000_025 },
        { runId: 'run-d', requestedStartEpochMs: 1_700_000_000_030, requestedEndEpochMs: 1_700_000_000_930, acceptedStartEpochMs: 1_700_000_000_035 }] }),
      quietMainCpu: { status: 'unavailable', reason: 'scenario has no quiet window' },
      quietRendererTask: { status: 'unavailable', reason: 'scenario has no quiet window' },
      switchPreparation: [], switchStartedRows: [],
      rendererMount: summarizeRendererMount([{ runId: 'run-a', mounted: true, textChars: 100 },
        { runId: 'run-b', mounted: false, textChars: 0 }, { runId: 'run-c', mounted: false, textChars: 0 },
        { runId: 'run-d', mounted: false, textChars: 0 }]),
      resourceSampling: { intervalMs: 5000,
        source: 'src/main/bootstrap/app-lifecycle.ts startPerformanceResourceMonitor({ intervalMs: 5000 })',
        windows: 1, fullyInsidePhase: 1, spanning: 0, unknown: 0 },
      spanningResources: { status: 'unavailable', reason: 'no [scry:resource] window during spanning' },
      probe: { batches: [{ batchId: 1, generation: 0, bytes: 10, events: 2, runIds: ['run-a'], at: 1, firstTextAt: 1, firstTextRunId: 'run-a' }],
        health: [{ degraded: false, skippedEvents: 0, bufferedEvents: 1, bufferedBytes: 1, inFlightBytes: 0, resyncRequired: false }],
        longTasks: { supported: false }, domMutations: { observed: false } },
      resources: summarizeResources([{ sampledAt: '2024-01-01T00:00:02.000Z', windowMs: 2000,
        main: { rssBytes: 1, heapUsedBytes: 1, externalBytes: 1, arrayBuffersBytes: 1, eventLoopP95Ms: 1, eventLoopMaxMs: 1 },
        processes: [{ type: 'renderer', cpuPercentOfOneCore: 1, workingSetBytes: 1, peakWorkingSetBytes: 1 }] }], 'active'),
      quietResources: { status: 'unavailable', reason: 'scenario has no quiet window' },
      startupResources: { status: 'unavailable', reason: 'no [scry:resource] window during startup' },
      rendererWindows: [], phases: summarizePhases([]),
      journal: { status: 'measured', records: 3, issues: [], builds: ['a'.repeat(64)], health: 1, droppedRecords: 0 },
      sqlite: { status: 'ready', turns: 8, readMs: 2 },
      cleanup: { stopped: true, leftoverOwnedProcesses: [], cleanupConfirmed: true },
      switches, archiveFiles: { segments: 4, ignored: 0, rootPresent: true }, sidebarSessions: 8,
      diagnostics: { status: 'measured', logLines: 40, logTruncated: false, malformedDiagnosticLines: 1,
        malformedSamples: ['[scry:resource] {trunc'], logPath: '/tmp/app.log', logRetained: false },
      ...mutate
    }
    return { parts, report: buildConcurrencyReport(parts) }
  }

  it('is measured when every run settled and its durable evidence verified', () => {
    const { report: built } = report()
    expect(built.status).toBe('measured')
    expect(validateConcurrencyReport(built)).toBe(true)
    expect(built.lanes.rendererCommit).toEqual({ status: 'unavailable', reason: RENDERER_COMMIT_UNAVAILABLE })
    expect(built.lanes.remoteReaders.status).toBe('unavailable')
    expect(built.lanes.switches.status).toBe('unavailable')
    expect(built.lanes.diagnostics.malformedDiagnosticLines).toBe(1)
    expect(built.lanes.historyReadback.status).toBe('unavailable')
    expect(built.lanes.observedConcurrency).toMatchObject({ configured: 4,
      requested: { peakConcurrentRuns: 4, verdict: 'overlap-confirmed' },
      acceptedActive: { peakConcurrentRuns: 4, verdict: 'overlap-confirmed', terminalBeforeReplyRuns: 0 } })
    expect(built.lanes.rendererMount).toMatchObject({ runs: 4, mountedRuns: 1 })
    expect('terminalToReadableArchiveMs' in built.runs[0]).toBe(false)
  })

  it('is incomplete when one run lost its verdict, and says so without becoming a measured claim', () => {
    const { parts } = report({ runs: [run(), run({ runId: 'run-b' }), run({ runId: 'run-c' }),
      run({ runId: 'run-d', diskVerified: false, evaluation: { passed: false, checks: [] } })] })
    const incomplete = buildConcurrencyReport(parts)
    // An honest incomplete report is still a valid report; it must not be rewritten into "measured".
    expect(incomplete.status).toBe('incomplete')
    expect(incomplete.lanes.archive.allRunsPassed).toBe(false)
    expect(evaluateStatus({ scenario: selectScenario('stream'), concurrency: 4, runs: parts.runs, failures: [],
      switches: parts.switches })).toBe('incomplete')
    expect(validateConcurrencyReport(incomplete)).toBe(true)
  })

  it('counts a dropped run as a failure instead of shrinking the workload', () => {
    const { parts } = report()
    const dropped = buildConcurrencyReport({ ...parts, runs: parts.runs.slice(0, 3), failures: [{ index: 3, error: 'start failed' }] })
    expect(dropped.status).toBe('incomplete')
    expect(validateConcurrencyReport(dropped)).toBe(true)
  })

  it('rejects a report whose status or lanes contradict the evidence', () => {
    const { report: built } = report()
    const lying = { ...built, status: 'incomplete' }
    expect(() => validateConcurrencyReport(lying)).toThrow(/status must follow the completion/)
    const measuredCommit = { ...built, lanes: { ...built.lanes, rendererCommit: { status: 'measured', p50: 4 } } }
    expect(() => validateConcurrencyReport(measuredCommit)).toThrow(/no trusted commit signal/)
    const silentDrop = { ...built, runs: built.runs.slice(0, 3) }
    expect(() => validateConcurrencyReport(silentDrop)).toThrow(/never silently dropped/)
    const fakeCpu = { ...built, lanes: { ...built.lanes, providerProcess: { status: 'unavailable', reason: 'x', cpu: 3 } } }
    expect(() => validateConcurrencyReport(fakeCpu)).toThrow(/mixes a measured value/)
    const noReason = { ...built, lanes: { ...built.lanes, remoteReaders: { status: 'unavailable' } } }
    expect(() => validateConcurrencyReport(noReason)).toThrow(/unavailable without a reason/)
    const failedCheck = { ...built, runs: [built.runs[0], built.runs[1], built.runs[2],
      { ...built.runs[3], evaluation: { passed: true, checks: [] } }] }
    expect(() => validateConcurrencyReport(failedCheck)).toThrow(/missing the promptArchived evidence check/)
  })

  it('cannot be measured when the owned process cleanup was not confirmed', () => {
    const { parts } = report({ cleanup: { stopped: true, leftoverOwnedProcesses: [], cleanupConfirmed: false } })
    const unconfirmed = buildConcurrencyReport(parts)
    expect(unconfirmed.status).toBe('incomplete')
    expect(unconfirmed.processCleanup.cleanupConfirmed).toBe(false)
    expect(validateConcurrencyReport(unconfirmed)).toBe(true)
  })

  it('refuses a UI switch scenario that silently fell back to a non-native path', () => {
    const scenario = selectScenario('history-switch')
    const summary = summarizeSwitches(scenario, [
      { sessionId: 'a', mode: 'native-click', overview: 'visible', switchMs: 40 },
      { sessionId: 'b', mode: 'blocked-pointer-not-ready', overview: 'not-attempted-unproven-history-click', switchMs: 40 }
    ])
    expect(summary).toMatchObject({ status: 'incomplete', nativeClick: 1, overviewVisible: 1 })
    expect(summary.blocked).toHaveLength(1)
    expect(summary.reason).toMatch(/did not run as requested/)
  })

})

describe('diagnostics retention and run association', () => {
  it('retains the temp tree unless a measured run has confirmed cleanup', () => {
    expect(decideRetention({ outcome: 'measured', cleanupConfirmed: true, leftoverProcesses: 0 }))
      .toEqual({ retain: false, reason: 'measured run with confirmed cleanup' })
    for (const input of [
      { outcome: 'incomplete', cleanupConfirmed: true, leftoverProcesses: 0 },
      { outcome: 'failure', cleanupConfirmed: true, leftoverProcesses: 0 },
      { outcome: 'measured', cleanupConfirmed: false, leftoverProcesses: 0 },
      { outcome: 'measured', cleanupConfirmed: true, leftoverProcesses: 2 },
      { outcome: 'measured', cleanupConfirmed: true, leftoverProcesses: Number.NaN }
    ]) expect(decideRetention(input).retain).toBe(true)
  })

  it('binds every outcome to its own dispatch slot instead of a page-reported workspace', () => {
    const runs = [{ cwd: '/tmp/run-0' }, { cwd: '/tmp/run-1' }]
    expect(associateOutcomes(runs, [{ ok: true, run: { runId: 'b' } }, { ok: false, error: 'start failed' }]))
      .toEqual([{ ok: true, run: { runId: 'b' }, index: 0, cwd: '/tmp/run-0' },
        { ok: false, error: 'start failed', index: 1, cwd: '/tmp/run-1' }])
    expect(() => associateOutcomes(runs, [{ ok: true, run: {} }])).toThrow(/every dispatch slot/)
  })
})

describe('pinned project order seeding', () => {
  it('writes the real projects.json record shape in a fixed pinnedAt order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pin-'))
    const cwds = ['/tmp/run-0/workspace', '/tmp/run-1/workspace']
    try {
      seedProjectPinning(dir, cwds)
      const records = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8'))
      expect(records.map((record: { cwd: string }) => record.cwd)).toEqual(cwds)
      expect(records[0].pinnedAt).toBeGreaterThan(records[1].pinnedAt)
      expect(Object.keys(records[0])).toEqual(['cwd', 'lastOpenedAt', 'pinnedAt'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
