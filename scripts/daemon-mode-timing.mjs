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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
        SCRY_REMOTE_HOST: '0'
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
      await evaluate('window.__timing = { events: [], done: null }; true')
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
      const sample = await evaluate(`(() => {
        const timing = window.__timing
        const text = timing.events.filter((event) => event.stage === 'text' || event.stage === 'text_delta')
        const intervals = text.slice(1).map((event, position) => event.t - text[position].t)
        // Clock skew is not an assumption here: the lag is compared between modes, and both
        // modes measure it the same way.
        const lag = text.map((event) => event.receivedAt - event.emittedAt).filter((value) => Number.isFinite(value))
        return {
          firstTextMs: text.length > 0 ? text[0].t - timing.submittedAt : null,
          textEvents: text.length,
          intervals,
          lag,
          settledMs: timing.done === null ? null : timing.done - timing.submittedAt
        }
      })()`)
      results.runs.push({ index: results.runs.length, runId, ...sample })
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
    // A fresh daemon per chunk. Daemon mode slows down as one daemon's ledger grows: in
    // two earlier runs of this script the 30th start in the same state directory missed
    // its bind budget (`daemon_run_not_bound`). That is a separate finding, and measuring
    // it would only report a degraded tail as if it were the normal cost.
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
