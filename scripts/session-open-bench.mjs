import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'
import { connect, freePort, startupProbe, writeSessionFixture } from './session-open-fixture.mjs'
import { measureHistory } from './session-open-history.mjs'
import { nativeCounterMetrics, probeNativeComposer } from './native-composer-probe.mjs'
import { readRecords } from './performance-report.mjs'
import { nativeBuildArtifacts, nativeDiagnosticRecords, nativeHarnessFiles, nativeWorkloads } from './performance-native.mjs'

// Production main/preload/renderer, offline fixture data, native Chromium input.
// Measures local history plus button/render/settlement acceptance, not real Provider latency.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scenario = process.argv[2] ?? 'markdown'
assert.ok(Object.hasOwn(nativeWorkloads, scenario), `Unknown scenario: ${scenario}`)
const [turnCount, sections] = nativeWorkloads[scenario]
const temp = mkdtempSync(join(tmpdir(), 'scry-session-open-'))
const iterations = 12
const hash = value => createHash('sha256').update(value).digest('hex')
const benchmarkCodeHash = () => hash(nativeHarnessFiles.map(path => readFileSync(join(root, path), 'utf8')).join('\0'))
const benchmarkSha256 = benchmarkCodeHash()
let child
let cdp
let output = ''
let lineBuffer = ''
const traces = []

function capture(chunk) {
  const text = String(chunk)
  output += text
  lineBuffer += text
  const lines = lineBuffer.split('\n')
  lineBuffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.includes('[scry:perf]')) traces.push(JSON.parse(line.slice(line.indexOf('{'))))
  }
}

const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]

