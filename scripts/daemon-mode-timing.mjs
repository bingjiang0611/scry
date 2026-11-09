#!/usr/bin/env node
// S1: how much does the daemon add to what the user waits for?
//
//   node scripts/daemon-mode-timing.mjs --samples 30 --mode daemon
//
// Same App build, same packaged Provider fixture, same workspace, one mode per run:
// `in-process` uses the App's own pipeline (no SCRY_HOST_DAEMON), `daemon` sets the
// switch so the daemon executes the run. Both are measured from the renderer, through
// the shipped preload API, so a difference is the transport and ownership change and
// not a second instrument.
//
// Reported per mode, over N serial samples of the same fixture prompt:
//   submit -> first text      the wait before anything appears
//   delta interval P50/P95    how evenly the stream arrives once it starts
//
// Millisecond conclusions need quiet measurements: run this under
// `.agents/skills/scry-performance-climb/scripts/timing-run.mjs`, which holds a host
// lock and reports the load; the script also records load itself.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, createEvaluate, freePort, launch, waitForTarget } from './desktop-remote-host-smoke/harness.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const samples = Number(option('samples', '30'))
const mode = option('mode', 'daemon')
if (!['daemon', 'in-process'].includes(mode)) throw new Error(`unknown mode: ${mode}`)

// 20 deltas 150 ms apart: a stream whose steady state is observable in both modes,
// instead of one burst that any path can only deliver as a single lump.
const PROMPT = 'performance paced stream'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Stop the daemon this state directory recorded - never a pid that might have been
// reused: the recorded identity is checked against the process' own command line.
const stopDaemon = (stateDir) => {
  let lock
  try { lock = JSON.parse(readFileSync(join(stateDir, 'daemon.lock'), 'utf8')) } catch { return }
  const supervisor = /^supervisor:(\d+)$/.exec(String(lock.startedBy ?? ''))
  for (const pid of [lock.pid, supervisor ? Number(supervisor[1]) : undefined].filter((value) => Number.isSafeInteger(value))) {
    try {
      const argv = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      if (!/daemon(\.js)?|supervisor/.test(argv)) continue
      process.kill(pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
}

const load = () => ({ load1: Number(loadavg()[0].toFixed(2)), cores: cpus().length })
const percentile = (values, fraction) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2))
}

// A unix socket path has a hard length limit, and macOS' TMPDIR is long: the daemon
// refuses to start under it (daemon_socket_path_too_long). /tmp is short on both.
const temp = mkdtempSync(join('/tmp', `scry-timing-${mode}-`))
const home = join(temp, 'home')
const userDataDir = join(temp, 'userData')
const workspace = join(home, 'workspace')
mkdirSync(workspace, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
writeFileSync(join(workspace, 'README.md'), '# workspace\n')
// The App only starts in a directory its own picker recorded.
writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify([{ cwd: workspace, lastOpenedAt: 1 }]))

const electron = process.platform === 'darwin'
  ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : join(root, 'node_modules/electron/dist/electron')

