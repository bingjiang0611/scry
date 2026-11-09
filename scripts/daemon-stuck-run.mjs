#!/usr/bin/env node
// G1: does every submitted run reach an observable state, at high run counts?
//
//   npm run build && node scripts/daemon-stuck-run.mjs [--runs 200] [--watchdog 10000]
//
// One isolated userData + workspace + HOME, one App, one daemon, the packaged smoke
// Provider, and N runs started one after another in the same daemon. Each start gets a
// watchdog: if the run has neither text-and-done, nor a stated error, nor a settled
// view within the budget, the run is reported as stuck and everything needed to say
// where it stopped is written to one JSON file:
//
//   ledger         the daemon's own events for that run (intent/dispatch/bind/failed)
//   appView        what the window would show, plus the active-run list
//   timing         the App/daemon stage marks for the same wall-clock window
//   daemon         lock file, pid, and whether it answered a live-run read
//
// Evidence is written before the process exits, so a stuck run is never "just a
// timeout in the log". The script stops at the first stuck run by default: the next
// start would be measured against a session whose admission may still be held.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { connectCdp, createEvaluate, freePort, launch, waitForTarget } from './desktop-remote-host-smoke/harness.mjs'

const root = process.cwd()
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const runs = Number(option('runs', '200'))
const watchdogMs = Number(option('watchdog', '10000'))
const stopOnStuck = !args.includes('--continue')
// The default fixture settles in ~260 ms. The paced one streams for ~3 s, which is what
// the first stuck run was doing: a long run whose next start arrives while its own
// teardown is still finishing.
const prompt = option('prompt', 'native composer complete daemon mode fixture')

const temp = mkdtempSync('/tmp/scry-g1-stuck-')
const userDataDir = join(temp, 'userData')
const home = join(temp, 'home')
const workspace = join(home, 'workspace')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'README.md'), '# fixture\n')
writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify([{ cwd: workspace, lastOpenedAt: 1 }]))

const electron = process.platform === 'darwin'
  ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : join(root, 'node_modules/electron/dist/electron')

