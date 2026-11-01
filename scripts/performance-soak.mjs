import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultPackagedAppPath, packagedAppLayout } from './packaged-app-layout.mjs'

const requestedCycles = process.env.SCRY_SOAK_CYCLES === undefined ? null : Number(process.env.SCRY_SOAK_CYCLES)
const cycleLimit = requestedCycles !== null && Number.isSafeInteger(requestedCycles) && requestedCycles > 0 ? requestedCycles : null
const durationMs = Math.max(10_000, Number(process.env.SCRY_SOAK_DURATION_MS ?? 60_000))
const cycleDelayMs = Math.max(25, Number(process.env.SCRY_SOAK_CYCLE_DELAY_MS ?? 250))
// SCRY_SOAK_CYCLES makes short counter runs possible; SCRY_SOAK_LEAK_FIXTURE=1 is sensitivity-only.
const leakFixture = process.env.SCRY_SOAK_LEAK_FIXTURE === '1'
const layout = packagedAppLayout(resolve(process.argv[2] || defaultPackagedAppPath()))
const executable = layout.executable
const temp = mkdtempSync(join(tmpdir(), 'scry-performance-soak-'))
let child
let output = ''
let lineBuffer = ''
const resourceSamples = []
const rendererSamples = []
const mainPerformanceSamples = []

function captureOutput(chunk) {
  const text = String(chunk)
  output = `${output}${text}`.slice(-12_000)
  lineBuffer += text
  const lines = lineBuffer.split('\n')
  lineBuffer = lines.pop() ?? ''
  for (const line of lines) {
    const target = line.includes('[scry:resource]')
      ? resourceSamples
      : line.includes('[scry:renderer-perf]')
        ? rendererSamples
        : line.includes('[scry:perf]') ? mainPerformanceSamples : null
    if (!target) continue
    try {
      target.push(JSON.parse(line.slice(line.indexOf('{'))))
      if (target.length > 1_000) target.splice(0, target.length - 1_000)
    } catch { /* Keep the diagnostic tail; malformed logging is reported by missing samples. */ }
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveReady))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

async function waitForTarget(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* Electron is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`等待 Electron CDP target 超时\n${output.slice(-4_000)}`)
}

function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((resolveReady, reject) => {
    socket.onopen = resolveReady
    socket.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
  })
  socket.onmessage = (message) => {
    const payload = JSON.parse(String(message.data))
    const request = pending.get(payload.id)
    if (!request) return
    pending.delete(payload.id)
    if (payload.error) request.reject(new Error(payload.error.message))
    else request.resolve(payload.result)
  }
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error('CDP WebSocket 已关闭'))
    pending.clear()
  }
  return {
    async send(method, params = {}) {
      await ready
      const id = nextId++
      const response = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return response
    },
    close() { socket.close() }
  }
}

const percentile = (values, quantile) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]
}
const median = (values) => percentile(values, 0.5)

