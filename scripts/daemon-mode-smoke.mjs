#!/usr/bin/env node
// M3 / S1: does the real App work when the daemon owns its runs?
//
//   npm run build && node scripts/daemon-mode-smoke.mjs
//
// One isolated userData + workspace + HOME, the packaged smoke Provider, and
// SCRY_HOST_DAEMON=1. Everything is driven through the App's own preload API from the
// renderer (window.scry), so the path exercised is exactly the shipped one: renderer ->
// typed preload -> main IPC -> daemon surface -> unix socket -> daemon -> Provider.
//
// Checks, each printed as `true`/`false` with the evidence that decided it:
//   send -> streaming text -> settled
//   question -> answer -> second question -> answer -> settled
//   stop -> cancelled
//   SIGKILL the daemon -> the App brings up a new one and a new run settles
//   first-text and streaming-update latency, in the same instance, for S1
//
// No screenshot and no DOM clicking: the runner asserts run evidence, not pixels. A
// failure exits non-zero with the step name; nothing is reported as passed unrun.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { connectCdp, createEvaluate, freePort, launch, waitForTarget } from './desktop-remote-host-smoke/harness.mjs'

const root = process.cwd()
const temp = mkdtempSync('/tmp/scry-daemon-m3-')
const userDataDir = join(temp, 'userData')
const home = join(temp, 'home')
// Inside the fixture HOME: the App only accepts a working directory it can prove is
// the user's own, so a directory outside it is refused before any run starts.
const workspace = join(home, 'workspace')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'README.md'), '# fixture\n')
// The App only accepts a working directory it can prove is the user's own; in an
// isolated userData the project list is the only place that proof can come from.
writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify([{ cwd: workspace, lastOpenedAt: 1 }]))

const log = []
const appendLog = (chunk) => { log.push(chunk); if (log.length > 4000) log.splice(0, 2000) }
const results = { mode: 'daemon', steps: {} }
let child
let cdp

const electron = process.platform === 'darwin'
  ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : join(root, 'node_modules/electron/dist/electron')

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function fail(step, detail) {
  results.steps[step] = { ok: false, detail }
  throw new Error(`${step}: ${detail}`)
}

async function until(step, evaluate, expression, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (predicate(last)) return last
    await sleep(100)
  }
  return fail(step, `timeout; last=${JSON.stringify(last)?.slice(0, 400)}`)
}

