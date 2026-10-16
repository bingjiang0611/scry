import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'
import { measureNativeSessionOpen } from './session-open-timing.mjs'
import { probeNativeComposer } from './native-composer-probe.mjs'
import { readRecords } from './performance-report.mjs'

// Production main/preload/renderer, offline fixture data, native Chromium input.
// Measures local history plus button/render/settlement acceptance, not real Provider latency.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scenarios = {
  markdown: { turnCount: 40, sections: 32 },
  short: { turnCount: 20, sections: 1 },
  'short-heavy': { turnCount: 20, sections: 32 },
  paged: { turnCount: 120, sections: 2 }
}
const scenario = process.argv[2] ?? 'markdown'
assert.ok(Object.hasOwn(scenarios, scenario), `Unknown scenario: ${scenario}`)
const { turnCount, sections } = scenarios[scenario]
const pageTurns = Math.min(40, turnCount)
const latestIndex = turnCount - 1
const temp = mkdtempSync(join(tmpdir(), 'scry-session-open-'))
const iterations = 12
const hash = value => createHash('sha256').update(value).digest('hex')
const benchmarkCodeHash = () => hash(`${readFileSync(fileURLToPath(import.meta.url), 'utf8')}\0${measureNativeSessionOpen.toString()}\0${readFileSync(join(root, 'scripts/native-composer-probe.mjs'), 'utf8')}`)
const benchmarkSha256 = benchmarkCodeHash()
let child
let cdp
let output = ''
let lineBuffer = ''
let startupProbe = { phase: 'not-started', attempts: 0 }
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

async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveReady))
  const { port } = server.address()
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

async function connect(port) {
  const deadline = Date.now() + 30_000
  let page
  while (!page && Date.now() < deadline) {
    startupProbe = { phase: 'http-request', attempts: startupProbe.attempts + 1, port }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      startupProbe.httpStatus = response.status
      const targets = await response.json()
      startupProbe.targets = targets.slice(0, 8).map(({ type, title, url }) => ({ type, title, url: url?.slice(0, 512) }))
      startupProbe.targetsTruncated = targets.length > 8
      page = targets.find(target => target.type === 'page' && target.title === 'Scry' && target.webSocketDebuggerUrl)
      startupProbe.phase = page ? 'page-found' : 'waiting-for-page'
    } catch (error) {
      startupProbe.phase = 'probe-failed'
      startupProbe.error = String(error)
      startupProbe.cause = error.cause ? String(error.cause) : undefined
    }
    if (!page) await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert.ok(page, 'App startup timed out')
  assert.match(page.url, /^file:/)
  startupProbe.phase = 'websocket-connect'
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolveReady, reject) => { socket.onopen = resolveReady; socket.onerror = reject })
  startupProbe.phase = 'debug-connected'
  socket.onmessage = message => {
    const payload = JSON.parse(String(message.data))
    const request = pending.get(payload.id)
    if (!request) return
    pending.delete(payload.id)
    if (payload.error) request.reject(new Error(payload.error.message))
    else request.resolve(payload.result)
  }
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error('App debug connection closed'))
    pending.clear()
  }
  return {
    send(method, params = {}) {
      const id = nextId++
      const result = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close() { socket.close() }
  }
}

const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]

function builtArtifactHash() {
  const artifactDir = join(root, 'out')
  const digest = createHash('sha256')
  for (const path of readdirSync(artifactDir, { recursive: true }).sort()) {
    if (statSync(join(artifactDir, path)).isFile()) digest.update(`${path}\0${hash(readFileSync(join(artifactDir, path)))}\n`)
  }
  return digest.digest('hex')
}

