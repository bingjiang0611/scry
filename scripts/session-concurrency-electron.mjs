import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

// Everything that talks to the hidden measurement process: port, CDP session, fixture bootstrap, its
// private IPC snapshot channel, stream framing. Nothing here decides pass/fail.

// Node emits 'close' only after the child exited AND its stdio closed, so it is the last moment at which a
// tail line can still arrive. The subscription is made at spawn, so a close that lands before the stop
// returns is cached instead of missed. The drain deadline deliberately starts inside wait(): the App is
// meant to run for many seconds before it is stopped, so a spawn-time timer would expire during the
// measurement itself. The bound belongs to this wait alone (the stop deadline in owned-app-processes.mjs is
// untouched), and a miss stays unknown: the caller must not re-signal.
export function watchChildClose(child, { drainTimeoutMs = 5_000 } = {}) {
  if (!child) return { wait: async () => ({ state: 'unknown', reason: 'no child was started' }) }
  let settled = null
  let timer = null
  let resolveWait = null
  const onClose = (code, signal) => {
    child.off('close', onClose)
    settled = { state: 'closed', code, signal }
    if (timer) { clearTimeout(timer); timer = null }
    resolveWait?.(settled)
    resolveWait = null
  }
  child.on('close', onClose)
  return {
    async wait() {
      if (settled) return settled
      return new Promise(resolve => {
        resolveWait = resolve
        timer = setTimeout(() => {
          timer = null
          // A late close is no longer observed, and the unknown verdict is cached so a second wait cannot
          // re-arm a deadline either.
          child.off('close', onClose)
          settled = { state: 'unknown',
            reason: `close was not observed within ${drainTimeoutMs} ms after the stop; stdio drain is unknown` }
          resolve(settled)
        }, drainTimeoutMs)
        timer.unref?.()
      })
    }
  }
}

export async function freePort() {
  const server = createServer()
  await new Promise((ready, reject) => server.once('error', reject).listen(0, '127.0.0.1', ready))
  const { port } = server.address()
  await new Promise(close => server.close(close))
  return port
}

export async function openRendererSession(port, startupProbe) {
  const deadline = Date.now() + 30_000
  let page
  while (!page && Date.now() < deadline) {
    startupProbe.phase = 'http-request'
    startupProbe.attempts = (startupProbe.attempts ?? 0) + 1
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
      startupProbe.targets = targets.slice(0, 8).map(({ type, title }) => ({ type, title }))
      page = targets.find(target => target.type === 'page' && target.title === 'Scry' && target.webSocketDebuggerUrl)
    } catch (error) { startupProbe.error = String(error) }
    if (!page) await new Promise(wait => setTimeout(wait, 50))
  }
  assert.ok(page, 'App startup timed out')
  assert.match(page.url, /^file:/)
  startupProbe.phase = 'websocket-connect'
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  await new Promise((ready, reject) => { socket.onopen = ready; socket.onerror = reject })
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
  const send = (method, params = {}) => {
    const id = nextId++
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    socket.send(JSON.stringify({ id, method, params }))
    return result
  }
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  await send('Runtime.enable')
  await send('Performance.enable')
  // UI readiness polls the real DOM; the failure message carries the page tail for diagnosis.
  const wait = expression => evaluate(`(async () => {
    const deadline = performance.now() + 20000
    while (!(${expression})) {
      if (performance.now() > deadline) throw new Error('UI condition timed out: ' + ${JSON.stringify(expression)}
        + '\\n' + JSON.stringify({ sessions: document.querySelectorAll('button.sb-sess').length,
          textarea: Boolean(document.querySelector('textarea')), body: document.body.innerText.slice(-1500) }))
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    return true
  })()`)
  return { send, evaluate, wait, close: () => socket.close() }
}

// CDP counters: TaskDuration is renderer main-thread task time, not process CPU or React commit.
export async function readRendererMetrics(send) {
  const { metrics } = await send('Performance.getMetrics')
  const metric = name => {
    const found = metrics.find(candidate => candidate.name === name)
    return found && Number.isFinite(found.value) ? found.value : null
  }
  return { timestampSeconds: metric('Timestamp'), taskDurationSeconds: metric('TaskDuration'),
    jsHeapUsedBytes: metric('JSHeapUsedSize'), nodes: metric('Nodes') }
}

// Line framing per stream: each chunk's tail is carried until its newline, so a chunk boundary is not a
// broken line; only a complete unparseable line is malformed.
export function createDiagnosticReader(onLine) {
  let pending = ''
  const emit = line => { if (line.trim() !== '') onLine(line) }
  return {
    push(chunk) {
      pending += String(chunk)
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) emit(line)
    },
    // A surviving tail is a real line without a final newline: reported, not lost.
    flush() {
      const line = pending
      pending = ''
      emit(line)
    }
  }
}