try {
  if (!existsSync(join(root, 'out/main/index.js'))) throw new Error('build first: npm run build')
  const port = await freePort()
  child = launch({
    spawn, executable: electron, devApp: true, root, port, userDataDir, home, appendLog,
    // The daemon switch, plus the daemon-side smoke fixture gate (the App-side one needs
    // a debug port, which a Node daemon does not have). The inherited host gate must be
    // off: an App that is itself the lease owner makes the daemon refuse to start
    // (`remote_lease_owner_alive`), which is correct and not what this run tests.
    env: {
      SCRY_HOST_DAEMON: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1',
      SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1', SCRY_REMOTE_HOST: '0'
    }
  })
  const target = await waitForTarget(port)
  cdp = connectCdp(target.webSocketDebuggerUrl)
  const evaluate = createEvaluate(cdp)
  await until('renderer-ready', evaluate, 'Boolean(window.scry && window.scry.start)', (ready) => ready === true)

  // The switch must actually be on: with it off the daemon never listens, so this both
  // proves the mode and gives the daemon's own state directory for the SIGKILL step.
  const daemonState = join(userDataDir, 'daemon')
  // The first call may arrive while the daemon is still starting; the App reports that
  // and asks again (see the lazy surface's unavailable rule), so waiting here is the
  // real user path, not a retry this script invents.
  await until('daemon-mode', evaluate,
    'window.scry.activeRuns().then(runs => runs.length >= 0).catch(() => false)',
    (value) => value === true, 60_000)
  results.steps.daemonAnswered = { ok: existsSync(join(daemonState, 'daemon.lock')) }

  await evaluate(`window.scry.setCwd(${JSON.stringify(workspace)})`)

  // 1. send -> streaming text -> settled
  const started = await evaluate(`window.scry.start({ prompt: 'native composer complete daemon mode fixture', providerId: 'codex', cwd: ${JSON.stringify(workspace)} })`)
  if (!started || typeof started.runId !== 'string') fail('start', JSON.stringify(started))
  results.steps.start = { ok: true, runId: started.runId }
  const firstText = await until('first-text', evaluate,
    `window.scry.focusedRunSnapshot().then(run => run && run.items.some(item => item.stage === 'text') ? Date.now() : 0)`,
    (value) => value > 0)
  results.steps.firstText = { ok: firstText > 0 }
  const settled = await until('settled', evaluate,
    `window.scry.focusedRunSnapshot().then(run => run ? { done: run.done, error: run.error ?? null, text: run.items.filter(i => i.stage === 'text').length } : null)`,
    (value) => value && value.done === true)
  results.steps.settled = { ok: settled.error === null, textEvents: settled.text }

  // 1b. streaming: a paced fixture must reach the renderer as it grows. One lump at
  // the end is what a watch that only waits on ledger events produces: the ledger does
  // not move while the Provider writes text.
  await evaluate(`(() => {
    window.__m3Stream = []
    window.scry.onTrace((events) => {
      for (const event of events) {
        if (event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta')) {
          window.__m3Stream.push({ t: Math.round(performance.now()), len: (event.text ?? '').length })
        }
      }
    })
    return true
  })()`)
  const paced = await evaluate(`window.scry.start({ prompt: 'performance paced stream', providerId: 'codex', cwd: ${JSON.stringify(workspace)} })`)
  if (!paced || typeof paced.runId !== 'string') fail('stream-start', JSON.stringify(paced))
  const streamSettled = await until('stream-settled', evaluate,
    `window.scry.focusedRunSnapshot().then(run => run && run.done ? { done: true, text: run.items.filter(i => i.stage === 'text_delta' || i.stage === 'text').reduce((sum, i) => sum + (i.text ?? '').length, 0) } : null)`,
    (value) => value && value.done === true)
  const stream = await evaluate('window.__m3Stream.slice()')
  const streamGaps = stream.slice(1).map((event, index) => event.t - stream[index].t).sort((a, b) => a - b)
  const medianGap = streamGaps.length === 0 ? 0 : streamGaps[Math.floor(streamGaps.length / 2)]
  results.steps.streaming = {
    // The fixture writes 20 chunks 150 ms apart. Fewer arrivals than that means the
    // message reached the window as fewer, larger pieces.
    ok: stream.length >= 8 && medianGap >= 80 && medianGap <= 250,
    arrivals: stream.length, medianGap, viewText: streamSettled.text
  }

  // 2. question -> answer (twice) -> settled
  // Questions arrive on their own channel, exactly as the chat view receives them; the
  // script answers with the id it was shown, like a user clicking a choice.
  await evaluate(`(() => {
    window.__m3Questions = []
    window.scry.onQuestion((request) => window.__m3Questions.push({
      runId: request.runId, questionId: request.questionId,
      question: request.questions[0].question, option: request.questions[0].options[0].label
    }))
    return true
  })()`)
  const questioned = await evaluate(`window.scry.start({ prompt: 'dock badge question smoke', providerId: 'codex', cwd: ${JSON.stringify(workspace)} })`)
  if (!questioned || typeof questioned.runId !== 'string') fail('question-start', JSON.stringify(questioned))
  for (const round of [1, 2]) {
    const question = await until(`question-${round}`, evaluate,
      'window.__m3Questions.length >= ' + round + ' ? window.__m3Questions[' + (round - 1) + '] : null',
      (value) => value !== null && value !== undefined)
    const answered = await evaluate(`window.scry.answerQuestion({
      runId: ${JSON.stringify(question.runId)}, questionId: ${JSON.stringify(question.questionId)},
      behavior: 'answered', answers: { ${JSON.stringify(question.question)}: ${JSON.stringify(question.option)} }
    }).catch((error) => String(error))`)
    if (answered !== true) fail(`answer-${round}`, JSON.stringify(answered))
    results.steps[`answer-${round}`] = { ok: true, question: question.question }
    await sleep(150)
  }
  const questionSettled = await until('question-settled', evaluate,
    `window.scry.focusedRunSnapshot().then(run => run ? { done: run.done, runId: run.runId } : null)`,
    (value) => value && value.done === true)
  results.steps.questionSettled = { ok: true, runId: questionSettled.runId }

  // 3. stop
  const stopping = await evaluate(`window.scry.start({ prompt: 'native composer stop-immediate daemon mode stop', providerId: 'codex', cwd: ${JSON.stringify(workspace)} })`)
  if (!stopping || typeof stopping.runId !== 'string') fail('stop-start', JSON.stringify(stopping))
  await until('stop-visible', evaluate,
    `window.scry.focusedRunSnapshot().then(run => Boolean(run && run.items.length > 0))`, (value) => value === true)
  const stopAccepted = await evaluate(`window.scry.stop(${JSON.stringify(stopping.runId)})`)
  const stopped = await until('stop-settled', evaluate,
    `window.scry.focusedRunSnapshot().then(run => run ? { done: run.done, stopState: run.stopState ?? null } : null)`,
    (value) => value && value.done === true)
  results.steps.stop = { ok: stopAccepted === true && stopped.done === true, stopAccepted, stopState: stopped.stopState }

  // 4. SIGKILL the daemon: the App must bring up a new one and a new run must settle.
  const lockPath = join(daemonState, 'daemon.lock')
  if (!existsSync(lockPath)) fail('daemon-lock', 'no daemon.lock before SIGKILL')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  process.kill(lock.pid, 'SIGKILL')
  results.steps.daemonKilled = { ok: true, pid: lock.pid }
  const recovered = await until('daemon-relaunched', evaluate,
    `window.scry.activeRuns().then(runs => runs.length >= 0)`,
    (value) => value === true, 60_000)
  results.steps.daemonRelaunched = { ok: recovered === true }
  const afterRestart = await evaluate(`window.scry.start({ prompt: 'native composer complete daemon mode after restart', providerId: 'codex', cwd: ${JSON.stringify(workspace)} })`)
  if (!afterRestart || typeof afterRestart.runId !== 'string') fail('after-restart-start', JSON.stringify(afterRestart))
  const restartSettled = await until('after-restart-settled', evaluate,
    `window.scry.focusedRunSnapshot().then(run => run ? { done: run.done, runId: run.runId } : null)`,
    (value) => value && value.done === true)
  results.steps.afterRestartSettled = { ok: true, runId: restartSettled.runId }
} catch (error) {
  results.error = String(error?.message ?? error)
} finally {
  try { if (cdp) cdp.close() } catch { /* closing a dead socket is fine */ }
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await sleep(1500)
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const failed = !results.error && Object.values(results.steps).some((step) => step.ok !== true)
  if (results.error || failed) {
    writeFileSync(join(root, 'daemon-mode-smoke.log'), log.join(''))
    results.log = join(root, 'daemon-mode-smoke.log')
  }
  results.cleanup = (() => { rmSync(temp, { recursive: true, force: true }); return !existsSync(temp) })()
}

process.stdout.write(`${JSON.stringify(results)}\n`)
process.exit(results.error || Object.values(results.steps).some((step) => step.ok !== true) ? 2 : 0)
