import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'
import { createBoundarySampler, createOutputCapture, freePort, openRendererSession, openSnapshotChannel,
  readRendererMount, readSettlement, watchChildClose, writeBootstrap } from './session-concurrency-electron.mjs'
import { performHistorySwitches, prepareHistoryTargets, waitForAdmittedTasks } from './session-concurrency-ui.mjs'
import { driveConcurrencyRun, installConcurrencyProbe } from './session-concurrency-page.mjs'
import { associateOutcomes, decideRetention } from './session-concurrency-aggregate.mjs'
import { classifyWindowPhase, pairBoundaries, summarizeBoundaries, summarizeObservedConcurrency, summarizePhases,
  summarizeProcessCpu, summarizeRendererMount, summarizeRendererTask, summarizeResources } from './session-concurrency-lanes.mjs'
import { builtArtifactHash, harnessSha256, readJournalLane, seedProjectPinning, seedWorkspace, verifyArchivedRuns }
  from './session-concurrency-evidence.mjs'
import { batchValue, runTaskPool, summarizeTaskPool, trackBatch } from './session-concurrency-pool.mjs'
import { parseConcurrency, parseTaskCount, planAdmissionTargets, planHistorySwitches, selectScenario,
  summarizeSwitches }
  from './session-concurrency-contract.mjs'
import { buildConcurrencyReport } from './session-concurrency-report.mjs'
import { validateConcurrencyReport } from './session-concurrency-validate.mjs'

// P0 concurrency attribution: real hidden Electron process tree, temp userData and one workspace per task,
// offline smoke adapter. Fixed total work (tasks) with a bounded in-flight limit (concurrency), no warmup, no
// retry, commit latency unavailable; temp state is deleted only for a measured, cleaned run.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scenario = selectScenario(process.env.SCRY_CONCURRENCY_SCENARIO ?? 'stream')
const concurrency = parseConcurrency(process.env.SCRY_CONCURRENCY_RUNS)
const taskCount = parseTaskCount(process.env.SCRY_CONCURRENCY_TASKS, concurrency)
const RUN_DEADLINE_MS = 60_000
const temp = mkdtempSync(join(tmpdir(), 'scry-concurrency-'))
const logPath = join(temp, 'app.log')
const hash = value => createHash('sha256').update(value).digest('hex')
const harnessIdentity = harnessSha256(root)
let ownedChild = null
let cleanupAttempted = false
// Created at spawn so an early 'close' is never missed; its deadline starts only inside wait(), after the stop.
let childClose = null
// Set once the batch is dispatched: the failure path reports its outcome but never waits for it.
let poolBatch = null
let cleanupConfirmed = false
let leftoverProcesses = Number.NaN
let outcome = 'failure'
let session
let snapshots
let logLines = 0
let malformedDiagnosticLines = 0
const malformedSamples = []
const startupProbe = { phase: 'not-started' }
const traces = []
const resourceWindows = []
const rendererWindows = []

// A split-across-chunks diagnostic is a normal boundary; only a complete unparseable line is malformed.
function handleLine(line) {
  logLines += 1
  const target = line.includes('[scry:resource]') ? resourceWindows
    : line.includes('[scry:renderer-perf]') ? rendererWindows
      : line.includes('[scry:perf]') ? traces : null
  if (!target) return
  try { target.push(JSON.parse(line.slice(line.indexOf('{')))) } catch {
    malformedDiagnosticLines += 1
    if (malformedSamples.length < 5) malformedSamples.push(line.slice(0, 200))
  }
}
const capture = createOutputCapture({ onLine: handleLine })

// A retained log always exists: with no App output a marker file replaces the path; a failed write is reported.
function flushLog() {
  const text = capture.finish()
  const appOutput = text.trim() !== ''
  const body = appOutput ? text
    : `[scry:concurrency] no App output was captured; startup phase: ${startupProbe.phase}\n`
  try {
    writeFileSync(logPath, body)
    return { written: true, appOutput, bytes: Buffer.byteLength(body) }
  } catch (error) { return { written: false, appOutput, error: String(error) } }
}