const perInstance = Number(option('per-instance', '15'))
const log = []
// `[scry:perf]` lines from the App's main process: each finished `daemon.run.firstText`
// trace carries the elapsed time of every stage it marked, so the first-token wait is
// split by hop instead of guessed at.
let pendingStages = {}
let perfScanned = 0
const takeStages = () => {
  const taken = pendingStages
  pendingStages = {}
  return taken
}
const readPerfLines = () => {
  const text = log.join('')
  const fresh = text.slice(perfScanned)
  perfScanned = text.length
  for (const line of fresh.split('\n')) {
    if (!line.startsWith('[scry:perf] ')) continue
    let sample
    try { sample = JSON.parse(line.slice('[scry:perf] '.length)) } catch { continue }
    if (sample.name !== 'daemon.run.firstText') continue
    const marks = {}
    for (const checkpoint of sample.checkpoints ?? []) marks[checkpoint.stage] = checkpoint.elapsedMs
    pendingStages = marks
  }
}
// Per-stage wall-clock marks written by both processes of this mode (App main and, in
// daemon mode, the daemon) into one NDJSON: `performance.timeOrigin + performance.now()`
// is epoch milliseconds in either process, so the marks are directly subtractable.
const timingFile = join(userDataDir, 'diagnostics', 'run-timing.ndjson')
let timingScanned = 0
const newRunMarks = () => {
  if (!existsSync(timingFile)) return []
  const text = readFileSync(timingFile, 'utf8')
  const fresh = text.slice(timingScanned)
  timingScanned = text.length
  const marks = []
  for (const line of fresh.split('\n')) {
    if (line.length === 0) continue
    try { marks.push(JSON.parse(line)) } catch { /* a torn tail is not a mark */ }
  }
  return marks
}
// One timeline per sample, not per run id: a daemon run has a ledger id and a runtime
// id, and its marks are written by two processes, so the sample window is what ties them
// together. A stage keeps its earliest mark inside the window; a missing stage stays
// missing instead of being filled with a neighbour.
const selectTimeline = (marks, submittedWall, until) => {
  const stages = {}
  const runIds = new Set()
  for (const mark of marks) {
    if (typeof mark?.runId !== 'string' || typeof mark?.at !== 'number') continue
    // Anything before the submit belongs to the previous sample.
    if (mark.at < submittedWall - 200 || mark.at > until + 2_000) continue
    runIds.add(mark.runId)
    if (stages[mark.stage] === undefined || mark.at < stages[mark.stage]) stages[mark.stage] = mark.at
  }
  return [...runIds].length === 0 ? null : { ...stages, runIds: [...runIds] }
}

const results = { mode, samples, perInstance, prompt: PROMPT, loadBefore: load(), runs: [], loadAfter: null }

