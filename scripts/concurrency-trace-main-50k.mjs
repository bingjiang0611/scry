#!/usr/bin/env node
// Thin launcher for the fixed 50k main-only Electron trial (measurement only).
//
// The CLI consumes an artifact that was built earlier and never rebuilds it: build/verify live in
// scripts/fixtures/concurrency-trace-main-artifact.mjs. A frozen baseline stays executable after later source
// edits: the run reports the manifest's build-time identity next to the current one and discloses drift,
// instead of refusing to run or borrowing the current tree's identity for old bytes.
//
// One cell = one fixed sample at k=50000, no repeats and no --items. Repeating is the owner's outer loop, so
// each repeat is a fresh process with its own identity, its own stop and its own report.
//
//   node scripts/concurrency-trace-main-50k.mjs --artifact <dir> --work <fresh dir> [--negative-control corrupt-body]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycleVerdict, ownedChild } from './fixtures/concurrency-trace-live-lifecycle.mjs'
import {
  FIXED_ITEMS, LAUNCHER_SOURCES, PROJECT_ROOT, selectedIdentity, verifyArtifact
} from './fixtures/concurrency-trace-main-artifact.mjs'
import { readReport } from './fixtures/concurrency-trace-main-cell-report.mjs'
import { createOutputCapture, watchChildClose } from './session-concurrency-electron.mjs'

const launcherUrl = fileURLToPath(import.meta.url)
const CONFIG_ENV = 'SCRY_CONCURRENCY_TRACE_MAIN_50K_CONFIG'
const NOTIFICATION_TYPE = 'concurrency-trace-main-50k'
// Work deadline for one cell, reused from the R5 bench: never a retry, never extended after a miss.
const WORK_DEADLINE_MS = 120_000
const CAPTURE_LIMIT_CHARS = 1024 * 1024

// Every entry this launcher creates under --work. The owner may redirect its own driver output (driver.log),
// so that name is not part of this list.
const OWNED_ENTRIES = ['report.json', 'result.json', 'electron.log', 'home', 'userData', 'sessionData', 'tmp', 'logs']

const describe = (error) => (error instanceof Error ? error.message : String(error))

const isText = (value) => typeof value === 'string' && value.length > 0

function prepareWork(work) {
  if (!work) throw new Error('the launcher needs a --work directory')
  const workDir = resolve(work)
  const reused = OWNED_ENTRIES.filter((entry) => existsSync(join(workDir, entry)))
  if (reused.length > 0) {
    throw new Error(`--work is not fresh, it already holds this lane's output: ${reused.join(', ')}; use a new directory instead of reusing an old result`)
  }
  const paths = {
    work: workDir,
    home: join(workDir, 'home'),
    userData: join(workDir, 'userData'),
    sessionData: join(workDir, 'sessionData'),
    appTemp: join(workDir, 'tmp'),
    logs: join(workDir, 'logs'),
    result: join(workDir, 'result.json'),
    report: join(workDir, 'report.json'),
    log: join(workDir, 'electron.log')
  }
  for (const directory of [paths.work, paths.home, paths.userData, paths.sessionData, paths.appTemp, paths.logs]) {
    mkdirSync(directory, { recursive: true })
  }
  return paths
}

/** Pure identity comparison: bundle, manifest and launcher-helper bytes must be the same before and after. */
export function identityIssues(before, after) {
  const issues = []
  if (before.bundleSha256 !== after.bundleSha256) issues.push('the artifact bundle changed during the run')
  if (before.manifestSha256 !== after.manifestSha256) issues.push('the artifact manifest changed during the run')
  for (const [file, hash] of Object.entries(before.launcherFiles)) {
    if (after.launcherFiles[file] !== hash) issues.push(`the launcher helper ${file} changed during the run`)
  }
  return issues
}

function notificationProblem(message, expectedResultPath) {
  if (!message || typeof message !== 'object') return `a ${typeof message} message`
  if (message.type !== NOTIFICATION_TYPE) return `type ${JSON.stringify(message.type)}`
  if (message.schema !== 1) return `schema ${JSON.stringify(message.schema)}`
  if (!['measured', 'failed', 'error'].includes(message.status)) return `status ${JSON.stringify(message.status)}`
  if (message.resultPath !== undefined && message.resultPath !== expectedResultPath) return `resultPath ${JSON.stringify(message.resultPath)}`
  if (message.status === 'error') return isText(message.error) ? null : 'an error notification without its error text'
  return message.resultPath === expectedResultPath ? null : 'a completion notification without its result path'
}

