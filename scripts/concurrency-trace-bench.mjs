#!/usr/bin/env node
// R5: one measured cell — 16 fixture tasks, limit 4 or 16, 0/1/4 in-process readers, 1000 or 10000
// client items — inside a real hidden Electron main process.
//
// The launcher owns everything outside the cell: a private temp tree (home/userData/sessionData/tmp/
// logs/work), the CJS bundle of scripts/fixtures/concurrency-trace-electron.ts, the Electron process
// identity, one bounded work deadline and exactly one identity-checked stop. The cell itself is the
// accepted R4 fixture, so this file adds no scheduling, no fault injection and no second transport.
//
// Electron main only: no BrowserWindow is created, so renderer commits, mirroring, TLS and any real
// Provider stay unavailable and this is not a full App measurement. Milliseconds are L2 only when the
// run comes from .agents/skills/scry-performance-climb/scripts/timing-run.mjs with highLoad=false in
// its footer, and that footer is necessary rather than sufficient: L2 also needs stable samples and a
// matched experiment. This launcher claims no load level and no L2 on its own.
//
//   node scripts/concurrency-trace-bench.mjs [--limit 4|16] [--readers 0|1|4] [--items 1000|10000]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'
import { createOutputCapture, watchChildClose } from './session-concurrency-electron.mjs'
import { SOURCE_FILES, errorMessage, failureSummary, hashFile, hashSources, readIdentity, successSummary }
  from './concurrency-trace-launcher-report.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const LIMITS = [4, 16]
const READERS = [0, 1, 4]
const ITEMS = [1000, 10000]
// Work deadline for the whole cell, never a retry and never the stdio drain deadline.
const WORK_DEADLINE_MS = 120_000
const CONFIG_ENV = 'SCRY_CONCURRENCY_TRACE_TRIAL_CONFIG'
const NOTIFICATION_TYPE = 'concurrency-trace-trial'
const SUMMARY_PREFIX = 'SCRY_CONCURRENCY_TRACE_BENCH='
const FAILURE_PREFIX = 'SCRY_CONCURRENCY_TRACE_BENCH_FAILURE='
const RESULT_BYTES_LIMIT = 32 * 1024 * 1024
const USAGE = [
  'Usage: node scripts/concurrency-trace-bench.mjs [--limit 4|16] [--readers 0|1|4] [--items 1000|10000]',
  '',
  'Runs exactly one 16-task concurrency trace cell inside a hidden Electron main process.',
  '  --limit    live tasks per wave: 4 (default) or 16',
  '  --readers  in-process remote readers: 0, 1 (default) or 4',
  '  --items    client item scale: 1000 (default) or 10000; 50000 stays a host-only scale case',
  '  --help     print this text and exit before any build, temp directory or Electron process',
  '',
  'Exit codes: 0 measured and cleaned, 2 invalid arguments, 1 any other outcome.'
].join('\n')

// Settle-only: the state is read through the record, so a path that stops awaiting it can never leave an
// unhandled rejection behind to interrupt cleanup.
function deferred() {
  const record = { settled: false, value: null }
  let settle = () => {}
  const promise = new Promise((resolve) => { settle = resolve })
  return {
    record,
    promise,
    settle(value) {
      if (record.settled) return
      record.settled = true
      record.value = value
      settle(value)
    }
  }
}

function parseCellArgs(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        limit: { type: 'string' },
        readers: { type: 'string' },
        items: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      },
      strict: true,
      allowPositionals: false
    })
  } catch (error) {
    return { error: errorMessage(error) }
  }
  if (parsed.values.help === true) return { help: true }
  const pick = (name, allowed, fallback) => {
    const raw = parsed.values[name]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!allowed.includes(value)) {
      throw new Error(`--${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(raw)}`)
    }
    return value
  }
  try {
    return { config: { limit: pick('limit', LIMITS, 4), readers: pick('readers', READERS, 1), items: pick('items', ITEMS, 1000) } }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

async function buildEntryBundle(buildDir) {
  const { build } = await import('vite')
  await build({
    // The hidden main runs from a temp directory without node_modules, so dependencies are bundled; the
    // electron module itself must stay external or the bundle would inline its runtime binary path.
    configFile: false, root, envDir: buildDir, logLevel: 'error', ssr: { noExternal: true },
    build: {
      ssr: join(root, 'scripts/fixtures/concurrency-trace-electron.ts'),
      outDir: buildDir, emptyOutDir: false, minify: false, target: 'node20',
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } }
    }
  })
  const bundlePath = join(buildDir, 'main.cjs')
  const bytes = statSync(bundlePath).size
  if (bytes <= 0) throw new Error('the Electron entry bundle is empty')
  return { bundlePath, bytes, sha256: hashFile(bundlePath) }
}