async function main() {
  const port = await freePort()
  const userDataDir = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  for (const dir of [userDataDir, home, workspace]) mkdirSync(dir, { recursive: true })
  const canonicalWorkspace = realpathSync(workspace)
  // Seed one owned catalog entry so setCwd exercises the normal authorization path without a
  // native folder picker or any user workspace.
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'soak-seed',
    runId: 'soak-seed',
    providerId: 'codex',
    runtimeProvider: 'codex_cli',
    cwd: canonicalWorkspace,
    preview: 'performance soak fixture',
    ts: Date.now()
  }]))

  child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run'
  ], {
    env: {
      ...process.env,
      HOME: home,
      ELECTRON_ENABLE_LOGGING: '1',
      SCRY_TEST_APP: '1',
      SCRY_ELECTRON_SMOKE_PROVIDER: '1',
      SCRY_PERF_LOG: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', captureOutput)
  child.stderr.on('data', captureOutput)

  const page = await waitForTarget(port)
  const cdp = connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Performance.enable')
  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  await evaluate(`window.scry.setCwd(${JSON.stringify(canonicalWorkspace)})`)
  const baselineSessionRows = await evaluate(`(async () => {
    const deadline = Date.now() + 5_000
    while (document.querySelectorAll('button.sb-sess').length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return document.querySelectorAll('button.sb-sess').length
  })()`)
  assert.ok(baselineSessionRows > 0, 'seed catalog row was not rendered')

  const samples = []
  const cycleMeasurements = []
  const startedAt = Date.now()
  let cycles = 0
  let previousSessionId = null
  let nextCheckpointAt = startedAt + 2 * 60 * 60 * 1_000
  const checkpoints = []
  while (cycleLimit === null ? Date.now() - startedAt < durationMs : cycles < cycleLimit) {
    const prompt = cycles % 20 === 19 ? 'performance long stream' : 'bounded performance soak'
    const result = await evaluate(`(async () => {
      const cwd = ${JSON.stringify(canonicalWorkspace)}
      const previousSessionId = ${JSON.stringify(previousSessionId)}
      const cycleStarted = performance.now()
      let offDone = () => {}
      let offError = () => {}
      const terminal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('soak Provider lifecycle timed out')), 60_000)
        offDone = window.scry.onTurnDone((event) => { clearTimeout(timer); offDone(); offError(); resolve(event) })
        offError = window.scry.onError((event) => { clearTimeout(timer); offDone(); offError(); reject(new Error(event.message)) })
      })
      const startRequested = performance.now()
      await window.scry.start({ providerId: 'codex', cwd, prompt: ${JSON.stringify(prompt)} })
      const done = await terminal
      const terminalAt = performance.now()
      const externalSessionId = done.externalSessionId || done.sessionId
      const historyStarted = performance.now()
      if (previousSessionId) {
        await window.scry.loadSession({ providerId: 'codex', cwd, externalSessionId: previousSessionId }, { limit: 40 })
      }
      await window.scry.loadSession({ providerId: 'codex', cwd, externalSessionId }, { limit: 40 })
      const historyLoadedAt = performance.now()
      const newConversationStarted = performance.now()
      document.querySelector('button.sb-new')?.click()
      const idleDeadline = Date.now() + 5_000
      while (document.querySelectorAll('.transcript-turn').length > 0 && Date.now() < idleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (document.querySelectorAll('.transcript-turn').length > 0) throw new Error('renderer did not return to an empty conversation')
      const newConversationFeedbackMs = performance.now() - newConversationStarted
      const panelToggle = document.querySelector('button[aria-label="右侧工作区"]')
      if (!panelToggle) throw new Error('right surface toggle was not rendered')
      const initiallyOpen = panelToggle.getAttribute('aria-pressed') === 'true'
      panelToggle.click()
      const firstToggleDeadline = Date.now() + 5_000
      while ((panelToggle.getAttribute('aria-pressed') === 'true') === initiallyOpen && Date.now() < firstToggleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if ((panelToggle.getAttribute('aria-pressed') === 'true') === initiallyOpen) throw new Error('right surface did not toggle closed/open')
      panelToggle.click()
      const secondToggleDeadline = Date.now() + 5_000
      while ((panelToggle.getAttribute('aria-pressed') === 'true') !== initiallyOpen && Date.now() < secondToggleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if ((panelToggle.getAttribute('aria-pressed') === 'true') !== initiallyOpen) throw new Error('right surface did not restore its state')
      if (previousSessionId) {
        const deletion = await window.scry.deleteSession({ providerId: 'codex', cwd, externalSessionId: previousSessionId })
        if (deletion.ok !== true) throw new Error('soak session cleanup failed: ' + (deletion.reason || 'unknown'))
      }
      const catalogDeadline = Date.now() + 5_000
      while (document.querySelectorAll('button.sb-sess').length > ${baselineSessionRows + 1} && Date.now() < catalogDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (document.querySelectorAll('button.sb-sess').length > ${baselineSessionRows + 1}) {
        throw new Error('renderer session catalog did not release the previous row')
      }
      let leakInjected = false
      // Explicitly test-gated: this retained node/listener is never part of a normal soak.
      if (${JSON.stringify(leakFixture)}) {
        const retained = globalThis.__scryMemorySoakLeak ??= []
        const node = document.createElement('span')
        node.hidden = true
        node.textContent = 'memory-soak leak fixture'
        const listener = () => node.textContent
        window.addEventListener('scry-memory-soak-leak', listener)
        document.body.append(node)
        retained.push({ node, listener })
        leakInjected = true
      }
      const mainActiveRuns = (await window.scry.activeRuns()).length
      return {
        externalSessionId,
        startToTerminalMs: terminalAt - startRequested,
        historyLoadMs: historyLoadedAt - historyStarted,
        newConversationFeedbackMs,
        cycleMs: performance.now() - cycleStarted,
        mainActiveRuns,
        leakInjected
      }
    })()`)
    assert.ok(result?.externalSessionId, 'smoke run did not expose a session id')
    cycleMeasurements.push(result)
    if (cycleMeasurements.length > 1_000) cycleMeasurements.shift()
    previousSessionId = result.externalSessionId
    cycles += 1
    await cdp.send('HeapProfiler.collectGarbage')
    const [heap, metrics, dom] = await Promise.all([
      cdp.send('Runtime.getHeapUsage'),
      cdp.send('Performance.getMetrics'),
      cdp.send('Memory.getDOMCounters')
    ])
    const values = Object.fromEntries((metrics.metrics ?? []).map((entry) => [entry.name, entry.value]))
    samples.push({
      elapsedMs: Date.now() - startedAt,
      cycles,
      jsHeapUsedBytes: heap.usedSize,
      taskDurationSeconds: values.TaskDuration ?? 0,
      nodes: dom.nodes,
      documents: dom.documents,
      listeners: dom.jsEventListeners,
      mainActiveRuns: result.mainActiveRuns
    })
    if (Date.now() >= nextCheckpointAt) {
      const checkpoint = {
        elapsedMs: Date.now() - startedAt,
        cycles,
        latestRenderer: samples.at(-1),
        latestResources: resourceSamples.at(-1),
        rendererWindows: rendererSamples.length
      }
      checkpoints.push(checkpoint)
      console.log(`SCRY_PERFORMANCE_SOAK_CHECKPOINT=${JSON.stringify(checkpoint)}`)
      nextCheckpointAt += 2 * 60 * 60 * 1_000
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, cycleDelayMs))
  }

  assert.ok(cycles > 0, 'soak completed no cycles')
  assert.ok(samples.length >= 2, 'soak produced too few samples')
  const finalDeletion = await evaluate(`window.scry.deleteSession({ providerId: 'codex', cwd: ${JSON.stringify(canonicalWorkspace)}, externalSessionId: ${JSON.stringify(previousSessionId)} })`)
  assert.equal(finalDeletion?.ok, true, 'soak final session cleanup failed')
  const firstSample = samples[0]
  const lastSample = samples.at(-1)
  // Each run is the remaining growth from cycle k to cycle N. A steady-state
  // counter therefore stays at zero; the leak fixture leaves a positive tail.
  const growthRuns = (field) => samples.map((sample) => Math.max(0, Math.round(lastSample[field] - sample[field])))
  const growthCounters = Object.fromEntries(['jsHeapUsedBytes', 'documents', 'nodes', 'listeners', 'mainActiveRuns']
    .map((field) => [field, growthRuns(field)]))
  const cumulativeGrowthCounters = Object.fromEntries(['jsHeapUsedBytes', 'documents', 'nodes', 'listeners', 'mainActiveRuns']
    .map((field) => [field, Math.max(0, Math.round(lastSample[field] - firstSample[field]))]))
  const workload = `cycles=${cycles};history=two-session-switch;turn=codex-smoke;surface=right-open-close;gc=HeapProfiler.collectGarbage`
  const observationMeta = {
    scenario: 'memory.soak',
    layer: 'memory',
    workload,
    source: 'hidden Electron App CDP Runtime.getHeapUsage and Memory.getDOMCounters; window.scry.activeRuns() for the safe main-process run counter'
  }
  const observations = [
    ['js.heap.used.growth', 'bytes', 'jsHeapUsedBytes'],
    ['dom.documents.growth', 'count', 'documents'],
    ['dom.nodes.growth', 'count', 'nodes'],
    ['dom.listeners.growth', 'count', 'listeners'],
    ['main.active-runs.growth', 'count', 'mainActiveRuns']
  ].map(([metric, unit, field]) => ({ ...observationMeta, metric, unit, availability: 'measured', runs: growthCounters[field] }))
  const sensitivityControl = {
    enabled: leakFixture,
    passed: leakFixture ? lastSample.nodes > firstSample.nodes && lastSample.listeners > firstSample.listeners : null,
    expected: 'one retained hidden DOM node and one window listener per cycle'
  }
  if (leakFixture) {
    assert.ok(sensitivityControl.passed, 'leak fixture did not increase DOM node and listener growth')
  }
  // End in the same idle state and allow the 2 s main-process resource window to observe it.
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_200))
  await cdp.send('HeapProfiler.collectGarbage')
  const tailSize = Math.max(1, Math.floor(samples.length / 5))
  const early = samples.slice(0, tailSize)
  const late = samples.slice(-tailSize)
  const earlyHeapBytes = median(early.map((sample) => sample.jsHeapUsedBytes))
  const lateHeapBytes = median(late.map((sample) => sample.jsHeapUsedBytes))
  const heapDeltaBytes = lateHeapBytes - earlyHeapBytes
  const heapPlateauBudgetBytes = Math.max(20 * 1024 * 1024, Math.round(earlyHeapBytes * 0.05))
  assert.ok(heapDeltaBytes <= heapPlateauBudgetBytes,
    `renderer heap did not plateau: delta=${heapDeltaBytes} budget=${heapPlateauBudgetBytes}`)
  const lastResource = resourceSamples.at(-1)
  if (lastResource) {
    assert.equal(lastResource.counters?.traceBufferedBytes, 0, 'trace buffer did not drain')
    assert.equal(lastResource.counters?.traceInFlightBytes, 0, 'trace ACK credit did not settle')
    assert.equal(lastResource.counters?.activeRuns, 0, 'run registry did not settle')
  }
  assert.equal(lastSample.mainActiveRuns, 0, 'safe main-process active run counter did not settle')

  const latencySummary = Object.fromEntries([
    'startToTerminalMs', 'historyLoadMs', 'newConversationFeedbackMs', 'cycleMs'
  ].map((key) => [key, {
    p50: Math.round(percentile(cycleMeasurements.map((sample) => sample[key]), 0.5) * 10) / 10,
    p95: Math.round(percentile(cycleMeasurements.map((sample) => sample[key]), 0.95) * 10) / 10,
    max: Math.round(Math.max(0, ...cycleMeasurements.map((sample) => sample[key])) * 10) / 10
  }]))
  const mainTimingSummary = Object.fromEntries([...new Set(mainPerformanceSamples.map((sample) => sample.name))].map((name) => {
    const durations = mainPerformanceSamples.filter((sample) => sample.name === name).map((sample) => sample.durationMs)
    return [name, {
      samples: durations.length,
      p50: Math.round(percentile(durations, 0.5) * 10) / 10,
      p95: Math.round(percentile(durations, 0.95) * 10) / 10,
      max: Math.round(Math.max(0, ...durations) * 10) / 10
    }]
  }))
  const rendererSummary = {
    windows: rendererSamples.length,
    frames: rendererSamples.reduce((sum, sample) => sum + (sample.frameCount ?? 0), 0),
    slowFrames: rendererSamples.reduce((sum, sample) => sum + (sample.slowFrameCount ?? 0), 0),
    longTasks: rendererSamples.reduce((sum, sample) => sum + (sample.longTaskCount ?? 0), 0),
    longTaskTotalMs: Math.round(rendererSamples.reduce((sum, sample) => sum + (sample.longTaskTotalMs ?? 0), 0) * 10) / 10,
    maxFrameGapMs: Math.max(0, ...rendererSamples.map((sample) => sample.maxFrameGapMs ?? 0)),
    longestLongTaskMs: Math.max(0, ...rendererSamples.map((sample) => sample.longestLongTaskMs ?? 0))
  }
  const report = {
    durationMs: Date.now() - startedAt,
    cycles,
    sampleCount: samples.length,
    heapDeltaBytes,
    heapPlateauBudgetBytes,
    first: firstSample,
    last: lastSample,
    growthCounters,
    cumulativeGrowthCounters,
    observations,
    counterReport: { schema: 1, revision: 'real-app-soak', observations },
    sensitivityControl,
    pathGroups: {
      exercised: ['navigation', 'history', 'send', 'stream', 'persistence', 'resources-shell'],
      notExercised: ['startup', 'providers', 'compose', 'controls', 'evidence', 'analytics', 'workspace', 'source-control', 'terminal', 'remote'],
      unavailableInOfflineCycle: {
        compose: 'API start is used; native text entry and draft/attachment operations are not represented',
        evidence: 'Tool evidence is produced by the smoke Provider but no evidence detail surface is opened',
        terminal: 'No PTY is started; terminal surface operations are not part of the fixed cycle'
      }
    },
    workload,
    resourceSamples: resourceSamples.length,
    latencySummary,
    mainTimingSummary,
    rendererSummary,
    checkpoints,
    lastResource
  }
  console.log(`SCRY_PERFORMANCE_SOAK_RESULT=${JSON.stringify(report)}`)
  cdp.close()
}

try {
  await main()
} catch (error) {
  console.error(output.slice(-12_000))
  throw error
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolveWait) => child.once('exit', resolveWait)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
    ])
  }
  if (child && child.exitCode == null) {
    child.kill('SIGKILL')
    await new Promise((resolveWait) => child.once('exit', resolveWait))
  }
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
