import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stopOwnedApp } from './owned-app-processes.mjs'

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
  assert.ok(existsSync(executable), `production Electron executable not found: ${executable}; build/package the app before running this smoke`)
  const transport = await buildTransportClient()
  const cdpPort = await freePort()
  const userDataDir = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const canonicalWorkspace = realpathSync(workspace)
  writeFileSync(join(workspace, 'README.md'), '# isolated remote host smoke\n')
  writeFileSync(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'desktop-remote-host-smoke', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true }
  }))
  mkdirSync(join(workspace, '.scry'), { recursive: true })
  writeFileSync(join(workspace, '.gitignore'), '.scry/\n')
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: workspace, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe'
  })
  git('init', '-q')
  git('add', 'README.md', 'scry.config.json', '.gitignore')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'isolated baseline')
  // The production workspace authorizer intentionally accepts only known projects.
  writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([canonicalWorkspace]))
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'desktop-remote-bootstrap', runId: 'desktop-remote-bootstrap', providerId: 'codex', runtimeProvider: 'codex_cli', cwd: canonicalWorkspace,
    preview: 'desktop remote host smoke', ts: Date.now()
  }]))

  launch(cdpPort, userDataDir, home, workspace)
  const page = await waitForTarget(cdpPort)
  assert.match(page.url, /^file:/, 'production renderer must load from a file URL')
  cdp = connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const boundary = await evaluate(`(() => ({ requireType: typeof require, scryType: typeof window.scry, inviteType: typeof window.scry?.remoteDesktopHostInvite }))()`)
  assert.equal(boundary.requireType, 'undefined')
  assert.equal(boundary.scryType, 'object')
  assert.equal(boundary.inviteType, 'function')

  const remoteStatus = await evaluate(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = await window.scry.remoteStatus();
      if (status.enabled) return status;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('remote host initialization timed out');
  })()`)
  const initialStatus = await evaluate('window.scry.remoteDesktopHostStatus()')
  assert.equal(initialStatus.enabled, false, 'SSH listener must be explicit opt-in')
  assert.equal(remoteStatus.enabled, true)
  assert.equal(remoteStatus.relayConfigured, false)
  const invitation = decodeInvitation(await evaluate('window.scry.remoteDesktopHostInvite()'))
  const identity = await transport.generateDesktopDeviceIdentity()
  const pairingRequest = {
    protocolMajor: 1, requestId: randomUUID(), operation: 'pair.prove', pairingId: invitation.pairingId,
    secret: invitation.secret, csrPEM: identity.csrPEM, deviceLabel: 'desktop-remote-smoke'
  }
  const pending = await tlsRequest(transport, invitation.pairPort, invitation.anchorPEM, identity.bootstrapCertPEM, identity.keyPEM, pairingRequest)
  assert.equal(pending.kind, 'pair.pending')
  assert.equal(pending.publicKeySHA256, identity.publicKeySHA256)
  const localPending = await evaluate('window.scry.remoteStatus()')
  assert.equal(localPending.pending.length, 1)
  assert.equal(localPending.pending[0].pairingId, invitation.pairingId)
  assert.equal(localPending.pending[0].publicKeySHA256, identity.publicKeySHA256)
  // Only this trusted-local renderer IPC may approve a pairing. The device never
  // receives a confirm/revoke operation over the production receiver.
  const localGrant = await evaluate(`window.scry.remoteConfirmPairing(${JSON.stringify(invitation.pairingId)}, ${JSON.stringify(identity.publicKeySHA256)})`)
  assert.equal(localGrant.revoked, false)
  const granted = await tlsRequest(transport, invitation.pairPort, invitation.anchorPEM, identity.bootstrapCertPEM, identity.keyPEM, {
    protocolMajor: 1, requestId: randomUUID(), operation: 'pair.status', pairingId: invitation.pairingId, secret: invitation.secret
  })
  assert.equal(granted.kind, 'pair.granted')
  const deviceCertPEM = granted.certificatePEM
  const info = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: { kind: 'info' } })
  assert.deepEqual(info.desktop, { kind: 'info', protocol: 1, hostId: invitation.hostId, execution: 'canonical', directorySelection: true })
  const customDirectory = join(temp, 'custom project ')
  mkdirSync(customDirectory)
  const canonicalCustom = realpathSync(customDirectory)
  const browse = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktopDirectory', query: { action: 'list', path: canonicalCustom }
  })
  assert.equal(browse.directory.page.current.path, canonicalCustom)
  assert.deepEqual(browse.directory.page.directories, [])
  assert.deepEqual(JSON.parse(readFileSync(join(userDataDir, 'recent-folders.json'), 'utf8')), [canonicalWorkspace], 'browsing must not create a workspace grant')
  const selected = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktopDirectory', query: { action: 'select', path: canonicalCustom }
  })
  assert.deepEqual(selected.directory, { action: 'select', project: { path: canonicalCustom, label: 'custom project ' } })
  assert.ok(JSON.parse(readFileSync(join(userDataDir, 'recent-folders.json'), 'utf8')).includes(canonicalCustom), 'explicit selection must persist the canonical workspace grant')
  const projects = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'projects' })
  assert.ok(projects.projects.some(project => project.path === canonicalCustom), 'selected project must be offered through the production catalog')
  assert.deepEqual(await evaluate('window.scry.activeRuns()'), [], 'selecting a directory must not start an Agent')
  assert.equal(existsSync(join(canonicalCustom, '.scry')), false, 'selection must not create a turn record')

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

  // The fixture has a real question lifecycle. Stop while its question is open;
  // no synthetic answer is injected and the terminal status must be observed.
  const question = await submit(randomUUID(), 'dock badge question smoke')
  let questionWatch
  const questionDeadline = Date.now() + 10_000
  while (Date.now() < questionDeadline) {
    questionWatch = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'watch', runId: question.runId, cursor: 0, outputCursor: 0, waitMs: 1_000 })
    if (questionWatch.watch?.questions?.length) break
  }
  assert.ok(questionWatch?.watch?.questions?.length, 'question fixture did not reach a pending question')
  const questionMarkers = progressMarkers(questionWatch, question.runId)
  const questionScryRunId = questionMarkers.find(marker => marker.event === 'bound')?.scryRunId
  const questionSession = questionMarkers.find(marker => marker.event === 'session')?.externalSessionId
  const activeTrace = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'trace', context: { ...context, externalSessionId: questionSession }, runId: questionScryRunId }
  })
  assert.equal(activeTrace.desktop.run.done, false)
  assert.equal(activeTrace.desktop.run.runId, questionScryRunId)
  assert.ok(activeTrace.desktop.run.pendingQuestions.length > 0)
  const adopted = await evaluate(`window.scry.adoptActiveRun(${JSON.stringify(questionScryRunId)})`)
  assert.equal(adopted.runId, questionScryRunId)
  // A different fresh session must settle while the first is still awaiting
  // input. Sequential submissions would not detect an admission lock leak.
  const second = await submit(randomUUID(), 'desktop remote independent session smoke')
  const secondWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: second.runId, expect: 'settled' })
  const secondSession = progressMarkers(secondWatch, second.runId).find(marker => marker.event === 'session')?.externalSessionId
  assert.match(secondSession, /^smoke-session-/)
  assert.notEqual(secondSession, questionSession)
  const stopped = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'stop', runId: question.runId })
  assert.ok(['requested', 'already_requested'].includes(stopped.stop?.status))
  const cancelled = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: question.runId })
  const cancelMarkers = progressMarkers(cancelled, question.runId)
  assert.ok(cancelMarkers.some((marker) => marker.event === 'settled' && ['interrupted', 'cancelled'].includes(marker.status)), JSON.stringify(cancelled))
  const interruptedHistory = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'history', context: { ...context, externalSessionId: questionSession } }
  })
  const adoptedDiff = interruptedHistory.desktop.history.turns.flatMap(turn => turn.items).find(item => item.stage === 'session_diff')?.turnDiff
  assert.equal(adoptedDiff?.status, 'captured', 'Mac adoption must not detach the remote run baseline')

  // A real adapter rejection after publishing its native session exercises the
  // production runtime rejection/recording/finally branches, not input rejection.
  const failed = await submit(randomUUID(), 'remote provider failure smoke')
  const failedWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: failed.runId, expect: 'failed' })
  assert.equal(failedWatch.watch.state, 'failed')
  const failureEvent = failedWatch.watch.poll.events.find(event => event.runId === failed.runId && event.kind === 'run_failed')
  assert.equal(failureEvent.detail, 'fixture_provider_failure', 'committed Provider error must not become an unknown recording failure')

  const scryEntries = readdirSync(join(workspace, '.scry'))
  for (const entry of scryEntries) {
    const info = statSync(join(workspace, '.scry', entry))
    assert.ok(info.size <= 4 * 1024 * 1024, `unbounded .scry artifact: ${entry}`)
  }
  const recordsDir = join(workspace, '.scry', 'records')
  const recordFiles = readdirSync(recordsDir, { recursive: true }).filter(name => name.endsWith('.json'))
  const records = recordFiles.map(name => JSON.parse(readFileSync(join(recordsDir, name), 'utf8'))).filter(record => record.recordKind === 'agent_turn')
  const normalRecord = records.find(record => record.sessionId === normalSession)
  assert.ok(normalRecord, 'canonical managed record missing for the successful remote run')
  assert.equal(normalRecord.provider.id, 'codex')
  assert.ok(normalRecord.tools.value?.length > 0, 'canonical record lacks fixture tool evidence')
  // Receiver revocation is tested after valid TLS; local client state cannot
  // short-circuit this negative check.
  await evaluate(`window.scry.remoteRevokeDevice(${JSON.stringify(localGrant.deviceId)})`)
  const revoked = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: { kind: 'info' } })
  assert.equal(revoked.error, 'device_not_authorized')
  for (const action of ['list', 'select']) {
    const denied = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktopDirectory', query: { action, path: realpathSync(temp) } })
    assert.equal(denied.error, 'device_not_authorized')
  }
  assert.ok(!JSON.parse(readFileSync(join(userDataDir, 'recent-folders.json'), 'utf8')).includes(realpathSync(temp)), 'revoked selection must not persist a grant')
  console.log(JSON.stringify({
    directorySelection: { capability: true, browseDoesNotGrant: true, persistedCanonicalGrant: true, trailingSpaceKept: true, noAgentStart: true, revokedListAndSelectDenied: true },
    appPath, rendererUrl: page.url, hostId: invitation.hostId, pairPort: invitation.pairPort, runPort: invitation.runPort,
    supportedScenarios: ['trusted-local invite/confirm', 'pinned TLS CSR pairing', 'canonical info', 'normal trace/archive', 'duplicate intent', 'unknown receipt intentStatus', 'question cancellation', 'independent same-workspace sessions', 'canonical failed run', 'revocation'],
    fixtureArgs: { provider: 'codex', normalPrompt: 'desktop remote write one', questionPrompt: 'dock badge question smoke', failurePrompt: 'remote provider failure smoke' },
    bounded: { traceItems: activeTrace.desktop.run.items.length, archiveTurns: history.desktop.history.turns.length, canonicalRecords: records.length, scryEntries: scryEntries.length }
  }))

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