// The single message shape this cell accepts. 'measured'/'incomplete' must name the result file the
// launcher asked for; 'error' may omit it but has to carry the original error text.
function notificationProblem(message, expectedResultPath) {
  if (!message || typeof message !== 'object') return `a ${typeof message} message`
  if (message.type !== NOTIFICATION_TYPE) return `type ${JSON.stringify(message.type)}`
  if (message.schema !== 1) return `schema ${JSON.stringify(message.schema)}`
  if (!['measured', 'incomplete', 'error'].includes(message.status)) return `status ${JSON.stringify(message.status)}`
  if (message.resultPath !== undefined && message.resultPath !== expectedResultPath) {
    return `resultPath ${JSON.stringify(message.resultPath)}`
  }
  if (message.status === 'error') {
    return typeof message.error === 'string' && message.error.length > 0
      ? null : 'an error message without its error text'
  }
  return message.resultPath === expectedResultPath ? null : 'a completion message without its result path'
}

function startChild(state, paths, bundlePath, config) {
  const outcome = deferred()
  state.outcome = outcome
  const configValue = JSON.stringify({ config, paths: { root: state.temp, home: paths.home,
    userData: paths.userData, sessionData: paths.sessionData, appTemp: paths.tmp, logs: paths.logs,
    resultPath: paths.result } })
  let child
  try {
    child = spawn(state.electronPath, [bundlePath, `--user-data-dir=${paths.userData}`, '--disable-gpu',
      '--disable-background-timer-throttling', '--no-first-run'], {
      cwd: paths.work,
      // Allowlist only: PATH/HOME/TMPDIR plus this fixture's single config value. No inherited credentials,
      // no NODE_OPTIONS/NODE_ENV injection and no App test flags reach the measured process.
      env: { PATH: process.env.PATH ?? '', HOME: paths.home, TMPDIR: paths.tmp, [CONFIG_ENV]: configValue },
      // The extra 'ipc' entry carries the fixture's single fixed completion notification.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
  } catch (error) {
    outcome.settle({ kind: 'spawn-error', error: errorMessage(error) })
    return
  }
  state.child = child
  // Subscribed at spawn: an error, an exit or a notification that lands before the await is cached.
  child.stdout.on('data', state.capture.stdout)
  child.stderr.on('data', state.capture.stderr)
  state.closeWatch = watchChildClose(child)
  // An unknown message fails the run at once instead of waiting for the work deadline.
  child.on('message', (message) => {
    const problem = notificationProblem(message, paths.result)
    if (problem !== null) {
      outcome.settle({ kind: 'notification-invalid', error: problem })
      return
    }
    outcome.settle({ kind: 'notification', message })
  })
  child.once('error', (error) => outcome.settle({ kind: 'spawn-error', error: errorMessage(error) }))
  // 'exit' rather than 'close': a natural early exit must not wait for the stdio drain.
  child.once('exit', (code, signal) => outcome.settle({ kind: 'exit', code, signal }))
  state.deadline = setTimeout(() => outcome.settle({ kind: 'timeout', afterMs: WORK_DEADLINE_MS }), WORK_DEADLINE_MS)
  state.deadline.unref?.()
}

function readResult(paths, config) {
  const bytes = statSync(paths.result).size
  if (bytes > RESULT_BYTES_LIMIT) throw new Error(`the trial result is ${bytes} bytes, above the fixture bound`)
  const payload = JSON.parse(readFileSync(paths.result, 'utf8'))
  if (!payload || payload.schema !== 1) throw new Error('the trial result carries no schema 1 marker')
  if (!['measured', 'incomplete', 'error'].includes(payload.status)) {
    throw new Error(`the trial result has an unknown status ${JSON.stringify(payload.status)}`)
  }
  const cell = payload.config
  if (!cell || cell.limit !== config.limit || cell.readers !== config.readers || cell.items !== config.items) {
    throw new Error('the cell that ran is not the cell the launcher asked for')
  }
  return payload
}

// One identity-checked stop per child. A child that already exited is never signalled: stopOwnedApp would
// refuse it, and the natural early exit is recorded as the failure it is.
async function attemptStop(state) {
  const stop = state.stop
  if (stop.attempted) return
  stop.attempted = true
  const child = state.child
  if (!child) { stop.note = 'no child was started'; return }
  if (child.exitCode !== null || child.signalCode !== null) {
    stop.note = `child had already exited (code ${child.exitCode}, signal ${child.signalCode}); a stop would not be an identity-checked cleanup`
    return
  }
  try {
    stop.result = await stopOwnedApp(child)
  } catch (error) {
    stop.error = errorMessage(error)
  }
}

function verdict(state) {
  if (state.reason !== null) return
  const payload = state.payload
  const notification = state.notification
  if (!payload) { state.reason = 'result-missing'; state.error = 'the cell reported completion without a readable result file'; return }
  if (notification.status !== payload.status) {
    state.reason = 'notification-mismatch'
    state.error = `notification said ${notification.status}, result said ${payload.status}`
    return
  }
  if (payload.status === 'error') { state.reason = 'trial-error'; state.error = payload.error ?? 'the cell reported an error without a message'; return }
  if (payload.status === 'incomplete') { state.reason = 'trial-incomplete'; return }
  if (!payload.trial || payload.trial.status !== 'measured') { state.reason = 'trial-not-measured'; return }
  if (state.close?.state !== 'closed') { state.reason = 'child-close-unknown'; return }
  // The close event alone is not a clean exit: the entry handles SIGTERM with app.exit(0), so a nonzero
  // code or any signal means the process was not stopped the way this launcher may report as clean.
  if (state.close.code !== 0 || state.close.signal !== null) {
    state.reason = 'child-exit-not-clean'
    state.error = `the child closed with code ${state.close.code} and signal ${state.close.signal}`
    return
  }
  if (state.leftover?.state !== 'exited') { state.reason = 'cleanup-unknown'; return }
  if (state.stop.note !== null || state.stop.error !== null || state.stop.result === null) { state.reason = 'cleanup-unconfirmed'; return }
  if (state.hashesAfter?.status !== 'measured' || state.hashesAfter.files === undefined) {
    state.reason = 'sources-unverified'
    return
  }
  const changed = SOURCE_FILES.filter((file) => state.hashesAfter.files[file] !== state.hashesBefore.files[file])
  if (changed.length > 0) { state.reason = 'sources-changed-during-run'; state.error = `changed: ${changed.join(', ')}`; return }
  if (state.bundleHashAfter !== state.bundle.sha256) { state.reason = 'bundle-changed-during-run'; return }
}

async function finalize(state, config, startedAtMs) {
  try {
    await attemptStop(state)
    state.close = state.closeWatch ? await state.closeWatch.wait() : { state: 'unknown', reason: 'no child was started' }
    state.captureText = state.capture ? state.capture.finish() : ''
    state.captureTruncated = state.capture ? state.capture.truncated() : false
    state.leftover = inspectOwnedApp(state.child)
    state.hashesAfter = hashSources(root)
    if (state.bundle) {
      try { state.bundleHashAfter = hashFile(state.bundle.bundlePath) } catch (error) {
        state.bundleHashAfter = null
        state.hashError = errorMessage(error)
      }
    }
    verdict(state)
  } catch (error) {
    // Kept apart from the run's own error: a broken cleanup never overwrites why the run failed.
    state.cleanupError = errorMessage(error)
    state.reason ??= 'cleanup-unconfirmed'
  }
  if (state.reason === null) {
    state.tempRemoval.attempted = true
    state.tempRemoval.root = state.temp
    try {
      rmSync(state.temp, { recursive: true, force: true })
      state.tempRemoval.removed = true
      state.tempRemoval.note = 'removed after a measured run with confirmed stop and clean close'
    } catch (error) {
      // A failed removal is a failed run, not a footnote: the directory may be partially deleted.
      state.tempRemoval.error = errorMessage(error)
      state.tempRemoval.note = 'the deletion was attempted and failed; the directory may be partially deleted, so this run is not a confirmed cleanup'
      state.reason = 'temp-not-removed'
    }
  }
  if (state.reason === null) {
    state.exitCode = 0
    state.prefix = SUMMARY_PREFIX
    state.output = successSummary(state, config, startedAtMs)
    return
  }
  state.tempRemoval.root ??= state.temp
  state.tempRemoval.note ??= state.temp === null
    ? 'no private tree was created'
    : 'kept as it is; no deletion was attempted'
  state.exitCode = 1
  state.prefix = FAILURE_PREFIX
  // A retained log is written before the summary names it; a write failure is reported, not hidden.
  const logPath = state.paths ? join(state.paths.logs, 'launcher.log') : null
  if (logPath) {
    try {
      const primary = state.error ?? state.tempRemoval.error ?? state.cleanupError ?? state.resultError
      writeFileSync(logPath, `[scry:concurrency-trace] ${state.reason}: ${primary ?? 'no error message'}\n\n${state.captureText ?? ''}`)
      state.logPath = logPath
    } catch (error) {
      state.logPath = null
      state.logError = errorMessage(error)
    }
  }
  state.output = failureSummary(state, config)
}

async function runCell(config) {
  const startedAtMs = Date.now()
  const state = { temp: null, paths: null, electronPath: null, child: null, capture: null, closeWatch: null,
    deadline: null, outcome: null, notification: null, notificationError: null, resultError: null,
    payload: null, bundle: null, bundleHashAfter: null, identity: null, hashesBefore: null, hashesAfter: null,
    tempRemoval: { attempted: false, removed: false, root: null, error: null, note: null },
    stop: { attempted: false, result: null, error: null, note: null },
    close: null, leftover: null, reason: null, error: null, cleanupError: null, exitCode: 1,
    prefix: FAILURE_PREFIX, output: null, captureText: '', captureTruncated: false, logPath: null,
    logError: null, hashError: null }
  try {
    state.temp = mkdtempSync(join(tmpdir(), 'scry-concurrency-trace-'))
    const paths = { home: join(state.temp, 'home'), userData: join(state.temp, 'userData'),
      sessionData: join(state.temp, 'sessionData'), tmp: join(state.temp, 'tmp'), logs: join(state.temp, 'logs'),
      work: join(state.temp, 'work'), build: join(state.temp, 'build'), result: join(state.temp, 'result.json') }
    state.paths = paths
    for (const dir of [paths.home, paths.userData, paths.sessionData, paths.tmp, paths.logs, paths.work, paths.build]) {
      mkdirSync(dir, { recursive: true })
    }
    state.capture = createOutputCapture({ onLine: () => {} })
    state.identity = readIdentity(root)
    state.hashesBefore = hashSources(root)
    if (state.hashesBefore.status !== 'measured') throw new Error(state.hashesBefore.reason)
    state.bundle = await buildEntryBundle(paths.build)
    const { default: electronPath } = await import('electron')
    state.electronPath = electronPath
    startChild(state, paths, state.bundle.bundlePath, config)
    const settled = await state.outcome.promise
    if (state.deadline) { clearTimeout(state.deadline); state.deadline = null }
    if (settled.kind === 'timeout') {
      state.reason = 'work-timeout'
      state.error = `the cell did not report within ${WORK_DEADLINE_MS} ms`
    } else if (settled.kind === 'exit') {
      state.reason = 'child-exited-before-notification'
      state.error = `Electron exited early (code ${settled.code}, signal ${settled.signal}) without a completion notification`
    } else if (settled.kind === 'spawn-error') {
      state.reason = 'spawn-error'
      state.error = settled.error
    } else if (settled.kind === 'notification-invalid') {
      state.reason = 'notification-invalid'
      state.error = `the completion notification is not the fixed shape: ${settled.error}`
    } else {
      state.notification = settled.message
      state.notificationError = typeof settled.message.error === 'string' ? settled.message.error : null
      try {
        state.payload = readResult(paths, config)
      } catch (error) {
        // The entry's own error text and the failure to read its result are separate facts: a missing file
        // must not replace what the cell reported.
        state.resultError = errorMessage(error)
        state.reason = settled.message.status === 'error' ? 'trial-error' : 'result-unreadable'
        state.error = settled.message.status === 'error'
          ? (state.notificationError ?? 'the cell reported an error without a message')
          : state.resultError
      }
    }
  } catch (error) {
    state.reason ??= 'launcher-failure'
    state.error ??= errorMessage(error)
  } finally {
    // Always one bounded cleanup, even after a build or spawn failure; it never retries.
    await finalize(state, config, startedAtMs)
  }
  if (state.deadline) clearTimeout(state.deadline)
  process.exitCode = state.exitCode
  process.stdout.write(`${state.prefix}${JSON.stringify(state.output)}\n`)
  if (state.exitCode !== 0 && state.logError) {
    process.stderr.write(`[scry:concurrency-trace] retained log could not be written: ${state.logError}\n`)
  }
  return state.exitCode
}

const parsed = parseCellArgs(process.argv.slice(2))
if (parsed.help === true) {
  process.stdout.write(`${USAGE}\n`)
  process.exitCode = 0
} else if (parsed.error !== undefined) {
  process.stderr.write(`${USAGE}\n\n[scry:concurrency-trace] ${parsed.error}\n`)
  process.exitCode = 2
} else {
  try {
    process.exitCode = await runCell(parsed.config)
  } catch (error) {
    // Last resort only: the run itself always reports a structured failure before it returns.
    process.exitCode = 1
    process.stderr.write(`${FAILURE_PREFIX}${JSON.stringify({ status: 'failed', reason: 'launcher-crash', error: errorMessage(error) })}\n`)
  }
}