// The fixture bootstrap is a temp file outside the repository, never production code. It adds two fixed
// capabilities: startup phase marks on stderr, and a private IPC snapshot reply built from
// process.cpuUsage()/hrtime/memoryUsage()/app.getAppMetrics(). No eval, command, or path protocol.
// Per-process CPU is read as the from-start cumulative counter, never percentCPUUsage: that value is
// "since the previous call", and this snapshot is an extra caller of getAppMetrics().
export function writeBootstrap({ dir, root, metadata }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'main.cjs' }))
  writeFileSync(join(dir, 'main.cjs'), `
    const { app } = require('electron');
    const mark = (phase, detail = {}) => process.stderr.write('[scry:concurrency-startup] ' + JSON.stringify({ phase, pid: process.pid, atMs: performance.now(), ...detail }) + '\\n');
    const snapshot = () => ({
      monotonicMs: Number(process.hrtime.bigint() / 1000000n),
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
      metrics: app.getAppMetrics().map((entry) => ({ pid: entry.pid, type: entry.type,
        creationTime: Number.isFinite(entry.creationTime) ? entry.creationTime : null,
        cumulativeCpuSeconds: entry.cpu && Number.isFinite(entry.cpu.cumulativeCPUUsage) ? entry.cpu.cumulativeCPUUsage : null,
        workingSetKb: entry.memory ? entry.memory.workingSetSize : null }))
    });
    if (typeof process.send === 'function') {
      process.on('message', (message) => {
        if (!message || message.type !== 'concurrency-snapshot' || typeof message.requestId !== 'string') return;
        process.send({ type: 'concurrency-snapshot', requestId: message.requestId, snapshot: snapshot() });
      });
    }
    mark('bootstrap', { ready: app.isReady(), ipc: typeof process.send === 'function' });
    app.once('ready', () => mark('app-ready'));
    app.on('browser-window-created', (_event, win) => {
      mark('window-created', { windowId: win.id });
      win.webContents.on('did-fail-load', (_event, code, description) => mark('renderer-load-failed', { code, description }));
    });
    app.setAppPath(${JSON.stringify(root)});
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    require(${JSON.stringify(join(root, metadata.main))});
    mark('main-loaded');
  `)
  return join(dir, 'main.cjs')
}

// Bounded request/reply over the inherited Node IPC channel: a silent child yields unavailable.
export function openSnapshotChannel(child, { timeoutMs = 2_000 } = {}) {
  const pending = new Map()
  let nextId = 1
  const onMessage = message => {
    if (!message || message.type !== 'concurrency-snapshot') return
    const entry = pending.get(message.requestId)
    if (!entry) return
    pending.delete(message.requestId)
    clearTimeout(entry.timer)
    entry.resolve({ status: 'measured', snapshot: message.snapshot })
  }
  child.on('message', onMessage)
  return {
    take(label) {
      if (typeof child.send !== 'function' || child.connected === false) {
        return Promise.resolve({ status: 'unavailable', reason: 'fixture bootstrap IPC channel is not connected' })
      }
      return new Promise(resolve => {
        const requestId = `${label}-${nextId++}`
        const timer = setTimeout(() => {
          pending.delete(requestId)
          resolve({ status: 'unavailable', reason: `no snapshot reply for ${requestId} within ${timeoutMs} ms` })
        }, timeoutMs)
        pending.set(requestId, { resolve, timer })
        child.send({ type: 'concurrency-snapshot', requestId })
      })
    },
    close() {
      child.off('message', onMessage)
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.resolve({ status: 'unavailable', reason: 'snapshot channel closed before the reply arrived' })
      }
      pending.clear()
    }
  }
}

// Bounded capture of the App's two streams: text for the retained log, per-stream framing, hard cap.
export function createOutputCapture({ limitChars = 4 * 1024 * 1024, onLine }) {
  const chunks = []
  let size = 0
  let truncated = false
  const append = text => {
    if (truncated) return
    if (size + text.length > limitChars) {
      chunks.push(text.slice(0, Math.max(0, limitChars - size)))
      size = limitChars
      truncated = true
      return
    }
    chunks.push(text)
    size += text.length
  }
  const stdout = createDiagnosticReader(onLine)
  const stderr = createDiagnosticReader(onLine)
  return {
    stdout: chunk => { append(String(chunk)); stdout.push(chunk) },
    stderr: chunk => { append(String(chunk)); stderr.push(chunk) },
    truncated: () => truncated,
    finish() {
      stdout.flush()
      stderr.flush()
      return chunks.join('')
    }
  }
}

// Read-only page queries. Settlement is one query for all runs: per-run queries would add concurrent IPC
// work to the thing being measured.
export async function readSettlement(evaluate) {
  return evaluate(`(async () => {
    const deadline = performance.now() + 20000
    while ((await window.scry.activeRuns()).length > 0) {
      if (performance.now() > deadline) throw new Error('active runs did not settle')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const startedAt = performance.now()
    const stats = await window.scry.stats()
    return { activeRuns: 0, sqlite: { status: stats.status, turns: stats.totals.turns, readMs: performance.now() - startedAt } }
  })()`)
}

// Native DOM observation of what the transcript holds at the end: no clicks, no synthetic events.
export function readRendererMount(evaluate, runIds) {
  return evaluate(`(${JSON.stringify(runIds)}).map(runId => {
    const element = document.querySelector('[data-run-id="' + runId + '"]')
    return { runId, mounted: Boolean(element), textChars: element ? element.textContent.length : 0 }
  })`)
}

// Two boundaries only, both inside the same main process: the fixture's own CPU/memory snapshot over
// private IPC plus the renderer's CDP counters. Every request has a deadline, so a dead child yields an
// unavailable sample instead of stalling the measurement.
export function createBoundarySampler({ snapshotChannel, send }) {
  return async label => {
    const main = await snapshotChannel.take(label)
    let renderer = null
    try { renderer = await readRendererMetrics(send) } catch (error) { renderer = { error: String(error) } }
    return { label, takenAtEpochMs: Date.now(), main, renderer }
  }
}