function diagnostics() {
  // logRetained is attached after the report's status is known, from the same decision the cleanup
  // path uses, so the report can never claim retention the harness does not perform.
  return { logLines, logTruncated: capture.truncated(), malformedDiagnosticLines, malformedSamples, logPath }
}

// stopOwnedApp revalidates identities and escalates TERM -> KILL: one attempt per child, flag first.
function attemptCleanup(child) {
  cleanupAttempted = true
  return stopOwnedApp(child)
}

// stopOwnedApp returns once no registered process is alive, earlier than Node's 'close' (which also needs the
// pipes to end). Waiting on the spawn-time subscription is what keeps the inspects honest; a miss stays unknown.
// A gone tree is zero leftovers; only a state that could not be read is unknown.
const leftoverCount = inspection => (inspection.state === 'observed' ? inspection.processes.length
  : inspection.state === 'exited' ? 0 : Number.NaN)

function settledChildClose() {
  return childClose ? childClose.wait() : Promise.resolve({ state: 'unknown', reason: 'no child was started' })
}

try {
  const artifactSha256 = builtArtifactHash(root)
  const userData = join(temp, 'userData')
  const home = join(temp, 'home')
  mkdirSync(userData, { recursive: true })
  mkdirSync(home, { recursive: true })
  // One fixed batch of tasks: every task gets its own cwd and the same seed, so lowering the in-flight limit
  // changes the queueing, never the amount of work.
  const tasks = []
  const catalog = []
  for (let index = 0; index < taskCount; index++) {
    const workspace = join(temp, `run-${index}`, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const cwd = realpathSync(workspace)
    catalog.push(...seedWorkspace(userData, cwd, index, scenario))
    tasks.push({ index, cwd, historySessionId: `conc-${index}-history`, seededLiveSessionId: `conc-${index}-live` })
  }
  writeFileSync(join(userData, 'app-sessions.json'), JSON.stringify(catalog))
  // Fixed project order only for the UI scenario; the others stay unpinned. Pinned for the whole batch, so
  // the first switch targets are the first wave's tasks.
  if (scenario.switches > 0) seedProjectPinning(userData, tasks.map(task => task.cwd))
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const bootstrap = writeBootstrap({ dir: join(temp, 'app'), root, metadata })
  const port = await freePort()
  const launchEpochMs = Date.now()
  const launchStarted = performance.now()
  ownedChild = spawn(electron, [bootstrap, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
    env: { ...process.env, HOME: home, SCRY_TEST_APP: '1', SCRY_PERF_LOG: '1', ELECTRON_ENABLE_LOGGING: '1',
      SCRY_ELECTRON_SMOKE_PROVIDER: '1', SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi', SCRY_REMOTE_HOST: '0' },
    // The extra 'ipc' entry is the fixture's private snapshot channel: fixed request/reply only.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  childClose = watchChildClose(ownedChild)
  ownedChild.stdout.on('data', capture.stdout)
  ownedChild.stderr.on('data', capture.stderr)
  snapshots = openSnapshotChannel(ownedChild)
  session = await openRendererSession(port, startupProbe)
  const { evaluate, wait } = session
  await wait(`typeof window.scry === 'object' && document.querySelector('textarea') != null`)
  const sidebarSessions = await evaluate(`document.querySelectorAll('button.sb-sess').length`)
  const adapter = await evaluate(`window.scry.detectFast().then(items => items.map(item => ({ id: item.id, name: item.name })))`)
  assert.deepEqual(adapter, [{ id: 'codex', name: 'codex Smoke Fixture' }], 'refusing to measure without the offline fixture adapter')
  const probeStatus = await evaluate(`(${installConcurrencyProbe.toString()})()`)
  assert.equal(probeStatus.installed, true, 'renderer probe must install')
  const startupDriverReadyMs = performance.now() - launchStarted
  const driverReadyEpochMs = Date.now()
  // Boundaries: before dispatch, after the last terminal, and after the quiet wait when set.
  const boundary = createBoundarySampler({ snapshotChannel: snapshots, send: session.send })
  // Before dispatch only the seeded catalog is awaited; the row of the session this run starts is
  // awaited after the sweeps are issued and before the first history click.
  const switchTargets = planHistorySwitches({ runs: tasks, scenario })
  const switchPreparation = scenario.switches === 0 ? []
    : await prepareHistoryTargets({ evaluate, wait, targets: switchTargets })
  const boundaryBefore = await boundary('before-dispatch')

  // One evaluated batch drives the whole task list inside the renderer, so the enqueue instant, every dispatch
  // and every terminal share the page clock. Only the last task is focused explicitly; a production legacy start
  // still auto-focuses itself, so what the renderer mirrored is read back from the report, never assumed.
  // Tracked, not dropped: an unawaited rejection here would break the cleanup that follows a UI failure.
  poolBatch = trackBatch(evaluate(`(${runTaskPool.toString()})(${JSON.stringify({ limit: concurrency,
    tasks: tasks.map(task => ({ cwd: task.cwd, prompt: scenario.prompt, deadlineMs: RUN_DEADLINE_MS,
      focus: task.index === taskCount - 1 })) })}, ${driveConcurrencyRun.toString()})`))
  // Switches are active work: every task must be admitted first, because a click changes the authorized cwd and
  // a pending start would be refused by the real trust gate. A rendered row is not admission, so the real start
  // reply is required too; one bounded wait covers the batch and is counted in active time.
  const switchStartedRows = scenario.switches === 0 ? []
    : await waitForAdmittedTasks({ evaluate, targets: planAdmissionTargets({ runs: tasks, scenario }) })
  const switches = await performHistorySwitches({ session, evaluate, wait, targets: switchTargets,
    preparation: switchPreparation, startedRows: switchStartedRows, expectedStarted: tasks.length })
  await poolBatch.done
  const pool = batchValue(poolBatch.record)
  const outcomes = associateOutcomes(tasks, pool.outcomes)
  // Active closes here: before settlement/mount queries and before the quiet wait.
  const boundaryAfterTerminal = await boundary('after-terminal')
  const quietFromEpochMs = Date.now()
  let boundaryAfterQuiet = null
  if (scenario.quietMs > 0) {
    // Fixed post-settlement idle workload; the journal is read after shutdown.
    await new Promise(resolve => setTimeout(resolve, scenario.quietMs))
    boundaryAfterQuiet = await boundary('after-quiet')
  }
  const quietToEpochMs = Date.now()
  const boundaries = pairBoundaries({ before: boundaryBefore, afterTerminal: boundaryAfterTerminal,
    afterQuiet: boundaryAfterQuiet, quietWindowMs: scenario.quietMs })
  const finished = outcomes.filter(outcome => outcome.ok)
    .map(outcome => ({ ...outcome.run, index: outcome.index, cwd: outcome.cwd, queueWaitMs: outcome.queueWaitMs }))
  const failures = outcomes.filter(outcome => !outcome.ok).map(outcome => ({ index: outcome.index, cwd: outcome.cwd,
    error: outcome.error, ...(outcome.notStarted === true ? { notStarted: true } : {}) }))
  const settleCheck = await readSettlement(evaluate)
  // Settling is confirmed once for all runs by one read-only query, not per run in the page.
  for (const run of finished) run.settled = settleCheck.activeRuns === 0
  const rendererMountRows = await readRendererMount(evaluate, finished.map(run => run.runId))
  const probe = await evaluate(`(() => { const probe = window.__scryConcurrencyProbe; window.__scryConcurrencyRelease(); return probe })()`)

  const cleanup = await attemptCleanup(ownedChild)
  cleanupConfirmed = true
  const close = await settledChildClose()
  const leftover = inspectOwnedApp(ownedChild)
  leftoverProcesses = leftoverCount(leftover)
  if (leftover.state !== 'exited' || close.state !== 'closed') cleanupConfirmed = false
  // Live turns land under trace-archive-turns-v1; seeded history and monolith copies under trace-archives-v2.
  const { archiveFiles } = verifyArchivedRuns({ userData, runs: finished, scenario,
    archiveRoots: ['trace-archive-turns-v1', 'trace-archives-v2'].map(name => join(userData, name)) })
  const { journal, records: journalRecords } = await readJournalLane(userData,
    { enabled: process.env.SCRY_PERF_RECORD !== '0' })
  const phaseBounds = [
    { name: 'startup', since: launchEpochMs, until: driverReadyEpochMs },
    { name: 'active', since: driverReadyEpochMs, until: quietFromEpochMs },
    ...(scenario.quietMs > 0 ? [{ name: 'quiet', since: quietFromEpochMs, until: quietToEpochMs }] : [])
  ]
  const windowsByPhase = { startup: [], active: [], quiet: [], spanning: [], unknown: [] }
  for (const window of resourceWindows) windowsByPhase[classifyWindowPhase(window, phaseBounds)].push(window)
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const workingTreeDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0
  let report
  try {
    report = buildConcurrencyReport({
      scenario, concurrency,
      identity: {
        sourceSha, artifactSha256, harnessSha256: harnessIdentity,
        fixtureSha256: hash(readFileSync(join(root, 'src/main/providers/smoke.ts'), 'utf8')),
        platform: process.platform, arch: process.arch, osRelease: release(),
        cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length, totalMemoryBytes: totalmem(),
        node: process.version, electron: JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version,
        appVersion: metadata.version ?? null, startupDriverReadyMs, probe: probeStatus, workingTreeDirty,
        launchEpochMs, driverReadyEpochMs, quietFromEpochMs, quietToEpochMs
      },
      runs: finished,
      tasks: taskCount,
      taskPool: summarizeTaskPool({ pool, tasks: taskCount, concurrency }),
      failures,
      probe,
      mainCpu: summarizeBoundaries({ ...boundaries.active.main, cpuCount: cpus().length }),
      rendererTask: summarizeRendererTask({ ...boundaries.active.renderer, cpuCount: cpus().length }),
      processCpu: summarizeProcessCpu(boundaries.active.main),
      quietProcessCpu: summarizeProcessCpu(boundaries.quiet?.main),
      quietMainCpu: boundaries.quiet
        ? summarizeBoundaries({ ...boundaries.quiet.main, cpuCount: cpus().length })
        : { status: 'unavailable', reason: 'scenario has no quiet window' },
      quietRendererTask: boundaries.quiet
        ? summarizeRendererTask({ ...boundaries.quiet.renderer, cpuCount: cpus().length })
        : { status: 'unavailable', reason: 'scenario has no quiet window' },
      switchPreparation, switchStartedRows,
      observedConcurrency: summarizeObservedConcurrency({ configured: concurrency,
        intervals: finished.map(run => ({ runId: run.runId,
          requestedStartEpochMs: run.startRequestedAtEpochMs, requestedEndEpochMs: run.terminalAtEpochMs,
          acceptedStartEpochMs: run.startReplyAtEpochMs })) }),
      rendererMount: summarizeRendererMount(rendererMountRows),
      resourceSampling: { intervalMs: 5000,
        source: 'src/main/bootstrap/app-lifecycle.ts startPerformanceResourceMonitor({ intervalMs: 5000 })',
        windows: resourceWindows.length, fullyInsidePhase: windowsByPhase.startup.length
          + windowsByPhase.active.length + windowsByPhase.quiet.length,
        spanning: windowsByPhase.spanning.length, unknown: windowsByPhase.unknown.length,
        note: 'sparse App samples; the boundary snapshot lanes carry the CPU evidence, and spanning windows are not counted for one phase' },
      resources: summarizeResources(windowsByPhase.active, 'active'),
      quietResources: scenario.quietMs > 0 ? summarizeResources(windowsByPhase.quiet, 'quiet')
        : { status: 'unavailable', reason: 'scenario has no quiet window' },
      startupResources: summarizeResources(windowsByPhase.startup, 'startup'),
      spanningResources: summarizeResources(windowsByPhase.spanning, 'spanning'),
      rendererWindows,
      phases: summarizePhases(journalRecords),
      journal, sqlite: settleCheck.sqlite,
      cleanup: { ...cleanup, leftoverOwnedProcesses: leftover, cleanupConfirmed, cleanupAttempted, childClose: close },
      switches: summarizeSwitches(scenario, switches), archiveFiles, sidebarSessions,
      diagnostics: diagnostics()
    })
    validateConcurrencyReport(report)
    assert.equal(builtArtifactHash(root), artifactSha256, 'build artifacts changed during measurement')
    assert.equal(harnessSha256(root), harnessIdentity, 'the measurement harness changed during measurement')
    outcome = report.status
    const retention = decideRetention({ outcome, cleanupConfirmed, leftoverProcesses })
    report.processCleanup = { ...report.processCleanup, retention }
    report.lanes.diagnostics = { ...report.lanes.diagnostics, logRetained: retention.retain, tempPath: temp }
    if (report.status !== 'measured') process.exitCode = 1
    assert.equal(process.exitCode === 1, report.status !== 'measured', 'exit code must match the reported status')
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    if (report) console.error('SCRY_CONCURRENCY_REPORT', JSON.stringify(report, null, 2))
    throw error
  }
} catch (error) {
  outcome = 'failure'
  const batchFailure = poolBatch?.record.settled && !poolBatch.record.ok ? String(poolBatch.record.error).slice(0, 800) : null
  console.error('SCRY_CONCURRENCY_FAILURE', JSON.stringify({ failure: String(error).slice(0, 800), batchFailure,
    startup: startupProbe, app: inspectOwnedApp(ownedChild), logPathPlanned: logPath, tempPath: temp }))
  process.exitCode = 1
  throw error
} finally {
  session?.close()
  snapshots?.close()
  // An earlier attempt is never repeated, whether it succeeded, failed or was cut short.
  if (ownedChild && !cleanupAttempted) {
    try {
      await attemptCleanup(ownedChild)
      const close = await settledChildClose()
      const leftover = inspectOwnedApp(ownedChild)
      // An unknown stop still stays unknown (and is never retried), so retention keeps the log for it.
      leftoverProcesses = leftoverCount(leftover)
      cleanupConfirmed = leftover.state === 'exited' && close.state === 'closed'
      if (close.state !== 'closed') console.error('SCRY_CONCURRENCY_CLOSE_UNKNOWN', close.reason)
    } catch (error) {
      console.error('SCRY_CONCURRENCY_CLEANUP_FAILED', String(error).slice(0, 800))
      leftoverProcesses = Number.NaN
      cleanupConfirmed = false
      process.exitCode = 1
    }
  }
  // Recomputed from the final state, so a cleanup failure or an unknown count cannot be masked by an earlier success.
  const retention = decideRetention({ outcome, cleanupConfirmed, leftoverProcesses })
  if (retention.retain) {
    const log = flushLog()
    console.error(`retained diagnostics (${retention.reason}): ${temp}`)
    if (log.written) {
      console.error(log.appOutput
        ? `app log (${log.bytes} bytes): ${logPath}`
        : `app log (${log.bytes} bytes, no App output: the App did not start): ${logPath}`)
    } else {
      console.error(`app log NOT written (${log.error}); no log file exists at ${logPath}`)
      process.exitCode = 1
    }
  } else rmSync(temp, { recursive: true, force: true })
}