const log = []
const appendLog = (chunk) => { log.push(chunk); if (log.length > 4000) log.splice(0, 2000) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ledgerFile = join(userDataDir, 'daemon', 'ledger', 'session-ledger.log')
const timingFile = join(userDataDir, 'daemon', '..', 'diagnostics', 'run-timing.ndjson')
const daemonLock = join(userDataDir, 'daemon', 'daemon.lock')

const ledgerFor = (runId, intentId) => {
  if (!existsSync(ledgerFile)) return []
  return readFileSync(ledgerFile, 'utf8').split('\n').filter((line) => line.length > 0).flatMap((line) => {
    try {
      const event = JSON.parse(line)
      if (event.runId !== runId && event.intentId !== intentId && event.detail !== intentId) return []
      return [event]
    } catch { return [] }
  })
}
const timingFor = (runIds) => {
  if (!existsSync(timingFile)) return []
  const wanted = new Set(runIds.filter((value) => typeof value === 'string'))
  return readFileSync(timingFile, 'utf8').split('\n').filter((line) => line.length > 0).flatMap((line) => {
    try {
      const mark = JSON.parse(line)
      return wanted.has(mark.runId) ? [mark] : []
    } catch { return [] }
  })
}
const daemonState = () => {
  let lock = null
  try { lock = JSON.parse(readFileSync(daemonLock, 'utf8')) } catch { /* no lock is a state too */ }
  return { lock, stateDirExists: existsSync(join(userDataDir, 'daemon')) }
}

const results = { runs: [], stuck: [], watchdogMs, prompt, load: null, error: null, temp }
let child
let cdp

try {
  if (!existsSync(join(root, 'out/main/index.js'))) throw new Error('build first: npm run build')
  const port = await freePort()
  child = launch({
    spawn, executable: electron, devApp: true, root, port, userDataDir, home, appendLog,
    env: {
      SCRY_HOST_DAEMON: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1',
      SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1', SCRY_REMOTE_HOST: '0',
      // Stage marks from both processes, so a stuck run can be placed on the timeline.
      SCRY_RUN_TIMING: '1', SCRY_PERF_LOG: '1'
    }
  })
  const target = await waitForTarget(port)
  cdp = connectCdp(target.webSocketDebuggerUrl)
  const evaluate = createEvaluate(cdp)
  const until = async (expression, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await evaluate(expression)
      if (predicate(last)) return last
      await sleep(100)
    }
    return last
  }
  await until('Boolean(window.scry && window.scry.start)', (ready) => ready === true, 30_000)
  await until('window.scry.activeRuns().then(runs => runs.length >= 0).catch(() => false)', (value) => value === true, 60_000)
  await evaluate(`window.scry.setCwd(${JSON.stringify(workspace)})`)
  results.load = await evaluate('1')

  for (let index = 0; index < runs; index++) {
    const intentId = `g1-${Date.now()}-${index}`
    const started = Date.now()
    const receipt = await evaluate(`window.scry.start({ prompt: ${JSON.stringify(prompt)}, providerId: 'codex', cwd: ${JSON.stringify(workspace)} })`)
      .catch((error) => ({ error: String(error) }))
    const runId = receipt && typeof receipt.runId === 'string' ? receipt.runId : undefined
    let state = null
    const deadline = Date.now() + watchdogMs
    while (Date.now() < deadline) {
      state = await evaluate(`window.scry.focusedRunSnapshot().then(run => run ? {
        runId: run.runId, done: run.done === true, error: run.error ?? null,
        items: run.items.length,
        text: run.items.some(item => item.stage === 'text' || item.stage === 'text_delta')
      } : null)`).catch(() => null)
      if (state && (state.done || state.error !== null)) break
      await sleep(100)
    }
    const elapsed = Date.now() - started
    const settled = Boolean(state && (state.done || state.error !== null))
    results.runs.push({ index, intentId, runId, elapsed, settled, state })
    process.stderr.write(`[g1] ${index + 1}/${runs} ${settled ? 'ok' : 'STUCK'} ${elapsed} ms\n`)
    if (!settled) {
      // A stuck run is the evidence, not a failure to wait longer: capture before doing
      // anything that could change the state.
      const activeRuns = await evaluate('window.scry.activeRuns()').catch((error) => ({ error: String(error) }))
      const stopped = runId ? await evaluate(`window.scry.stop(${JSON.stringify(runId)})`).catch((error) => ({ error: String(error) })) : null
      const afterStop = await evaluate('window.scry.focusedRunSnapshot()').catch(() => null)
      const evidence = {
        index, intentId, runId, elapsed, state, activeRuns, stopped, afterStop,
        ledger: ledgerFor(runId, intentId),
        timing: timingFor([runId, ...(runId ? [`remote-${runId}`] : [])]),
        daemon: daemonState(),
        appLog: log.join('').slice(-6000)
      }
      results.stuck.push(evidence)
      if (stopOnStuck) break
    }
  }
} catch (error) {
  results.error = String(error?.stack ?? error)
} finally {
  try { if (cdp) cdp.close() } catch { /* a dead socket is fine */ }
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await sleep(1_500)
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  // Keep the whole fixture when a run got stuck: the ledger and the timing file are the
  // evidence, and they cannot be reconstructed afterwards.
  if (results.stuck.length === 0 && !args.includes('--keep')) {
    rmSync(temp, { recursive: true, force: true })
    results.temp = null
  }
  results.summary = {
    started: results.runs.length,
    settled: results.runs.filter((run) => run.settled).length,
    stuck: results.stuck.length,
    elapsedP50: (() => {
      const values = results.runs.map((run) => run.elapsed).sort((a, b) => a - b)
      return values.length === 0 ? null : values[Math.floor(values.length / 2)]
    })()
  }
  const out = `/tmp/scry-g1-evidence-${Date.now()}.json`
  writeFileSync(out, `${JSON.stringify(results, null, 1)}\n`)
  process.stdout.write(`${JSON.stringify({ ...results.summary, error: results.error, evidence: out })}\n`)
}
process.exit(results.stuck.length > 0 || results.error ? 2 : 0)