// One App per chunk: daemon mode slows down as one window accumulates settled runs
// (a new run's bind wait grew past its 3 s budget at 30 runs in one session), so the
// measurement restarts the App instead of reporting a degraded tail as the norm.
const measure = async (count) => {
  const port = await freePort()
  let child
  let cdp
  try {
    child = launch({
      spawn, executable: electron, devApp: true, root, port, userDataDir, home,
      appendLog: (chunk) => { log.push(chunk); if (log.length > 4000) log.splice(0, 2000) }, env: {
        // An isolated instance for either mode; the daemon switch is the only difference.
        ...(mode === 'daemon' ? { SCRY_HOST_DAEMON: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1' } : {}),
        SCRY_REMOTE_HOST: '0',
        // Stage marks from the App's own main process; off by default everywhere else.
        SCRY_PERF_LOG: '1',
        // Per-stage wall clock, written by the App and (in daemon mode) the daemon itself.
        SCRY_RUN_TIMING: '1'
      }
    })
    const target = await waitForTarget(port)
    cdp = connectCdp(target.webSocketDebuggerUrl)
    const evaluate = createEvaluate(cdp)
    await evaluate(`window.scry.setCwd(${JSON.stringify(workspace)})`)
    // One subscription for the whole instance: every text event is stamped where the user
    // sees it arrive, and the stamp costs the renderer nothing at measurement time.
    await evaluate(`(() => {
      window.__timing = { events: [], done: null }
      window.scry.onTrace((events) => {
        for (const event of events) {
          if (event.kind === 'model' && event.stage !== undefined) {
            // Two clocks, one machine: the event's own stamp (made where it was emitted)
            // against the moment the renderer received it is the lag the user feels, and it
            // is measured the same way in both modes.
            window.__timing.events.push({ t: performance.now(), receivedAt: Date.now(), emittedAt: Date.parse(event.ts), stage: event.stage })
          }
          if (event.kind === 'harness' && event.stage === 'result') window.__timing.done = performance.now()
        }
      })
      return true
    })()`)
    if (mode === 'daemon') {
      // The first call can arrive before the daemon is ready; the App reports that and asks
      // again, which is the real user path rather than a retry invented here. Bounded by
      // wall clock: a readiness probe that never settles is not readiness.
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const ready = await Promise.race([
          evaluate('window.scry.activeRuns().then(() => true).catch(() => false)'),
          sleep(5_000).then(() => 'no-answer')
        ])
        if (ready === true) break
        await sleep(100)
      }
    }
    for (let index = 0; index < count; index++) {
      process.stderr.write(`[timing] ${mode} sample ${results.runs.length + 1}\n`)
      await evaluate(`(() => {
        window.__timing = { events: [], done: null }
        window.__timing.submittedAtWall = performance.timeOrigin + performance.now()
        return true
      })()`)
      const submittedWall = await evaluate('window.__timing.submittedAtWall')
      newRunMarks()
      const runId = await evaluate(`(() => {
        const started = performance.now()
        window.__timing.submittedAt = started
        return window.scry.start({ prompt: ${JSON.stringify(PROMPT)}, providerId: 'codex', cwd: ${JSON.stringify(workspace)} })
          .then((receipt) => String(receipt.runId))
      })()`)
      for (let waited = 0; waited < 300; waited++) {
        const done = await evaluate('window.__timing.done !== null')
        if (done === true) break
        await sleep(100)
      }
      readPerfLines()
      const timeline = selectTimeline(newRunMarks(), submittedWall, Date.now())
      const sample = await evaluate(`(() => {
        const timing = window.__timing
        const text = timing.events.filter((event) => event.stage === 'text' || event.stage === 'text_delta')
        const intervals = text.slice(1).map((event, position) => event.t - text[position].t)
        // Clock skew is not an assumption here: the lag is compared between modes, and both
        // modes measure it the same way.
        const lag = text.map((event) => event.receivedAt - event.emittedAt).filter((value) => Number.isFinite(value))
        return {
          submittedWall: timing.submittedAtWall,
          firstTextReceivedAt: text.length > 0 ? text[0].receivedAt : null,
          firstTextMs: text.length > 0 ? text[0].t - timing.submittedAt : null,
          textEvents: text.length,
          intervals,
          lag,
          settledMs: timing.done === null ? null : timing.done - timing.submittedAt
        }
      })()`)
      results.runs.push({ index: results.runs.length, runId, ...sample, stages: takeStages(), timeline })
    }
  } finally {
    try { if (cdp) cdp.close() } catch { /* a dead socket is fine */ }
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await sleep(1_500)
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

try {
  for (let done = 0; done < samples; done += perInstance) {
    // A fresh daemon per chunk isolates the measurement from one daemon's history. The
    // 30th start in one state directory used to miss its bind budget
    // (`daemon_run_not_bound`) because the watch re-read the ledger's first page; that is
    // fixed, so a single chunk of thirty now measures one daemon's steady state.
    if (mode === 'daemon' && done > 0) {
      // The supervisor is a separate process and outlives the App; a new state directory
      // under a live supervisor only produces `daemon_ready_timeout`.
      stopDaemon(join(userDataDir, 'daemon'))
      rmSync(join(userDataDir, 'daemon'), { recursive: true, force: true })
    }
    await measure(Math.min(perInstance, samples - done))
  }
  results.loadAfter = load()
  const firstText = results.runs.map((run) => run.firstTextMs).filter((value) => typeof value === 'number')
  const intervals = results.runs.flatMap((run) => run.intervals)
  const settled = results.runs.map((run) => run.settledMs).filter((value) => typeof value === 'number')
  const lag = results.runs.flatMap((run) => run.lag)
  const stageValues = {}
  for (const run of results.runs) {
    for (const [stage, ms] of Object.entries(run.stages ?? {})) (stageValues[stage] ??= []).push(ms)
  }
  results.stages = Object.fromEntries(Object.entries(stageValues).map(([stage, values]) => [stage, {
    samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95)
  }]))
  // The first token, split at the Provider's own first output: what the host spends
  // before the model says anything, and what the delivery adds after. Absolute marks
  // from both processes make each segment a subtraction, not an estimate.
  // A segment reads (timeline, run): both ends must have been measured, and the closures
  // that compare against the renderer also need the run's own arrival stamp.
  const segments = {
    submittedToFirstText: (t) => t.firstTextReceivedAt - t.submittedWall,
    // The App's own preparation before the Provider starts, measured identically in both
    // modes: this is the one pre-Provider segment that is not daemon-specific.
    submittedToProvider: (t) => t.providerStart - t.submittedWall,
    submitToDurable: (t) => t.intentDurable - t.submit,
    durableToDispatch: (t) => t.dispatch - t.intentDurable,
    dispatchToProvider: (t) => t.providerStart - t.dispatch,
    providerToFirstOutput: (t) => t.firstOutput - t.providerStart,
    firstOutputToTraceRead: (t) => t.traceRead - t.firstOutput,
    // F1: from the daemon's text-bearing answer to the App handing the batch over.
    traceReadToApply: (t) => t.apply - t.traceRead,
    applyToDeliver: (t) => t.applyDeliver - t.apply,
    applyToBridgeQueue: (t) => t.bridgeQueue - t.apply,
    bridgeQueueToFlush: (t) => t.bridgeFlush - t.bridgeQueue,
    firstOutputToApply: (t) => t.apply - t.firstOutput,
    traceReadToWatchReply: (t) => t.watchReply - t.traceRead,
    watchReplyToAppPush: (t) => t.rendererPush - t.watchReply,
    appPushToRenderer: (t, run) => run.firstTextReceivedAt - t.rendererPush,
    firstOutputToRenderer: (t, run) => run.firstTextReceivedAt - t.firstOutput,
    providerToRenderer: (t, run) => run.firstTextReceivedAt - t.providerStart,
    submitToFirstText: (t, run) => run.firstTextReceivedAt - t.submit
  }
  results.segments = Object.fromEntries(Object.entries(segments).map(([name, read]) => {
    const values = []
    for (const run of results.runs) {
      if (!run.timeline || typeof run.firstTextReceivedAt !== 'number') continue
      // A segment only counts when both of its ends were actually measured; a missing
      // mark is a gap in the evidence, never a zero.
      const timeline = { ...run.timeline, firstTextReceivedAt: run.firstTextReceivedAt, submittedWall: run.submittedWall }
      let value
      try { value = read(timeline, run) } catch { continue }
      if (typeof value === 'number' && Number.isFinite(value)) values.push(Number(value.toFixed(2)))
    }
    return [name, { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }]
  }))
  results.summary = {
    runs: results.runs.length,
    runsWithFirstText: firstText.length,
    firstTextP50: percentile(firstText, 0.5),
    firstTextP95: percentile(firstText, 0.95),
    deltaSamples: intervals.length,
    deltaP50: percentile(intervals, 0.5),
    deltaP95: percentile(intervals, 0.95),
    settledP50: percentile(settled, 0.5),
    settledP95: percentile(settled, 0.95),
    eventLagSamples: lag.length,
    eventLagP50: percentile(lag, 0.5),
    eventLagP95: percentile(lag, 0.95)
  }
} catch (error) {
  results.error = String(error?.message ?? error)
} finally {
  if (log.length > 0) results.appLog = log.join('').slice(-4000)
  results.cleanup = (() => {
    // A failed run keeps its directory: the daemon's own log is the evidence.
    if (results.error || args.includes('--keep')) return false
    rmSync(temp, { recursive: true, force: true })
    return true
  })()
  if (results.cleanup === false) results.temp = temp
}

process.stdout.write(`${JSON.stringify(results)}\n`)
process.exit(results.error ? 2 : 0)