function startChild(state, artifact, paths) {
  const outcome = { settled: null, waiters: [], settle(value) { if (this.settled) return; this.settled = value; for (const waiter of this.waiters) waiter(value); this.waiters = [] } }
  state.outcome = outcome
  const config = JSON.stringify({
    schema: 1,
    k: FIXED_ITEMS,
    negativeControl: state.negativeControl,
    paths: { root: paths.work, home: paths.home, userData: paths.userData, sessionData: paths.sessionData, appTemp: paths.appTemp, logs: paths.logs, resultPath: paths.result }
  })
  const child = spawn(state.electron, [artifact.bundlePath, `--user-data-dir=${paths.userData}`, '--disable-gpu', '--disable-background-timer-throttling', '--no-first-run'], {
    cwd: paths.work,
    // Allowlist only: PATH/HOME/TMPDIR plus this trial's single config value. No inherited credentials and no
    // NODE_OPTIONS/NODE_ENV injection reach the measured process.
    env: { PATH: process.env.PATH ?? '', HOME: paths.home, TMPDIR: paths.appTemp, [CONFIG_ENV]: config },
    // The extra 'ipc' entry carries the trial's single fixed notification.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  state.child = child
  // Registered before any await, so a child that dies during startup is still owned and stopped once.
  state.owned = ownedChild({ name: 'main-50k', child, childClose: watchChildClose(child) })
  child.stdout.on('data', state.capture.stdout)
  child.stderr.on('data', state.capture.stderr)
  child.on('message', (message) => {
    const problem = notificationProblem(message, paths.result)
    outcome.settle(problem === null ? { kind: 'notification', message } : { kind: 'notification-invalid', error: problem })
  })
  child.once('error', (error) => outcome.settle({ kind: 'spawn-error', error: describe(error) }))
  // 'exit' rather than 'close': a natural early exit must not wait for the stdio drain.
  child.once('exit', (code, signal) => outcome.settle({ kind: 'exit', code, signal }))
  state.deadline = setTimeout(() => outcome.settle({ kind: 'timeout', afterMs: WORK_DEADLINE_MS }), WORK_DEADLINE_MS)
  state.deadline.unref?.()
}

const waitOutcome = (outcome) => (outcome.settled ? Promise.resolve(outcome.settled) : new Promise((done) => outcome.waiters.push(done)))

const launcherIdentity = () => selectedIdentity(PROJECT_ROOT, LAUNCHER_SOURCES).files

/** One cell: verify the artifact, run one sample, stop the tree once, report everything observed. */
export async function runCell({ artifactDir, work, negativeControl = null, electron } = {}) {
  if (negativeControl !== null && negativeControl !== 'corrupt-body') throw new Error(`unknown negative control ${JSON.stringify(negativeControl)}`)
  const artifact = verifyArtifact({ artifactDir })
  const paths = prepareWork(work)
  const before = { bundleSha256: artifact.bundle.sha256, manifestSha256: artifact.manifestSha256, launcherFiles: launcherIdentity() }
  const state = {
    electron: electron ?? (await import('node:module')).createRequire(import.meta.url)('electron'),
    negativeControl,
    capture: createOutputCapture({ limitChars: CAPTURE_LIMIT_CHARS, onLine: () => {} }),
    child: null,
    owned: null,
    deadline: null,
    outcome: null
  }
  if (!isText(state.electron) || !existsSync(state.electron)) throw new Error('the electron binary path is unavailable')
  startChild(state, artifact, paths)
  if (!state.owned) throw new Error('the Electron child handle was never created; nothing can be owned or stopped')
  const outcome = await waitOutcome(state.outcome)
  if (state.deadline) clearTimeout(state.deadline)
  // Readiness is the trial's own fixed notification, not a timer: an exit, a timeout or any other message
  // never became ready, and that failure is recorded on the handle before the single owner stop.
  await state.owned.ready(async () => {
    if (outcome.kind !== 'notification') throw new Error(`the trial never delivered its fixed notification (${outcome.kind})`)
    return { kind: outcome.kind }
  }).catch(() => {})
  const record = await state.owned.shutdown(`launcher:${outcome.kind}`)
  const verdict = lifecycleVerdict([record])
  const captured = state.capture.finish()
  writeFileSync(paths.log, captured)
  let report = null
  let reportProblem = null
  try {
    report = readReport(paths.result)
  } catch (error) {
    reportProblem = `no usable trial report: ${describe(error)}`
  }
  // Re-verified after the run so no rebuilt bundle or edited manifest is described by the measured bytes.
  let after = null
  let afterProblem = null
  try {
    const rechecked = verifyArtifact({ artifactDir })
    after = { bundleSha256: rechecked.bundle.sha256, manifestSha256: rechecked.manifestSha256, launcherFiles: launcherIdentity() }
    artifact.sourceDrift = rechecked.sourceDrift
    artifact.driftReason = rechecked.driftReason
  } catch (error) {
    afterProblem = `post-run artifact verification failed: ${describe(error)}`
  }
  const issues = [...verdict.issues]
  if (afterProblem) issues.push(afterProblem)
  if (after) issues.push(...identityIssues(before, after))
  if (reportProblem) issues.push(reportProblem)
  if (outcome.kind === 'timeout') issues.push(`the trial did not notify within ${outcome.afterMs} ms`)
  if (outcome.kind === 'notification-invalid') issues.push(`invalid notification: ${outcome.error}`)
  if (outcome.kind === 'spawn-error') issues.push(`spawn failed: ${outcome.error}`)
  if (outcome.kind === 'exit') issues.push(`the trial exited before the owner stopped it (code ${outcome.code}, signal ${outcome.signal})`)
  if (report && outcome.kind === 'notification' && outcome.message.status !== report.status) {
    issues.push(`the notification said ${outcome.message.status} while the report says ${report.status}`)
  }
  if (report && negativeControl === null && report.status !== 'measured') issues.push(`the trial reported ${report.status}: ${report.failure?.error ?? 'no failure text'}`)
  if (report && negativeControl !== null) {
    if (report.controlRequested !== negativeControl) issues.push(`the report does not state that ${negativeControl} was requested`)
    if (report.controlApplied?.rejected !== true) issues.push(`negative control ${negativeControl} was never applied, so this run proves nothing`)
    if (report.status !== 'failed') issues.push(`negative control ${negativeControl} did not report a failure`)
  }
  const payload = {
    schema: 1,
    lane: 'concurrency-trace-main-50k',
    status: issues.length === 0 && report?.status === 'measured' ? 'measured' : 'failed',
    cell: { k: FIXED_ITEMS, repeats: 1, scope: 'single-run main projection/revision; no client, TLS, Provider, renderer or App claim' },
    negativeControl,
    // Time this launcher wrote its report, not when the measured work started: the only start evidence is the
    // trial's own phase and overall clocks, which this field never feeds.
    reportedAt: new Date().toISOString(),
    paths,
    artifact: {
      bundle: artifact.bundle,
      manifestSha256: artifact.manifestSha256,
      builtAtEpochMs: artifact.manifest.builtAtEpochMs,
      buildSource: artifact.buildSource,
      buildLauncherSource: artifact.buildLauncherSource,
      currentSource: artifact.currentSource,
      sourceDrift: artifact.sourceDrift,
      driftReason: artifact.driftReason,
      note: 'build-time identity comes from the artifact manifest; the current-source identity is reported separately and never substituted for it'
    },
    identity: { before, after, issues: identityIssues(before, after) },
    outcome,
    report,
    cleanup: { verdict, owned: record.owned, close: record.close, inspection: record.inspection, tracked: record.owned?.tracked ?? 0 },
    capture: { chars: captured.length, bytes: statSync(paths.log).size, path: paths.log },
    issues
  }
  writeFileSync(paths.report, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

/**
 * True only when this file was started as the CLI. `import.meta.url` is already canonical, while argv[1] can be
 * a symlink or an aliased prefix (`/tmp` -> `/private/tmp`), so the two are compared as real file identities
 * rather than as strings. A library import has no argv[1], or argv[1] is `-` (stdin) or another program, and
 * `existsSync` already covers those shapes. A realpath failure on a file that does exist is not swallowed: an
 * entry point that cannot be identified must surface its error instead of silently importing and exiting 0.
 */
function launchedAsCli() {
  const invoked = process.argv[1]
  if (!invoked || !existsSync(invoked)) return false
  return realpathSync(invoked) === realpathSync(launcherUrl)
}

function parseArgs(argv) {
  const options = { artifactDir: null, work: null, negativeControl: null }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--artifact') options.artifactDir = value
    else if (flag === '--work') options.work = value
    else if (flag === '--negative-control') {
      if (value !== 'corrupt-body') throw new Error('--negative-control accepts only corrupt-body')
      options.negativeControl = value
    } else throw new Error(`unknown flag ${JSON.stringify(flag)}; usage: --artifact <dir> --work <fresh dir>`)
  }
  if (!options.artifactDir || !options.work) throw new Error('usage: --artifact <dir> --work <fresh dir>')
  return options
}

if (launchedAsCli()) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await runCell(options)
    // Only a measured sample with a clean cleanup exits 0. The corrupt-body control is designed to fail, so it
    // exits 1 even with a clean cleanup; anything with issues also exits 1.
    process.exitCode = result.status === 'measured' && options.negativeControl === null ? 0 : 1
    console.log(`SCRY_CONCURRENCY_TRACE_MAIN_50K=${JSON.stringify({ status: result.status, issues: result.issues.length, report: result.paths.report })}`)
  } catch (error) {
    console.error(`concurrency-trace-main-50k: ${describe(error)}`)
    process.exitCode = 1
  }
}