try {
  const { sha256: artifactSha256, files: artifactFiles } = nativeBuildArtifacts(root)
  const { userData, home, cwd, sessions, bootstrap } = writeSessionFixture(root, temp, turnCount, sections)
  const port = await freePort()
  const launchStarted = performance.now()
  child = spawn(electron, [bootstrap, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
    env: { ...process.env, HOME: home, SCRY_TEST_APP: '1', SCRY_PERF_LOG: '1', ELECTRON_ENABLE_LOGGING: '1',
      SCRY_ELECTRON_SMOKE_PROVIDER: '1', SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi', SCRY_REMOTE_HOST: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  cdp = await connect(port)
  await cdp.send('Runtime.enable')
  await cdp.send('Performance.enable')
  const evaluate = async expression => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const metricValues = snapshot => Object.fromEntries((snapshot.metrics ?? []).map(entry => [entry.name, entry.value]))
  let lastCounterMetrics
  const beginCounters = async () => {
    const mutationMark = await evaluate('window.__nativeWorkCounterMark()')
    const metrics = await cdp.send('Performance.getMetrics')
    return { mutationMark, metrics }
  }
  const endCounters = async start => {
    const mutationMark = await evaluate('window.__nativeWorkCounterMark()')
    const metrics = await cdp.send('Performance.getMetrics')
    const before = metricValues(start.metrics)
    const after = metricValues(metrics)
    lastCounterMetrics = after
    return Object.fromEntries(nativeCounterMetrics.map(name => {
      if (name === 'DOMMutations') return [name, mutationMark - start.mutationMark]
      assert.ok(Object.hasOwn(before, name) && Object.hasOwn(after, name), `CDP Performance metric unavailable: ${name}`)
      const delta = Math.round(after[name] - before[name])
      // Monotonic counters cannot shrink; a negative delta means the counter reset (e.g. a new
      // document), which would make this sample meaningless rather than zero work.
      assert.ok(delta >= 0, `CDP Performance metric decreased: ${name} ${before[name]} -> ${after[name]}`)
      return [name, delta]
    }))
  }
  const wait = expression => evaluate(`(async () => {
    const deadline = performance.now() + 15000
    while (!(${expression})) {
      if (performance.now() > deadline) throw new Error('UI condition timed out: ' + ${JSON.stringify(expression)} + '\\n' + JSON.stringify({
        busy: document.querySelector('.chat-transcript')?.getAttribute('aria-busy'),
        turns: document.querySelectorAll('.transcript-turn').length,
        text: document.querySelector('.chat-transcript')?.textContent.slice(-2000),
        textarea: document.querySelector('textarea')?.outerHTML,
        errors: document.querySelector('.composer-error')?.textContent,
        body: document.body.innerText.slice(-3000)
      }))
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  const click = async selectorExpression => {
    const point = await evaluate(`(() => {
      const element = ${selectorExpression}
      if (!element) throw new Error('Native click target missing')
      const rect = element.getBoundingClientRect()
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      if (!element.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Native click target obscured')
      return point
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  await evaluate(`(() => {
    let mutationCount = 0
    const observer = new MutationObserver(records => { mutationCount += records.length })
    observer.observe(document, { childList: true, attributes: true, characterData: true, subtree: true })
    window.__nativeWorkCounterMark = () => {
      mutationCount += observer.takeRecords().length
      return mutationCount
    }
  })()`)
  await wait(`document.querySelectorAll('button.sb-sess').length === 2 && typeof window.scry === 'object'`)
  const sensitivityBaseStart = await beginCounters()
  const sensitivityBase = await endCounters(sensitivityBaseStart)
  const sensitivityExtraStart = await beginCounters()
  // Calibrate the same mutation counter within one renderer task. Separate CDP
  // windows include unrelated startup work and cannot be ordered by workload.
  const mutationControl = await evaluate(`(() => {
    const before = window.__nativeWorkCounterMark()
    const idle = window.__nativeWorkCounterMark()
    const probe = document.createElement('div')
    probe.style.cssText = 'position: fixed; width: 13px; height: 11px; contain: layout;'
    document.body.append(probe)
    probe.getBoundingClientRect()
    probe.remove()
    return { baseline: idle - before, extra: window.__nativeWorkCounterMark() - idle }
  })()`)
  const sensitivityExtra = await endCounters(sensitivityExtraStart)
  const sensitivityRaised = mutationControl.baseline === 0 && mutationControl.extra === 2
  assert.equal(sensitivityRaised, true, `native mutation counter must detect both controlled mutations: ${JSON.stringify(mutationControl)}`)
  assert.deepEqual(await evaluate('window.scry.detectFast().then(items => items.map(item => ({ id: item.id, name: item.name })))'),
    [{ id: 'codex', name: 'codex Smoke Fixture' }], 'refusing any lifecycle measurement without the offline fixture adapter')
  // Composer readiness plus two excluded opens separates startup from the warm path.
  await wait(`document.querySelector('textarea') != null`)
  const startupDriverReadyMs = performance.now() - launchStarted
  const { samples, firstOpens, nativeInput, loads } = await measureHistory({
    evaluate, wait, click, cdp, beginCounters, endCounters, metricValues, lastMetrics: () => lastCounterMetrics,
    sessions, iterations, turnCount, sections, cwd, traces
  })
  const composerSamples = await probeNativeComposer({ evaluate, wait, click, beginCounters, endCounters, send: (method, params) => cdp.send(method, params) })

  // Real main/preload/SQLite/archive lifecycle with an explicit offline Provider fixture.
  // These are IPC/terminal/disk boundaries, NOT native send-button or visible-output timings.
  const lifecycleSamples = []
  for (const stopped of [false, true, false, true, false, true]) {
    const result = await evaluate(`(async () => {
      const cwd = ${JSON.stringify(cwd)}
      const stopped = ${stopped}
      const prompt = stopped ? 'performance long stream' : 'desktop remote performance'
      let firstTextAt, resolveFirst, resolveDone, rejectFailure
      const firstText = new Promise(resolve => { resolveFirst = resolve })
      const terminal = new Promise(resolve => { resolveDone = resolve })
      const failure = new Promise((_, reject) => { rejectFailure = reject })
      const timer = setTimeout(() => rejectFailure(new Error('native lifecycle terminal deadline exceeded')), 15000)
      const offTrace = window.scry.onTrace(events => {
        if (firstTextAt === undefined && events.some(event => event.kind === 'model' && ['text', 'text_delta'].includes(event.stage))) {
          firstTextAt = performance.now(); resolveFirst()
        }
      })
      const offDone = window.scry.onTurnDone(event => resolveDone({ event, at: performance.now() }))
      const offError = window.scry.onError(event => rejectFailure(new Error(event.message)))
      try {
        return await Promise.race([failure, (async () => {
          const startedAt = performance.now()
          const started = await window.scry.start({ providerId: 'codex', cwd, prompt })
          const receiptAt = performance.now()
          await window.scry.focusRun(started.runId)
          await firstText
          let stopRequestedAt, stopReceiptMs
          if (stopped) {
            stopRequestedAt = performance.now()
            if (await window.scry.stop(started.runId) !== true) throw new Error('stop was not accepted')
            stopReceiptMs = performance.now() - stopRequestedAt
          }
          const { event: done, at: terminalAt } = await terminal
          if (done.runId !== started.runId || Boolean(done.stopped) !== stopped) throw new Error('wrong terminal identity/outcome')
          const externalSessionId = done.externalSessionId || done.sessionId
          const page = await window.scry.loadSession({ providerId: 'codex', cwd, externalSessionId })
          const archiveReadableAt = performance.now()
          const turn = page.turns.find(turn => turn.runId === started.runId)
          if (!turn?.done || turn.userText !== prompt) throw new Error('terminal turn not durably readable')
          if (!stopped && !turn.items.some(item => item.text === 'isolated remote assistant evidence')) throw new Error('archive lost full assistant output')
          if ((await window.scry.activeRuns()).some(run => run.runId === started.runId)) throw new Error('run did not settle')
          return { runId: started.runId, stopped, startedAtEpochMs: performance.timeOrigin + startedAt,
            terminalAtEpochMs: performance.timeOrigin + terminalAt,
            ...(stopped ? { stopRequestedAtEpochMs: performance.timeOrigin + stopRequestedAt } : {}),
            startReceiptMs: receiptAt - startedAt, firstOutputReceiptMs: firstTextAt - startedAt,
            startToTerminalMs: terminalAt - startedAt, terminalToReadableArchiveMs: archiveReadableAt - terminalAt,
            ...(stopped ? { stopReceiptMs, stopToTerminalMs: terminalAt - stopRequestedAt } : {}),
            durableTurns: 1, terminalConfirmed: true }
        })()])
      } finally { clearTimeout(timer); offTrace(); offDone(); offError() }
    })()`)
    lifecycleSamples.push(result)
  }
  const sqliteStats = await evaluate(`(async () => {
    const started = performance.now()
    const stats = await window.scry.stats()
    return { status: stats.status, turns: stats.totals.turns, readMs: performance.now() - started }
  })()`)
  assert.equal(sqliteStats.status, 'ready', 'SQLite analytics must be available, not silently degraded')
  assert.ok(sqliteStats.turns >= 3, 'SQLite must contain the completed controlled turns')
  const closing = child
  child = null
  // Cleanup owns its TERM/KILL sequence. An unknown result must not trigger a
  // second signal sequence in finally or mask the first failure's evidence.
  const cleanup = await stopOwnedApp(closing)
  // Independent disk read after process exit: an in-memory/cached session cannot satisfy this proof.
  const archiveRoot = join(userData, 'trace-archive-turns-v1')
  const persistedTurns = readdirSync(archiveRoot, { recursive: true }).filter(path => path.endsWith('.json')).flatMap(path => {
    const archive = JSON.parse(readFileSync(join(archiveRoot, path), 'utf8'))
    return archive.version === 3 && Array.isArray(archive.turns) ? archive.turns.filter(turn => Array.isArray(turn.items)) : []
  })
  for (const sample of lifecycleSamples) {
    const turn = persistedTurns.find(turn => turn.runId === sample.runId)
    assert.equal(turn?.done, true, 'completed run must survive process exit on disk')
    if (!sample.stopped) assert.ok(turn.items.some(item => item.text === 'isolated remote assistant evidence'), 'disk archive lost assistant output')
    sample.diskVerified = true
  }
  for (const sample of composerSamples) {
    const turn = persistedTurns.find(turn => turn.runId === sample.runId)
    assert.equal(turn?.done, true, 'native button run must survive App exit')
    assert.equal(turn.userText, sample.prompt)
    if (sample.mode !== 'stop-immediate') assert.ok(turn.items.some(item => item.text === `Visible reply: ${sample.prompt}`), 'visible assistant output must also persist')
    sample.nativeTurnKnown = typeof turn.providerTurnId === 'string'
    assert.equal(sample.nativeTurnKnown, sample.mode !== 'stop-immediate', 'fixture native-turn phase must survive archiving')
    sample.diskVerified = true
  }
  let localRecording = null
  if (process.env.SCRY_PERF_RECORD !== '0') {
    const { records, issues } = await readRecords(join(userData, 'performance'))
    assert.equal(issues.length, 0, 'journal must contain parseable records')
    assert.ok(records.every(record => /^[a-f0-9]{64}$/.test(record.build)), 'records identify the compiled source snapshot')
    assert.ok(records.some(record => record.observation.kind === 'trace' && record.observation.sample.name === 'ipc.agent:loadSession'), 'real App writes trusted-handler observations')
    assert.ok(records.some(record => record.observation.kind === 'trace' && record.observation.sample.name === 'session_history.load' && record.observation.sample.outcome === 'error'), 'rejected history must not disappear from its named trace')
    assert.ok(records.some(record => record.observation.kind === 'health'), 'normal shutdown flushes recording health')
    localRecording = { records: records.length, builds: [...new Set(records.map(record => record.build))], rejectedHistoryRecorded: true,
      diagnostics: nativeDiagnosticRecords(records) }
  }
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(nativeBuildArtifacts(root).sha256, artifactSha256, 'build artifacts changed during measurement')
  assert.equal(benchmarkCodeHash(), benchmarkSha256, 'benchmark changed during measurement')
  console.log(JSON.stringify({ measurementVersion: 7, startupDriverReadyMs, nativeInput, composerSamples, lifecycleSamples, sqliteStats, artifactSha256, artifactFiles, benchmarkSha256, scenario, turnCount, sections, warmups: 2, iterations, firstOpens,
    counterSensitivity: { baseline: sensitivityBase, extra: sensitivityExtra, mutationControl, passed: sensitivityRaised },
    version: packageJson.version ?? null, platform: `${process.platform}/${process.arch}`, node: process.version,
    electron: JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version,
    samples, medianOpenMs: percentile(samples.map(sample => sample.openMs), 0.5),
    medianScriptMs: percentile(samples.map(sample => sample.scriptMs), 0.5),
    medianNativeOpenMs: percentile(samples.map(sample => sample.nativeOpenMs), 0.5),
    medianFirstContentMs: percentile(samples.map(sample => sample.firstContentMs), 0.5),
    cacheObservedOpens: samples.filter(sample => sample.cacheObserved).length,
    mainLoads: loads, correctness: ['full initial page', 'latest turn visible', 'native typing', 'older turn recovery',
      'pagination preserves total', 'rapid selection isolates history', 'draft retained across selections'],
    // Existing main-process traces distinguish finalization work from renderer receipt delays.
    // Preserve them on successful runs too; failed comparisons previously lost this evidence.
    lifecycleTraces: traces.filter(sample => sample.name.startsWith('agent.') || ['app.startup', 'ipc.agent:start', 'ipc.agent:stop'].includes(sample.name)),
    cleanup, localRecording }, null, 2))
} catch (error) {
  // Preserve the original failure before cleanup; a cleanup error must not erase it.
  console.error('SCRY_NATIVE_FAILURE', JSON.stringify({ failure: String(error).slice(0, 500), startup: startupProbe, app: inspectOwnedApp(child) }))
  console.error(output)
  throw error
} finally {
  cdp?.close()
  if (child) await stopOwnedApp(child)
  rmSync(temp, { recursive: true, force: true })
}
