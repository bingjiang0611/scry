import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { runLateSmoke } from './desktop-remote-host-smoke-late.mjs'
import { runWorkbenchSmoke } from './desktop-remote-host-smoke-workbench.mjs'
import { runHostSetup } from './desktop-remote-host-smoke-setup.mjs'

// This is deliberately a host smoke, not a provider smoke. The only Provider
// process it can reach is the packaged Codex fixture selected by the production
// main process when SCRY_ELECTRON_SMOKE_PROVIDER=1.
const devApp = process.argv[2] === '--dev'
const appPath = resolve(devApp
  ? 'node_modules/electron/dist/Electron.app'
  : join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app'))
const executable = join(appPath, 'Contents', 'MacOS', devApp ? 'Electron' : 'Scry')
const root = resolve('.')
const temp = mkdtempSync(join(tmpdir(), 'scry-desktop-remote-smoke-'))
let child
let cdp
let appLog = ''

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
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && target.title === 'Scry')
      if (page) return page
    } catch { /* Chromium is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Electron CDP target timeout\n${appLog.slice(-4000)}`)
}

function connectCdp(url) {
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

async function buildTransportClient() {
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

function decodeInvitation(value) {
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

function tlsRequest(transport, port, caPEM, certPEM, keyPEM, request) {
  return transport.desktopTlsRequest({ host: '127.0.0.1', port, caPEM, certPEM, keyPEM, request })
}

// Deliberately destroy the client channel after the request is handed to the OS.
// This models the only transport result a device may call unknown: the host can
// still have recorded the intent, but the client did not receive its receipt.
async function submitWithUnknownTransport({ port, caPEM, certPEM, keyPEM, request }) {
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
      socket.write(`${JSON.stringify(request)}\n`, () => socket.destroy())
    })
    socket.once('error', () => finish())
    socket.once('close', () => finish())
    setTimeout(() => { socket.destroy(); finish(new Error('unknown transport injection timeout')) }, 5_000).unref()
  })
}

function detail(cwd, prompt, extra = {}) {
  return JSON.stringify({ cwd, providerId: 'codex', prompt, ...extra })
}

async function waitForRun({ transport, runPort, caPEM, certPEM, keyPEM, runId, expect = 'terminal' }) {
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

function progressMarkers(watch, runId) {
  return (watch?.watch?.poll?.events ?? []).flatMap((event) => {
    if (event.runId !== runId || event.kind !== 'run_progress' || typeof event.detail !== 'string') return []
    try { return [JSON.parse(event.detail)] } catch { return [] }
  })
}

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderer evaluation failed')
  return response.result?.value
}

function launch(port, userDataDir, home, workspace) {
  child = spawn(executable, [
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
  child.stdout.on('data', (chunk) => { appLog += String(chunk); appLog = appLog.slice(-16_000) })
  child.stderr.on('data', (chunk) => { appLog += String(chunk); appLog = appLog.slice(-16_000) })
  child.once('exit', (code, signal) => { appLog += `\nElectron exited code=${code} signal=${signal}\n`; appLog = appLog.slice(-16_000) })
  void workspace
}

async function main() {
  const { transport, workspace, canonicalWorkspace, userDataDir, page, invitation, identity, deviceCertPEM, info, localGrant, git } = await runHostSetup({ executable, buildTransportClient, freePort, temp, launch, waitForTarget, connectCdp, setCdp: (value) => { cdp = value }, evaluate, decodeInvitation, tlsRequest })
  await runWorkbenchSmoke({ transport: transport, invitation: invitation, deviceCertPEM: deviceCertPEM, identity: identity, canonicalWorkspace: canonicalWorkspace, workspace: workspace, git: git, tlsRequest: tlsRequest, temp: temp, realpathSync: realpathSync, existsSync: existsSync, readFileSync: readFileSync, join: join, execFileSync: execFileSync, randomUUID: randomUUID })
  const context = { cwd: canonicalWorkspace, providerId: 'codex' }
  const submit = async (intentId, prompt, extra = {}) => tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'submit', intentId, detail: detail(canonicalWorkspace, prompt, extra)
  })
  const normalIntentId = randomUUID()
  const normal = await submit(normalIntentId, 'desktop remote write one')
  assert.equal(normal.status, 'recorded')
  const duplicate = await submit(normalIntentId, 'desktop remote write one')
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.runId, normal.runId)
  const normalWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: normal.runId, expect: 'settled' })
  const normalMarkers = progressMarkers(normalWatch, normal.runId)
  const normalSession = normalMarkers.find((marker) => marker.event === 'session')?.externalSessionId
  const normalScryRunId = normalMarkers.find((marker) => marker.event === 'bound')?.scryRunId
  assert.match(normalSession, /^smoke-session-/)
  assert.match(normalScryRunId, /^remote-run-/)
  const trace = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'trace', context: { ...context, externalSessionId: normalSession }, runId: normalScryRunId }
  })
  assert.equal(trace.desktop.kind, 'trace')
  assert.equal(trace.desktop.run, null, 'settled execution must be released; evidence is retained in archive')
  const history = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'history', context: { ...context, externalSessionId: normalSession } }
  })
  assert.equal(history.desktop.kind, 'history')
  assert.equal(history.desktop.history.source, 'trace_archive')
  assert.equal(history.desktop.history.status, 'available')
  assert.ok(history.desktop.history.turns.length > 0 && history.desktop.history.turns.length <= 10_000)
  assert.ok(history.desktop.history.turns.some((turn) => turn.items.some((item) => item.stage === 'tool_result')))
  const sessionContext = { ...context, externalSessionId: normalSession }
  const sessionAction = (target, action) => tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'sessionAction', context: target, action })
  const sessionPage = (includeArchived = true) => tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'sessionsPage', includeArchived })
  assert.equal(info.desktop.sessionActions, true)
  const commands = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'commands', ...context })
  assert.ok(Array.isArray(commands.commands.commands), 'commands must come from the host catalog even when unavailable')
  assert.equal((await sessionAction(sessionContext, { kind: 'rename', title: 'Host-owned title' })).sessionAction, true)
  assert.equal((await sessionAction(sessionContext, { kind: 'pin', pinned: true })).sessionAction, true)
  const renamed = (await sessionPage()).sessionsPage.sessions.find(session => session.externalSessionId === normalSession)
  assert.equal(renamed.label, 'Host-owned title')
  assert.ok(renamed.pinnedAt > 0)
  const hostProjects = await evaluate('window.scry.listProjects()')
  assert.ok(hostProjects.some(project => project.sessions.some(session => session.externalSessionId === normalSession && session.preview === 'Host-owned title')), 'remote metadata did not update the actual host sidebar store')
  const deniedMetadata = await sessionAction({ ...sessionContext, cwd: join(temp, 'not-authorized') }, { kind: 'rename', title: 'Denied title' })
  assert.ok(deniedMetadata.error, 'unauthorized workspace mutation must fail')
  assert.equal((await sessionAction(sessionContext, { kind: 'archive', archived: true })).sessionAction, true)
  assert.ok((await sessionPage()).sessionsPage.sessions.find(session => session.externalSessionId === normalSession)?.archivedAt)
  assert.ok(!(await sessionPage(false)).sessionsPage.sessions.some(session => session.externalSessionId === normalSession), 'legacy/mobile catalog exposed archived rows')
  assert.equal((await sessionAction(sessionContext, { kind: 'archive', archived: false })).sessionAction, true)
  assert.equal((await sessionAction(sessionContext, { kind: 'pin', pinned: false })).sessionAction, true)
  assert.ok(!(await sessionPage()).sessionsPage.sessions.find(session => session.externalSessionId === normalSession).pinnedAt)
  const resumed = await submit(randomUUID(), 'desktop remote write two', { resume: normalSession })
  const resumedWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: resumed.runId, expect: 'settled' })
  const resumedRunId = progressMarkers(resumedWatch, resumed.runId).find(marker => marker.event === 'bound')?.scryRunId
  const resumedHistory = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'history', context: { ...context, externalSessionId: normalSession } }
  })
  const resumedTurn = resumedHistory.desktop.history.turns.find(turn => turn.runId === resumedRunId)
  assert.ok(resumedTurn, 'resumed turn is not in the same durable session')
  const sessionDiff = resumedTurn.items.find(item => item.stage === 'session_diff')?.turnDiff
  assert.equal(sessionDiff?.status, 'captured')
  assert.equal(sessionDiff.baseline, 'session_start', 'resume must retain the first-turn baseline')
  for (const name of ['remote-first.txt', 'remote-second.txt']) {
    assert.ok(sessionDiff.files.some(file => file.path.endsWith(name)), `session diff lost ${name}`)
  }

  // A dropped receipt is resolved through intentStatus, never by sending a new
  // intent id. This is the canonical exactly-once/unknown branch.
  const unknownIntentId = randomUUID()
  await submitWithUnknownTransport({
    port: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM,
    request: { op: 'submit', intentId: unknownIntentId, detail: detail(canonicalWorkspace, 'desktop remote unknown receipt smoke') }
  })
  let unknown
  const unknownDeadline = Date.now() + 10_000
  while (Date.now() < unknownDeadline) {
    unknown = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'intentStatus', intentId: unknownIntentId })
    if (unknown.intent?.runId) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  assert.ok(unknown?.intent?.runId, `unknown intent was not durably recorded: ${JSON.stringify(unknown)}`)
  const unknownRunId = unknown.intent.runId
  const unknownAgain = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'intentStatus', intentId: unknownIntentId })
  assert.equal(unknownAgain.intent.runId, unknownRunId)
  await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: unknownRunId, expect: 'settled' })

  // Explicit recovery reuses accepted evidence; an absent id instead gets a
  // durable cancellation fence. Neither branch can replay the original prompt.
  const recovered = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'resolveIntent', intentId: unknownIntentId })
  assert.equal(recovered.intent.runId, unknownRunId)
  assert.equal(recovered.intent.state, 'settled')
  const absentIntentId = randomUUID()
  const fenced = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'resolveIntent', intentId: absentIntentId })
  assert.equal(fenced.intent.state, 'cancelled')
  const fencedAgain = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'resolveIntent', intentId: absentIntentId })
  assert.deepEqual(fencedAgain, fenced)
  assert.deepEqual(await submit(absentIntentId, 'must never execute a delayed submission'), { error: 'intent_payload_conflict' })
  const bridgeRejection = await evaluate(`window.scry.desktopRemote.resolveIntent('missing-connection', ${JSON.stringify(absentIntentId)}).then(() => 'unexpected success', error => error.message)`)
  assert.match(bridgeRejection, /unknown_connection/, 'production preload/IPC recovery must reach main validation')

  const { activeTrace } = await runLateSmoke({ transport: transport, invitation: invitation, deviceCertPEM: deviceCertPEM, identity: identity, context: context, submit: submit, waitForRun: waitForRun, progressMarkers: progressMarkers, tlsRequest: tlsRequest, evaluate: evaluate, workspace: workspace, temp: temp, canonicalWorkspace: canonicalWorkspace, sessionAction: sessionAction, sessionPage: sessionPage, sessionContext: sessionContext, localGrant: localGrant, appPath: appPath, page: page, userDataDir: userDataDir, normalSession: normalSession, history: history, readdirSync: readdirSync, join: join, statSync: statSync, readFileSync: readFileSync, realpathSync: realpathSync })

}

let failure
try {
  await main()
} catch (error) {
  failure = error
  console.error(`[scry] desktop remote host smoke failure: ${error instanceof Error ? error.stack : String(error)}\n${appLog.slice(-8_000)}`)
} finally {
  if (cdp) cdp.close()
  try {
    if (child && child.exitCode === null && child.signalCode === null) await stopOwnedApp(child)
  } finally {
    if (failure || (child && child.exitCode === null && child.signalCode === null)) {
      writeFileSync(join(temp, 'failure.log'), `${failure?.stack ?? failure ?? 'child exit unproven'}\n${appLog}`, { mode: 0o600 })
      console.error(`Retained isolated evidence: ${temp}`)
    } else rmSync(temp, { recursive: true, force: true })
  }
}
if (failure) process.exitCode = 1