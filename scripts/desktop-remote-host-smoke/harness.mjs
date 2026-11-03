import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Transport helpers for the host smoke. Kept apart from the phases so each phase
// reads as a sequence of checks instead of TLS plumbing.
export const RUN_PROTOCOL_VERSION = 2

export async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveReady))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

export async function waitForTarget(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && target.title === 'Scry')
      if (page) return page
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('renderer debug target not found')
}

export function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const ready = new Promise((resolveReady, reject) => {
    socket.onopen = resolveReady
    socket.onerror = () => reject(new Error('CDP WebSocket connection failed'))
  })
  const rejectPending = (message) => {
    for (const request of pending.values()) request.reject(new Error(message))
    pending.clear()
  }
  socket.onmessage = (message) => {
    const payload = JSON.parse(String(message.data))
    if (!payload.id) return
    const request = pending.get(payload.id)
    if (!request) return
    pending.delete(payload.id)
    if (payload.error) request.reject(new Error(payload.error.message))
    else request.resolve(payload.result)
  }
  socket.onclose = () => rejectPending('CDP WebSocket closed')
  return {
    async send(method, params = {}) {
      await ready
      const id = nextId++
      const result = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close() { socket.close() }
  }
}

export async function buildTransportClient({ root, temp }) {
  const prepared = process.argv.find(value => value.startsWith('--transport-client='))?.slice('--transport-client='.length)
  if (prepared) return await import(resolve(prepared))
  const { build } = await import('esbuild')
  const entry = join(temp, 'desktop-transport-entry.mjs')
  const output = join(temp, 'desktop-transport-client.mjs')
  writeFileSync(entry, `export { generateDesktopDeviceIdentity, desktopTlsRequest } from ${JSON.stringify(join(root, 'src/main/remote/desktop-transport.ts'))}\n`)
  await build({
    entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    // Keep this helper a real Node TLS client, but make it independent of the
    // repository's module lookup from the temporary HOME.
    packages: 'bundle', logLevel: 'error'
  })
  return await import(`${output}?cacheBust=${Date.now()}`)
}

export function decodeInvitation(value) {
  assert.equal(typeof value, 'string')
  assert.match(value, /^scry-desktop1:/)
  const payload = JSON.parse(Buffer.from(value.slice('scry-desktop1:'.length), 'base64url').toString('utf8'))
  assert.equal(payload.version, 1)
  assert.equal(typeof payload.hostId, 'string')
  assert.equal(typeof payload.anchorPEM, 'string')
  assert.ok(Number.isInteger(payload.pairPort) && payload.pairPort > 0)
  assert.ok(Number.isInteger(payload.runPort) && payload.runPort > 0)
  assert.equal(typeof payload.pairingId, 'string')
  assert.equal(typeof payload.secret, 'string')
  assert.ok(payload.expiresAt > Date.now())
  return payload
}

// Every run-channel request declares the protocol version it speaks; the pairing
// channel keeps its own `protocolMajor` request shape and is left untouched.
export function framedRequest(request) {
  if (!request || typeof request !== 'object' || !('op' in request)) return request
  return { protocol: RUN_PROTOCOL_VERSION, ...request }
}

export function tlsRequest(transport, port, caPEM, certPEM, keyPEM, request) {
  return transport.desktopTlsRequest({ host: '127.0.0.1', port, caPEM, certPEM, keyPEM, request: framedRequest(request) })
}

// Deliberately destroy the client channel after the request is handed to the OS.
// This models the only transport result a device may call unknown: the host can
// still have recorded the intent, but the client did not receive its receipt.
export async function submitWithUnknownTransport({ port, caPEM, certPEM, keyPEM, request }) {
  await new Promise((resolveUnknown, rejectUnknown) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: caPEM, cert: certPEM, key: keyPEM, servername: 'scry-host', minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) rejectUnknown(error)
      else resolveUnknown()
    }
    socket.once('secureConnect', () => {
      socket.write(`${JSON.stringify(framedRequest(request))}\n`, () => socket.destroy())
    })
    socket.once('error', () => finish())
    socket.once('close', () => finish())
    setTimeout(() => { socket.destroy(); finish(new Error('unknown transport injection timeout')) }, 5_000).unref()
  })
}

export function detail(cwd, prompt, extra = {}) {
  return JSON.stringify({ cwd, providerId: 'codex', prompt, ...extra })
}

export async function waitForRun({ transport, runPort, caPEM, certPEM, keyPEM, runId, expect = 'terminal' }) {
  const deadline = Date.now() + 30_000
  let last
  while (Date.now() < deadline) {
    last = await tlsRequest(transport, runPort, caPEM, certPEM, keyPEM, { op: 'watch', runId, cursor: 0, outputCursor: 0, waitMs: 1_000 })
    const state = last?.watch?.state
    if (state === 'settled' || state === 'failed' || state === 'cancelled') {
      if (expect === 'settled') assert.equal(state, 'settled', JSON.stringify(last))
      if (expect === 'failed') assert.equal(state, 'failed', JSON.stringify(last))
      return last
    }
  }
  throw new Error(`remote run did not reach ${expect}: ${JSON.stringify(last)}`)
}

export function progressMarkers(watch, runId) {
  return (watch?.watch?.poll?.events ?? []).flatMap((event) => {
    if (event.runId !== runId || event.kind !== 'run_progress' || typeof event.detail !== 'string') return []
    try { return [JSON.parse(event.detail)] } catch { return [] }
  })
}

export function createEvaluate(cdp) {
  return async function evaluate(expression) {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderer evaluation failed')
    return response.result?.value
  }
}

export function launch({ spawn, executable, devApp, root, port, userDataDir, home, appendLog }) {
  const child = spawn(executable, [
    ...(devApp ? [root] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'
  ], {
    env: {
      ...process.env,
      HOME: home,
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '0',
      SCRY_TEST_APP: '1',
      SCRY_ELECTRON_SMOKE_PROVIDER: '1',
      SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi',
      SCRY_REMOTE_HOST: '1',
      SCRY_REMOTE_RELAY_ENABLED: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  child.once('exit', (code, signal) => { appendLog(`\nElectron exited code=${code} signal=${signal}\n`) })
  return child
}