try {
  const artifactSha256 = builtArtifactHash()
  const userData = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspace = join(home, 'workspace')
  for (const path of [userData, home, workspace]) mkdirSync(path, { recursive: true })
  const cwd = realpathSync(workspace)
  const sessions = ['open-bench-a', 'open-bench-b']
  const catalog = []
  for (const sessionId of sessions) {
    const turns = Array.from({ length: turnCount }, (_, index) => {
      const body = Array.from({ length: sections }, (_, line) =>
        `### Section ${line}\n\nA **measured** history paragraph with [a link](https://example.com).\n\n- item one\n- item two\n\n\`\`\`ts\nconst value${line} = ${line}\n\`\`\`\n`).join('\n')
      return {
        runId: `${sessionId}-turn-${index}`, userText: `${sessionId} prompt ${index}`, done: true,
        ts: 1_700_000_000_000 + index,
        items: [{ id: `${sessionId}-text-${index}`, runId: `${sessionId}-turn-${index}`,
          ts: '2023-11-14T22:13:20.000Z', kind: 'model', stage: 'text', text: `${body}\nEND ${sessionId} ${index}` }]
      }
    })
    const archiveDir = join(userData, 'trace-archives-v2', 'codex', `cwd-${hash(cwd)}`)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, `sid-${hash(sessionId)}.json`), JSON.stringify({
      version: 3, cwd, sessionId, providerId: 'codex', runtimeProvider: 'codex_cli', turns
    }))
    catalog.push({ sessionId, externalSessionId: sessionId, runId: turns.at(-1).runId,
      providerId: 'codex', runtimeProvider: 'codex_cli', cwd, preview: sessionId, ts: turns.at(-1).ts })
  }
  writeFileSync(join(userData, 'app-sessions.json'), JSON.stringify(catalog))
  const bootstrap = join(temp, 'app')
  mkdirSync(bootstrap)
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(bootstrap, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'main.cjs' }))
  writeFileSync(join(bootstrap, 'main.cjs'), `
    const { app } = require('electron');
    const mark = (phase, detail = {}) => process.stderr.write('[scry:native-startup] ' + JSON.stringify({ phase, pid: process.pid, atMs: performance.now(), ...detail }) + '\\n');
    mark('bootstrap', { ready: app.isReady() });
    app.once('ready', () => mark('app-ready'));
    app.on('browser-window-created', (_event, win) => {
      mark('window-created', { windowId: win.id });
      win.webContents.once('did-finish-load', () => mark('renderer-loaded', { windowId: win.id }));
      win.webContents.on('did-fail-load', (_event, code, description) => mark('renderer-load-failed', { code, description }));
    });
    app.setAppPath(${JSON.stringify(root)});
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    require(${JSON.stringify(join(root, metadata.main))});
    mark('main-loaded');
  `)
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
  await wait(`document.querySelectorAll('button.sb-sess').length === 2 && typeof window.scry === 'object'`)
  assert.deepEqual(await evaluate('window.scry.detectFast().then(items => items.map(item => ({ id: item.id, name: item.name })))'),
    [{ id: 'codex', name: 'Codex Smoke Fixture' }], 'refusing any lifecycle measurement without the offline fixture adapter')
  // Composer readiness plus two excluded opens separates startup from the warm path.
  await wait(`document.querySelector('textarea') != null`)
  const startupDriverReadyMs = performance.now() - launchStarted
  const samples = []
  const firstOpens = []
  for (let index = 0; index < iterations + 2; index++) {
    const sessionId = sessions[index % sessions.length]
    const metricsBefore = await cdp.send('Performance.getMetrics')
    await evaluate(`(() => {
      window.__sessionNativeTiming = (${measureNativeSessionOpen.toString()})(
        Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(sessionId)})),
        () => {
          const scroller = document.querySelector('.chat-transcript[aria-busy="false"]')
          const last = document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]')
          const input = document.querySelector('textarea')
          if (!scroller || !last?.textContent.includes('END ${sessionId} ${latestIndex}') || !input || input.disabled || input.readOnly) return false
          const rect = last.getBoundingClientRect()
          const viewport = scroller.getBoundingClientRect()
          return rect.bottom >= viewport.top && rect.top <= viewport.bottom
        }
      )
    })()`)
    await evaluate(`(() => {
      window.__sessionOpenStarted = performance.now();
      window.__sessionFirstContent = null;
      window.__sessionCacheObserved = false;
      const inspect = () => {
        const last = document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]');
        if (!last?.textContent.includes('END ${sessionId} ${latestIndex}')) return;
        window.__sessionCacheObserved ||= document.querySelector('.chat-transcript')?.getAttribute('aria-busy') === 'true';
        requestAnimationFrame(() => {
          if (window.__sessionFirstContent != null || !last.isConnected) return;
          const rect = last.getBoundingClientRect();
          const viewport = document.querySelector('.chat-transcript').getBoundingClientRect();
          if (rect.bottom >= viewport.top && rect.top <= viewport.bottom) {
            window.__sessionFirstContent = performance.now() - window.__sessionOpenStarted;
          }
        });
      };
      window.__sessionOpenObserver = new MutationObserver(inspect);
      window.__sessionOpenObserver.observe(document.querySelector('.chat-transcript'), { childList: true, characterData: true, subtree: true });
    })()`)
    await click(`Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(sessionId)}))`)
    await wait(`document.querySelector('.chat-transcript[aria-busy="false"]') &&
      document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]')?.textContent.includes('END ${sessionId} ${latestIndex}') &&
      document.querySelector('textarea') && !document.querySelector('textarea').disabled && !document.querySelector('textarea').readOnly`)
    const sample = await evaluate(`(() => {
      const scroller = document.querySelector('.chat-transcript')
      const last = document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]')
      const rect = last.getBoundingClientRect()
      const viewport = scroller.getBoundingClientRect()
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) throw new Error('Latest turn not in viewport')
      window.__sessionOpenObserver.disconnect();
      if (window.__sessionFirstContent == null) throw new Error('First matching timeline layout was not observed');
      const legacyEndAt = performance.now()
      return { openMs: legacyEndAt - window.__sessionOpenStarted,
        legacyStartAt: window.__sessionOpenStarted, legacyEndAt,
        firstContentMs: window.__sessionFirstContent, cacheObserved: window.__sessionCacheObserved,
        mountedTurns: document.querySelectorAll('.transcript-turn:not([data-virtualized])').length,
        totalTurns: document.querySelectorAll('.transcript-turn').length,
        completeParagraphs: (document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]').textContent.match(/A measured history paragraph with a link\\./g) || []).length,
        domNodes: scroller.querySelectorAll('*').length }
    })()`)
    const native = await evaluate('window.__sessionNativeTiming')
    assert.equal(native.trustedClick, true, 'measurement must originate from a native browser click')
    assert.ok(native.nativeOpenMs >= 0 && native.handlerDelayMs >= 0, 'native timestamps must use the renderer clock')
    sample.nativeOpenMs = native.nativeOpenMs
    sample.handlerDelayMs = native.handlerDelayMs
    sample.driverBeforeClickMs = native.clickAt - sample.legacyStartAt
    // Signed: a negative value means the old readback preceded two stable visible frames.
    sample.legacyReadbackLagMs = sample.legacyEndAt - native.readyAt
    delete sample.legacyStartAt
    delete sample.legacyEndAt
    assert.equal(sample.totalTurns, pageTurns, 'history must retain every turn in the initial page')
    assert.equal(sample.completeParagraphs, sections, 'renderer must not trade away fixed paragraph content for speed')
    const metricsAfter = await cdp.send('Performance.getMetrics')
    const metric = (snapshot, name) => snapshot.metrics.find(value => value.name === name).value
    sample.scriptMs = (metric(metricsAfter, 'ScriptDuration') - metric(metricsBefore, 'ScriptDuration')) * 1000
    if (index >= 2) samples.push(sample)
    else firstOpens.push(sample)
  }
  // Adjacent paths: native typing, offscreen history recovery and scroll-back.
  await click(`document.querySelector('textarea')`)
  await evaluate(`window.__nativeInputFrame = new Promise(resolve => {
    document.querySelector('textarea').addEventListener('input', event => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ trusted: event.isTrusted, frameReadyMs: performance.now() - event.timeStamp })))
    }, { once: true })
  }); true`)
  await cdp.send('Input.insertText', { text: 'draft stays editable' })
  const nativeInput = await evaluate('window.__nativeInputFrame')
  assert.equal(nativeInput.trusted, true)
  assert.ok(nativeInput.frameReadyMs >= 0)
  assert.equal(await evaluate(`document.querySelector('textarea').value`), 'draft stays editable')
  const currentSession = sessions[(iterations + 1) % 2]
  for (let loaded = pageTurns; loaded < turnCount; loaded += 40) {
    await evaluate(`document.querySelector('.chat-transcript').scrollTop = 0`)
    await wait(`document.querySelector('.history-window-more') && !document.querySelector('.history-window-more').disabled`)
    await click(`document.querySelector('.history-window-more')`)
    await wait(`document.querySelectorAll('.transcript-turn').length === ${Math.min(loaded + 40, turnCount)}`)
  }
  await evaluate(`document.querySelector('.chat-transcript').scrollTop = 0`)
  await wait(`document.querySelector('[data-run-id="${currentSession}-turn-0"]')?.textContent.includes('END ${currentSession} 0')`)
  await evaluate(`(() => { const scroller = document.querySelector('.chat-transcript'); scroller.scrollTop = scroller.scrollHeight })()`)
  await wait(`document.querySelector('[data-run-id="${currentSession}-turn-${latestIndex}"]')?.textContent.includes('END ${currentSession} ${latestIndex}')`)
  assert.equal(await evaluate(`document.querySelector('textarea').value`), 'draft stays editable')
  const loads = traces.filter(trace => trace.name === 'session_history.load')
  assert.equal(loads.length, iterations + 2, 'every measured open must have a main-process trace')
  assert.ok(loads.every(load => load.counters.returnedTurns === pageTurns), 'main must return the full initial page')
  const context = { providerId: 'codex', cwd, externalSessionId: currentSession }
  const history = await evaluate(`window.scry.loadSession(${JSON.stringify(context)})`)
  assert.equal(history.totalTurns, turnCount)
  assert.equal(history.turns.length, pageTurns)
  assert.equal(history.hasOlder, turnCount > pageTurns)
  // Dispatch two native selections without waiting between them. A superseded read
  // must never replace the second selection or mix another session into its page.
  for (const sessionId of sessions) {
    await click(`Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes(${JSON.stringify(sessionId)}))`)
  }
  await wait(`document.querySelector('.chat-transcript[aria-busy="false"]') &&
    document.querySelector('[data-run-id="${currentSession}-turn-${latestIndex}"]')?.textContent.includes('END ${currentSession} ${latestIndex}')`)
  const displayedIds = await evaluate(`Array.from(document.querySelectorAll('.transcript-turn')).map(element => element.dataset.runId)`)
  assert.ok(displayedIds.every(id => id.startsWith(currentSession + '-turn-')), 'stale selection must not replace current history')
  assert.equal(await evaluate(`document.querySelector('textarea').value`), 'draft stays editable')
  const invalidHistory = await evaluate(`window.scry.loadSession(${JSON.stringify({ ...context, externalSessionId: 'missing-perf-fixture' })}).then(() => false, () => true)`)
  assert.equal(invalidHistory, true, 'fixture must exercise a real rejected history handler')
  const composerSamples = await probeNativeComposer({ evaluate, wait, click, send: (method, params) => cdp.send(method, params) })

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
          return { runId: started.runId, stopped, startReceiptMs: receiptAt - startedAt, firstOutputReceiptMs: firstTextAt - startedAt,
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
    localRecording = { records: records.length, builds: [...new Set(records.map(record => record.build))], rejectedHistoryRecorded: true }
  }
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(builtArtifactHash(), artifactSha256, 'build artifacts changed during measurement')
  assert.equal(benchmarkCodeHash(), benchmarkSha256, 'benchmark changed during measurement')
  console.log(JSON.stringify({ measurementVersion: 5, startupDriverReadyMs, nativeInput, composerSamples, lifecycleSamples, sqliteStats, artifactSha256, benchmarkSha256, scenario, turnCount, sections, warmups: 2, iterations, firstOpens,
    version: packageJson.version ?? null, platform: `${process.platform}/${process.arch}`, node: process.version,
    electron: JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version,
    samples, medianOpenMs: percentile(samples.map(sample => sample.openMs), 0.5),
    medianScriptMs: percentile(samples.map(sample => sample.scriptMs), 0.5),
    medianNativeOpenMs: percentile(samples.map(sample => sample.nativeOpenMs), 0.5),
    medianFirstContentMs: percentile(samples.map(sample => sample.firstContentMs), 0.5),
    cacheObservedOpens: samples.filter(sample => sample.cacheObserved).length,
    mainLoads: loads, correctness: ['full initial page', 'latest turn visible', 'native typing', 'older turn recovery',
      'pagination preserves total', 'rapid selection isolates history', 'draft retained across selections'],
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
