import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { measureNativeSessionOpen } from './session-open-timing.mjs'

// Production main/preload/renderer, offline fixture data, native Chromium input.
// This measures local history opening, not Provider latency or production p75.
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
const benchmarkCodeHash = () => hash(`${readFileSync(fileURLToPath(import.meta.url), 'utf8')}\0${measureNativeSessionOpen.toString()}`)
const benchmarkSha256 = benchmarkCodeHash()
let child
let cdp
let output = ''
let lineBuffer = ''
const traces = []

function capture(chunk) {
  const text = String(chunk)
  output = (output + text).slice(-12_000)
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
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
      page = targets.find(target => target.type === 'page' && target.title === 'Scry' && target.webSocketDebuggerUrl)
    } catch { /* Startup has not exposed the local debug endpoint yet. */ }
    if (!page) await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert.ok(page, `App startup timed out\n${output}`)
  assert.match(page.url, /^file:/)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolveReady, reject) => { socket.onopen = resolveReady; socket.onerror = reject })
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
  const port = await freePort()
  child = spawn(electron, [root, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
    env: { ...process.env, HOME: home, SCRY_TEST_APP: '1', SCRY_PERF_LOG: '1',
      SCRY_DISABLED_PROVIDERS: 'claude,codex,qoder,opencode,pi', SCRY_REMOTE_HOST: '0' },
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
  // Composer readiness plus two excluded opens separates startup from the warm path.
  await wait(`document.querySelector('textarea') != null`)
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
    await evaluate(`window.__sessionOpenStarted = performance.now()`)
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
      const legacyEndAt = performance.now()
      return { openMs: legacyEndAt - window.__sessionOpenStarted,
        legacyStartAt: window.__sessionOpenStarted, legacyEndAt,
        mountedTurns: document.querySelectorAll('.transcript-turn:not([data-virtualized])').length,
        totalTurns: document.querySelectorAll('.transcript-turn').length,
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
    const metricsAfter = await cdp.send('Performance.getMetrics')
    const metric = (snapshot, name) => snapshot.metrics.find(value => value.name === name).value
    sample.scriptMs = (metric(metricsAfter, 'ScriptDuration') - metric(metricsBefore, 'ScriptDuration')) * 1000
    if (index >= 2) samples.push(sample)
    else firstOpens.push(sample)
  }
  // Adjacent paths: native typing, offscreen history recovery and scroll-back.
  await click(`document.querySelector('textarea')`)
  await cdp.send('Input.insertText', { text: 'draft stays editable' })
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
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(builtArtifactHash(), artifactSha256, 'build artifacts changed during measurement')
  assert.equal(benchmarkCodeHash(), benchmarkSha256, 'benchmark changed during measurement')
  console.log(JSON.stringify({ measurementVersion: 2, artifactSha256, benchmarkSha256, scenario, turnCount, sections, warmups: 2, iterations, firstOpens,
    version: packageJson.version ?? null, platform: `${process.platform}/${process.arch}`, node: process.version,
    electron: JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version,
    samples, medianOpenMs: percentile(samples.map(sample => sample.openMs), 0.5),
    medianScriptMs: percentile(samples.map(sample => sample.scriptMs), 0.5),
    medianNativeOpenMs: percentile(samples.map(sample => sample.nativeOpenMs), 0.5),
    mainLoads: loads, correctness: ['full initial page', 'latest turn visible', 'native typing', 'older turn recovery',
      'pagination preserves total', 'rapid selection isolates history', 'draft retained across selections'],
    cleanup: await stopOwnedApp(child) }, null, 2))
  child = null
} catch (error) {
  console.error(output)
  throw error
} finally {
  cdp?.close()
  if (child) await stopOwnedApp(child)
  rmSync(temp, { recursive: true, force: true })
}
