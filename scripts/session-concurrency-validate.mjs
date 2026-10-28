import assert from 'node:assert/strict'
import { RENDERER_COMMIT_UNAVAILABLE, finite } from './session-concurrency-aggregate.mjs'
import { CONCURRENCY_LEVELS, evaluateStatus, parseTaskCount, selectScenario } from './session-concurrency-contract.mjs'

// Negative-control validator for the P0 concurrency report, kept apart from the builder so a report is never
// validated by the code that produced it. It refuses numbers on unavailable lanes, unproven commit/Provider
// CPU claims, CPU lanes that hide their coverage, and a status that does not follow the builder's predicate.
export function validateConcurrencyReport(report) {
  assert.equal(report.measurementVersion, 2)
  assert.equal(report.slice, 'p0-concurrency-attribution')
  assert.ok(['measured', 'incomplete'].includes(report.status), 'status must be measured or incomplete')
  assert.ok(CONCURRENCY_LEVELS.includes(report.workload.concurrency), 'concurrency must be a declared level')
  assert.match(report.identity.sourceSha, /^[a-f0-9]{40}$/, 'identity.sourceSha must be the measured HEAD')
  for (const field of ['artifactSha256', 'harnessSha256', 'fixtureSha256']) {
    assert.match(report.identity[field], /^[a-f0-9]{64}$/, `identity.${field} must be a content hash`)
  }
  for (const field of ['platform', 'arch', 'osRelease', 'cpuModel', 'cpuCount', 'totalMemoryBytes', 'node', 'electron', 'appVersion']) {
    assert.ok(report.identity[field] !== undefined && report.identity[field] !== null, `identity.${field} is required`)
  }
  // Fixed total work is validated on its own: the batch is concurrency tasks or the full 16, and every task is
  // either reported or listed as a failure/not-started, so a shorter batch can never pass for the full one.
  assert.equal(report.workload.tasks, parseTaskCount(String(report.workload.tasks), report.workload.concurrency),
    'tasks must equal concurrency or 16')
  assert.equal(report.runs.length + report.failures.length, report.workload.tasks,
    'a task is either reported or listed as a failure, never silently dropped')
  const scenario = selectScenario(report.scenario)
  assert.equal(report.status, evaluateStatus({ scenario, concurrency: report.workload.concurrency,
    tasks: report.workload.tasks, runs: report.runs, failures: report.failures, switches: report.lanes.switches,
    cleanupConfirmed: report.processCleanup.cleanupConfirmed }),
  'status must follow the completion, archive, switch and cleanup predicate')
  const pool = report.lanes.taskPool
  assert.ok(['measured', 'incomplete', 'unavailable'].includes(pool.status), 'taskPool status must be honest')
  if (pool.status !== 'unavailable') {
    assert.equal(pool.tasks, report.workload.tasks, 'the pool lane must account for the full batch')
    assert.equal(pool.limit, report.workload.concurrency, 'the pool limit is the configured in-flight limit')
    assert.match(pool.policy, /not a product scheduler/, 'the pool must state it is a fixture, not queueing capability')
    assert.match(pool.note, /not accepted concurrency/, 'queueWait must not be read as accepted concurrency')
    if (pool.status === 'measured') {
      assert.equal(pool.completed, report.workload.tasks, 'a measured batch completes every task')
      assert.deepEqual(pool.notStarted, [], 'a measured batch leaves no task unstarted')
    } else {
      // Fewer completions than tasks is exactly what must not be reported as measured.
      assert.equal(report.status, 'incomplete', 'an incomplete batch cannot yield a measured report')
    }
  }
  for (const run of report.runs) {
    if (run.queueWaitMs === null) continue
    assert.ok(finite(run.queueWaitMs) && run.queueWaitMs >= 0, 'a queue wait is a measured non-negative duration or null')
  }
  for (const run of report.runs) {
    for (const metric of ['startReceiptMs', 'startToTerminalMs']) {
      assert.ok(finite(run[metric]), `run.${metric} must be a measured non-negative number`)
    }
    // The removed readback timing must not reappear as a number: it measured a cancellation race.
    assert.equal('terminalToReadableArchiveMs' in run, false, 'terminal->readable timing is not measured')
    if (!run.diskVerified) { assert.equal(run.evaluation?.passed, false, 'an unverified run cannot pass its evidence checks'); continue }
    assert.equal(run.evaluation?.passed, true, 'a disk-verified run must pass its archive evidence checks')
    for (const name of ['promptArchived', 'turnDone', 'toolResultPresent', 'toolResultTextChars']) {
      const entry = run.evaluation?.checks?.find(candidate => candidate.name === name)
      assert.ok(entry, `run.${run.runId} is missing the ${name} evidence check`)
      assert.equal(entry.passed, true, `run.${run.runId} failed ${name}: observed ${JSON.stringify(entry.observed)}`)
    }
  }
  if (report.lanes.archive.status === 'measured') {
    assert.ok(report.lanes.archive.diskVerifiedRuns > 0, 'a measured archive lane needs verified runs')
  }
  // Commit latency is unobservable in this slice; a measured commit claim would be unsupported.
  assert.equal(report.lanes.rendererCommit.status, 'unavailable', 'no trusted commit signal exists in this slice')
  assert.equal(report.lanes.rendererCommit.reason, RENDERER_COMMIT_UNAVAILABLE)
  assert.equal(report.lanes.providerProcess.status, 'unavailable', 'in-process fixture cannot claim Provider process CPU')
  assert.equal(report.lanes.gc.forced, false, 'no forced GC may be claimed')
  assert.equal(report.lanes.gc.postCollectionResidency.status, 'unavailable', 'post-GC residency is not observed')
  assert.match(report.lanes.gc.note, /not evidence that a natural collection ran/, 'forced:false is not a natural GC')
  for (const name of ['processCpu', 'quietProcessCpu']) {
    const lane = report.lanes[name]
    assert.ok(['measured', 'partial', 'unavailable'].includes(lane.status), `${name} status must be honest`)
    if (lane.status === 'unavailable') continue
    assert.match(lane.attribution, /never added to mainProcessCpu/, `${name} is not summed into mainProcessCpu`)
    assert.ok(lane.coverage && finite(lane.coverage.matchedProcesses), `${name} names its coverage`)
    if (lane.status === 'partial') assert.match(lane.note, /listed, not zeroed/, `${name} partial note must be explicit`)
  }
  if (report.workload.quietWindowMs === 0) {
    assert.equal(report.lanes.quietProcessCpu.status, 'unavailable', 'a scenario without a quiet window cannot report quiet CPU')
  }
  if (report.lanes.cpu.status === 'measured') {
    assert.equal(report.lanes.cpu.cpuPercent.status, 'unavailable', 'journal window CPU percent is not claimable')
    assert.match(report.lanes.cpu.cpuPercent.reason, /since the previous getAppMetrics\(\) call/,
      'the legacy percent must name why it is unavailable')
  }
  assert.equal(report.honesty.paint, 'offscreen-hidden-window')
  assert.equal(report.lanes.remoteReaders.status, 'unavailable', 'remote readers are not implemented in this slice')
  // Readback removal, sparse sampling and the CPU lanes each carry their own honesty contract.
  assert.equal(report.lanes.historyReadback.status, 'unavailable', 'per-run readback must not be claimed')
  assert.match(report.lanes.historyReadback.reason, /agent:loadSession aborts/, 'readback removal must name the production cause')
  assert.equal(report.lanes.resourceWindowSampling.intervalMs, 5000, 'sparse sampling must state the production interval')
  assert.match(report.lanes.resourceWindowSampling.source, /app-lifecycle\.ts/, 'sampling source must point at production config')
  const main = report.lanes.mainProcessCpu
  if (main.status === 'measured') {
    assert.ok(finite(main.cpuMs) && main.window.wallMs > 0, 'a measured main CPU lane needs a delta over a positive window')
    assert.match(main.attribution, /in-process offline smoke Provider; not an isolated Provider CPU/, 'main CPU must name what it includes')
    assert.equal('providerProcessCpu' in main, false, 'main CPU must not be relabelled as Provider CPU')
  } else assert.equal(main.status, 'unavailable', 'main CPU is measured or explicitly unavailable')
  const task = report.lanes.rendererTask
  if (task.status === 'measured') assert.match(task.attribution, /not React commit latency/, 'task time must not be read as commit')
  else assert.equal(task.status, 'unavailable', 'renderer task time is measured or explicitly unavailable')
  // Two overlap numbers with one contract: requested may include queueing; accepted is a lower bound.
  const observed = report.lanes.observedConcurrency
  if (observed.status === 'measured') {
    assert.equal(observed.configured, report.workload.concurrency, 'observed concurrency must name the configured level')
    for (const name of ['requested', 'acceptedActive']) {
      const level = observed[name]
      assert.ok(finite(level.peakConcurrentRuns) && level.peakConcurrentRuns >= 1, `${name} needs a peak overlap`)
      assert.equal(level.verdict, level.peakConcurrentRuns >= observed.configured ? 'overlap-confirmed' : 'below-configured',
        `${name} verdict must follow its own measured peak, not the configured level`)
    }
    assert.ok(finite(observed.acceptedActive.terminalBeforeReplyRuns), 'accepted overlap must count terminals that preceded the reply')
    assert.ok(observed.acceptedActive.peakConcurrentRuns <= observed.requested.peakConcurrentRuns,
      'accepted overlap cannot exceed the requested overlap that contains it')
    assert.match(observed.note, /neither number proves CPU-level parallelism/, 'overlap must not be read as CPU parallelism')
  } else assert.equal(observed.status, 'unavailable', 'observed concurrency is measured or explicitly unavailable')
  // Quiet is a separate window: when it is measured it must start exactly where the active window ended,
  // so the quiet wait can never be folded into the active CPU numbers.
  const quietMain = report.lanes.quietMainProcessCpu
  const quietTask = report.lanes.quietRendererTask
  if (report.workload.quietWindowMs > 0) {
    if (quietMain.status === 'measured' && main.status === 'measured') {
      assert.equal(quietMain.window.startedAtEpochMs, main.window.endedAtEpochMs,
        'the quiet window must begin at the active window end, not overlap it')
      assert.ok(quietMain.window.wallMs >= report.workload.quietWindowMs,
        'a measured quiet window must cover the fixed quiet workload')
    }
    assert.ok(['measured', 'unavailable'].includes(quietMain.status), 'quiet main CPU must be measured or unavailable')
    assert.ok(['measured', 'unavailable'].includes(quietTask.status), 'quiet renderer task must be measured or unavailable')
  } else {
    assert.equal(quietMain.status, 'unavailable', 'a scenario without a quiet window must not report quiet CPU')
    assert.equal(quietTask.status, 'unavailable', 'a scenario without a quiet window must not report quiet task time')
    assert.match(quietMain.reason, /no quiet window/, 'the missing quiet window must be named')
  }
  assert.ok(Array.isArray(report.lanes.switchPreparation), 'switch preparation must be recorded as observed states')
  assert.ok(Array.isArray(report.lanes.switchStartedRows), 'the started-session row wait must be recorded')
  if (report.workload.switches > 0) {
    // Pre-dispatch preparation stays limited to the switch targets; admission covers the whole batch.
    assert.equal(report.lanes.switchPreparation.length, report.workload.switches,
      'only the switch targets are prepared before dispatch')
    // Admission is a whole-batch precondition: a click before every task's started row exists changes the
    // authorized cwd under a pending start, and filtering this list down to the ready rows would hide it.
    assert.equal(report.lanes.switchStartedRows.length, report.workload.tasks,
      'every task must be admitted before any history click')
    if (report.status === 'measured') {
      // Both admission facts, not just a rendered row: a live row is recorded before the run is registered.
      assert.ok(report.lanes.switchStartedRows.every(entry => entry.status === 'measured'
        && entry.startedRow === 'observed' && entry.startReply === 'observed'),
      'a measured UI run must observe every task start reply and its new session row before clicking')
    }
    for (const entry of report.lanes.switchStartedRows) {
      assert.ok(['observed', 'not-observed'].includes(entry.startReply),
        'every admission row must state whether a start reply was observed')
    }
  } else {
    assert.equal(report.lanes.switchStartedRows.length, 0, 'a scenario without switches admits no task')
  }
  if (report.lanes.rendererMount.status === 'measured') {
    assert.match(report.lanes.rendererMount.note, /focused run only/, 'mount evidence must state the mirroring limit')
  }
  // Readback removal, sparse sampling and the CPU lanes each carry their own honesty contract.
  assert.ok(report.lanes.switches && typeof report.lanes.switches.status === 'string', 'switch coverage must be reported')
  const switches = report.lanes.switches
  if (switches.status === 'measured') {
    assert.equal(switches.nativeClick, report.workload.switches, 'measured switches need every history click proven')
    assert.equal(switches.overviewVisible, report.workload.switches, 'measured switches need every Overview visibly open')
  }
  if (finite(switches.nativeClick) && finite(switches.overviewVisible) && switches.status !== 'measured') {
    assert.ok(switches.nativeClick < report.workload.switches || switches.overviewVisible < report.workload.switches,
      'an incomplete switch lane must say which step failed to reach the expected count')
  }
  assert.equal(report.lanes.diagnostics.malformedDiagnosticLines >= 0, true, 'malformed diagnostics must be counted')
  for (const [name, lane] of Object.entries(report.lanes)) {
    if (lane && typeof lane === 'object' && lane.status === 'unavailable') {
      assert.ok(typeof lane.reason === 'string' && lane.reason.length > 0, `lane ${name} is unavailable without a reason`)
      for (const [key, value] of Object.entries(lane)) {
        assert.ok(!finite(value), `lane ${name} mixes a measured value (${key}) into an unavailable result`)
      }
    }
    if (name === 'rendererObservation' && lane.status === 'measured') {
      assert.equal('commitMs' in lane, false, 'observation counters must not report a commit delay')
      assert.equal('timerFallbackSuspected' in lane, false, 'no source of a delay may be guessed')
    }
  }
  assert.ok(report.lanes.persistence && Object.hasOwn(report.lanes.persistence, 'issues'), 'journal parse issues must be reported')
  assert.equal(report.lanes.sqlite.status, 'ready', 'SQLite must be readable, not silently degraded')
  return true
}
