#!/usr/bin/env node
// S1: how much does the daemon add to what the user waits for?
//
//   node scripts/daemon-mode-timing.mjs --samples 30 --mode daemon
//
// Same App build, same packaged Provider fixture, same workspace; the daemon executes the
// run, measured from the renderer through the shipped preload API. The `in-process`
// comparison arm was removed with S3 (the App no longer has an in-process runtime); compare
// against a saved report of an older build instead.
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
import { buildTimingSummary, selectTimeline } from './daemon-mode-timing-summary.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const samples = Number(option('samples', '30'))
const mode = option('mode', 'daemon')
const multiTurn = args.includes('--multi-turn')
const largeBody = args.includes('--large-body')
const withMcp = args.includes('--with-mcp')
if (mode === 'in-process') throw new Error('in-process mode was removed with S3: the App always runs Agents in its daemon')
if (mode !== 'daemon') throw new Error(`unknown mode: ${mode}`)

// Paced fixture output lets the benchmark observe spacing between arrivals.
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
    } catch { /* best-effort cleanup */ }
  }
}

const load = () => ({ load1: Number(loadavg()[0].toFixed(2)), cores: cpus().length })

// A unix socket path has a hard length limit, and macOS' TMPDIR is long: the daemon
// refuses to start under it (daemon_socket_path_too_long). /tmp is short on both.
const temp = mkdtempSync(join('/tmp', `scry-timing-${mode}-`))
const home = join(temp, 'home')
const userDataDir = join(temp, 'userData')
const workspace = join(home, 'workspace')
mkdirSync(workspace, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
writeFileSync(join(workspace, 'README.md'), '# workspace\n')
if (withMcp) {
  // Real MCP config referencing the local Node/Electron executable so S1 measures trust gate with a real binary.
  mkdirSync(join(workspace, '.codex'), { recursive: true })
  writeFileSync(
    join(workspace, '.codex', 'config.toml'),
    `[mcp_servers.bench_node]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", "setTimeout(() => {}, 1000)"]\n`
  )
}
// Seed the benchmark workspace in the isolated project list without opening the picker.
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

const results = {
  mode,
  samples,
  perInstance,
  multiTurn,
  largeBody,
  withMcp,
  prompt: PROMPT,
  orchestration: {
    mode: 'authoritative',
    fullfsync: process.env.SCRY_ORCHESTRATION_FULLFSYNC ?? 'default'
  },
  loadBefore: load(),
  runs: [],
  loadAfter: null
}

// One App per chunk: daemon mode slows down as one window accumulates settled runs
// (a new run's bind wait grew past its 3 s budget at 30 runs in one session), so the
// measurement restarts the App instead of reporting a degraded tail as the norm.
const measure = async (count, chunkIndex) => {
  const port = await freePort()
  const multiTurnSessionId = multiTurn ? `s1-multi-turn-session-${chunkIndex}` : undefined
  let child
  let cdp
  try {
    child = launch({
      spawn, executable: electron, devApp: true, root, port, userDataDir, home,
      appendLog: (chunk) => { log.push(chunk); if (log.length > 4000) log.splice(0, 2000) }, env: {
        SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1',
        ...(process.env.SCRY_ORCHESTRATION_FULLFSYNC !== undefined ? { SCRY_ORCHESTRATION_FULLFSYNC: process.env.SCRY_ORCHESTRATION_FULLFSYNC } : {}),
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
    // One subscription for this instance records model-event arrival times in the renderer.
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
      // Use a unique synthetic PNG-labeled attachment to enlarge the ledger detail
      // without changing the exact prompt that triggers the paced stream.
      const largeAttachmentBytes = largeBody
        ? Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from(`sample-${results.runs.length}-${'X'.repeat(32_000)}`, 'utf8')
          ])
        : null
      const startPayload = {
        prompt: PROMPT,
        providerId: 'codex',
        cwd: workspace,
        ...(multiTurnSessionId ? { expectedExternalSessionId: multiTurnSessionId } : {}),
        ...(largeAttachmentBytes
          ? {
              attachments: [
                {
                  kind: 'image',
                  name: 'large-body.png',
                  mimeType: 'image/png',
                  dataBase64: largeAttachmentBytes.toString('base64'),
                  size: largeAttachmentBytes.length
                }
              ]
            }
          : {})
      }
      const runId = await evaluate(`(() => {
        const started = performance.now()
        window.__timing.submittedAt = started
        return window.scry.start(${JSON.stringify(startPayload)})
          .then((receipt) => String(receipt.runId))
      })()`)
      for (let waited = 0; waited < 300; waited++) {
        const done = await evaluate('window.__timing.done !== null')
        if (done === true) break
        await sleep(100)
      }
      readPerfLines()
      const timeline = selectTimeline(newRunMarks(), submittedWall, Date.now(), runId)
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
    await measure(Math.min(perInstance, samples - done), Math.floor(done / perInstance) + 1)
  }
  results.loadAfter = load()
  Object.assign(results, buildTimingSummary(results.runs, perInstance))
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
