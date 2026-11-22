import 'reflect-metadata'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, chmodSync, realpathSync, rmSync, writeFileSync, accessSync, constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { RunOutputFileStore } from '../../src/main/remote/run-output-file.ts'
import { PairingTransport } from '../../src/main/remote/pairing-transport.ts'
import { InnerMtlsHost } from '../../src/main/remote/inner-mtls-host.ts'
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { createRelayConnect } from '../../src/main/remote/relay-connect.ts'
import { attachDaemonOrchestrationAuthority } from '../../src/daemon/orchestration-authority.ts'
import { ConversationStore } from '../../src/main/conversation-store.ts'
import { RunRegistry } from '../../src/main/run-registry.ts'
import { REMOTE_PROTOCOL_VERSION } from '../../src/shared/desktop-remote.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'
import { createRelayServer } from './relay-server.mjs'

cryptoProvider.set(webcrypto)
const exec = promisify(execFile)
const HOST_TOKEN = 'relay-run-smoke-token'

// End-to-end RUN-channel smoke: the ACTUAL Swift iOS run client (RemoteRunClient
// / G0Transport.relayRun*) drives fenced submit and subscribe through the production
// relay-server, reverse tunnel, InnerMtlsHost and HostController (gateway +
// dispatcher + gated executor). There is NO iPhone, NO human and NO Provider:
// local confirmation is synthetic and startRun is an in-smoke STUB, so this
// spends zero Provider tokens. It proves the device-side wire + granted-cert
// authorization + the full recorded -> dispatched -> settled/failed lifecycle,
// exactly the seam that was previously untested on the Swift side.
const packagePath = fileURLToPath(new URL('swift/', import.meta.url))
const { stdout: binPath } = await exec('swift', ['build', '--package-path', packagePath, '--show-bin-path'], { timeout: 300_000 })
const probe = join(binPath.trim(), 'scry-remote-probe')
const generator = join(binPath.trim(), 'scry-enrollment-fixture')
accessSync(probe, fsConstants.X_OK)
accessSync(generator, fsConstants.X_OK)

const deviceDir = mkdtempSync(join(tmpdir(), 'scry-g0-relay-run-'))
chmodSync(deviceDir, 0o700)
const hostDir = realpathSync(mkdtempSync(join(tmpdir(), 'scry-relay-run-host-')))
const cleanups = []
const authorizedCwd = join(hostDir, 'authorized-project')
const deniedCwd = join(hostDir, 'denied-project')
mkdirSync(authorizedCwd)
mkdirSync(deniedCwd)
try {
  const { stdout: fingerprintLine } = await exec(generator, [deviceDir], { timeout: 30_000, maxBuffer: 1 << 20 })
  const devicePublicKeySHA256 = fingerprintLine.trim()
  const csrPath = join(deviceDir, 'swift-device.csr')
  const keyPath = join(deviceDir, 'swift-device.key')
  const bootstrapPath = join(deviceDir, 'swift-device-bootstrap.pem')

  const stateDirectory = join(hostDir, 'remote')
  const identity = await ensureHostIdentity(join(stateDirectory, 'identity'))
  const conversations = new ConversationStore(hostDir)
  const orchestration = await attachDaemonOrchestrationAuthority({
    userDataDir: hostDir, env: process.env, conversationStore: () => conversations,
    runs: new RunRegistry(), requestRunStop: () => false, log: () => {}
  })
  cleanups.push(() => orchestration.close())

  // The dispatcher's leaf executor. NOT a Provider: for an authorized cwd it
  // resolves (=> settled); the workspace authorizer fails closed for anything
  // else (=> failed) BEFORE this is reached. Zero token cost either way.
  const started = []
  const binding = await createHostController({
    stateDirectory, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    orchestration: orchestration.hooks,
    readDesktop: async query => {
      assert.equal(query.kind, 'info')
      return { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, execution: 'canonical', hostId: identity.hostId, subscribe: 1 }
    },
    onRunActivity: runId => orchestration.forwardAppEvent({ kind: 'run', runId }),
    authorizeWorkspace: (cwd) => {
      if (cwd === authorizedCwd) return cwd
      const error = new Error('invalid_target'); error.code = 'invalid_target'; throw error
    },
    startRun: async ({ runId, routing, progress, output, stopSignal }) => {
      started.push({ runId, cwd: routing.cwd })
      if (routing.prompt === 'live-stop') {
        // Hold a running stub until the device's stop request aborts it.
        progress('smoke:ack')
        output({ kind: 'output', text: 'waiting for stop' })
        await new Promise((resolve) => stopSignal.addEventListener('abort', resolve, { once: true }))
        throw Object.assign(new Error('interrupted'), { code: 'interrupted' })
      }
      if (routing.prompt === 'live-watch') {
        // Real asynchronous progress: watch must wake per chunk, not on a timer.
        for (const text of ['one', 'two', 'three']) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          output({ kind: 'output', text })
        }
        return
      }
      progress('smoke:ack')
      // Stream real output CONTENT on the separate channel (a Provider would
      // emit trace events here). Distinct from the opaque lifecycle marker above.
      output({ kind: 'output', text: 'stub says hello' })
      output({ kind: 'tool', text: 'Edit /w/file.ts' })
    },
    gate: new ProviderOperationGate(),
    createOutputStore: (directory) => new RunOutputFileStore(directory),
    // Host-authorized project directories the device may target. In production
    // this is knownProjectDirectories(); here a fixed pair proves the wire.
    listProjects: () => [
      { path: authorizedCwd, label: 'authorized-project' },
      { path: '/Projects/storefront', label: 'storefront' }
    ]
  })
  cleanups.unshift(() => binding.close())
  orchestration.startImport()

  const server = await identity.issueHostServer()
  const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
  cleanups.push(() => pairingTransport.close())
  const controller = binding.controller
  const networkSubscribe = orchestration.createSubscribeHandler({
    hostId: () => identity.hostId,
    authorizePeer: (peer) => controller.authorizeDevicePeer(peer),
    grantScope: (peer) => controller.authority.grantScope(peer),
    remoteCwdAuthorizer: () => cwd => cwd === authorizedCwd
  })
  const runHost = new InnerMtlsHost({ controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM,
    caPEM: identity.caCertificatePEM, networkSubscribe })
  cleanups.push(() => runHost.close())

  const relay = createRelayServer({ authorizeHost: ({ hostId, token }) => hostId === identity.hostId && token === HOST_TOKEN })
  const { hostPort, devicePort } = await relay.listen({})
  cleanups.push(() => relay.close())

  const pairConn = createRelayConnect({ host: '127.0.0.1', port: hostPort, hostId: identity.hostId, token: HOST_TOKEN, mode: 'pair' })
  const pairClient = new RelayClient({ host: pairingTransport, transport: new ReverseTunnelTransport({ connect: pairConn.connect, readyEvent: pairConn.readyEvent, poolSize: 2 }) })
  await pairClient.start()
  cleanups.unshift(() => pairClient.close())
  const runConn = createRelayConnect({ host: '127.0.0.1', port: hostPort, hostId: identity.hostId, token: HOST_TOKEN, mode: 'run' })
  const runClient = new RelayClient({ host: runHost, transport: new ReverseTunnelTransport({ connect: runConn.connect, readyEvent: runConn.readyEvent, poolSize: 2 }) })
  await runClient.start()
  cleanups.unshift(() => runClient.close())

  const anchorPath = join(hostDir, 'anchor.pem')
  writeFileSync(anchorPath, identity.caCertificatePEM, { mode: 0o600 })
  const grantedCertPath = join(deviceDir, 'granted.pem')

  const runProbe = async (args) => (await exec(probe, ['relay-run', ...args], { timeout: 30_000, maxBuffer: 1 << 20 })).stdout
  const runArgs = (verb, arg) => [verb, '127.0.0.1', String(devicePort), identity.hostId, anchorPath, grantedCertPath, keyPath, arg]

  // Pair first (synthetic operator confirmation) so the device holds a granted cert.
  const pair = await binding.controller.authority.begin()
  const proveArgs = ['prove', '127.0.0.1', String(devicePort), identity.hostId, anchorPath, bootstrapPath, keyPath, pair.pairingId, pair.secret, csrPath, 'Run Smoke iPhone']
  const pending = (await exec(probe, ['relay-pair', ...proveArgs], { timeout: 30_000, maxBuffer: 1 << 20 })).stdout
  assert.equal(pending.trim(), `pending ${devicePublicKeySHA256}`, pending)
  const grant = await binding.controller.authority.confirmLocal(pair.pairingId, devicePublicKeySHA256)
  writeFileSync(grantedCertPath, grant.certificatePEM, { mode: 0o600 })

  const cases = []
  const waitForState = async (runId, wanted) => {
    const deadline = Date.now() + 10_000
    let state
    while (Date.now() < deadline) {
      state = (await runProbe(runArgs('state', runId))).trim()
      if (['state settled', 'state failed', 'state cancelled'].includes(state)) break
    }
    assert.equal(state, `state ${wanted}`)
  }

  // 1. Authorized cwd: the granted device submits a durable intent and the host
  //    drives it to a terminal SETTLED lifecycle (recorded -> dispatched ->
  //    settled), observed from the Swift client's v3 subscription.
  const okDetailPath = join(deviceDir, 'ok-detail.json')
  writeFileSync(okDetailPath, JSON.stringify({ cwd: authorizedCwd, providerId: 'claude', prompt: 'smoke' }))
  const okSubmit = (await runProbe(runArgs('submit', okDetailPath))).trim()
  assert.match(okSubmit, /^submit [0-9a-f-]{36} recorded$/, okSubmit)
  const okRunId = okSubmit.split(' ')[1]
  await waitForState(okRunId, 'settled')
  assert.ok(started.some(s => s.runId === okRunId && s.cwd === authorizedCwd), 'executor received the authorized run')
  const okState = (await runProbe(runArgs('state', okRunId))).trim()
  assert.equal(okState, 'state settled', okState)
  cases.push({ name: 'Swift run client -> relay -> InnerMtlsHost -> HostController: authorized cwd recorded->dispatched->settled', passed: true })

  // 2. Unauthorized cwd: the host fails closed at the workspace authorizer BEFORE
  //    any executor/Provider runs (recorded -> dispatched -> failed). The device
  //    sees an honest terminal failure, never a fabricated success.
  const badDetailPath = join(deviceDir, 'bad-detail.json')
  writeFileSync(badDetailPath, JSON.stringify({ cwd: deniedCwd, providerId: 'claude', prompt: 'smoke' }))
  const badSubmit = (await runProbe(runArgs('submit', badDetailPath))).trim()
  assert.match(badSubmit, /^submit [0-9a-f-]{36} recorded$/, badSubmit)
  const badRunId = badSubmit.split(' ')[1]
  assert.equal(orchestration.sink.getRun(badRunId)?.lifecycle, 'failed', 'unauthorized run must fail closed')
  const deniedState = (await runProbe(runArgs('state', badRunId))).trim()
  assert.equal(deniedState, 'state none', 'subscription must not disclose an unauthorized workspace')
  assert.ok(!started.some(s => s.runId === badRunId), 'executor never ran the unauthorized run')
  cases.push({ name: 'Swift run client -> unauthorized cwd fails closed at workspace authorizer (no executor)', passed: true })

  // 3. Authorized-project picker: the granted device reads the host-authorized
  //    project directories over the SAME granted-cert inner mTLS. The phone can
  //    never authorize a new directory; it only chooses among these, and the
  //    workspace authorizer re-checks the cwd on submit regardless.
  const projectArgs = ['projects', '127.0.0.1', String(devicePort), identity.hostId, anchorPath, grantedCertPath, keyPath]
  const projectLines = (await runProbe(projectArgs)).trim().split('\n')
  assert.ok(projectLines.includes(`project ${authorizedCwd}`), projectLines.join('|'))
  assert.ok(projectLines.includes('project /Projects/storefront'), projectLines.join('|'))
  assert.ok(projectLines.includes('projects-count 2'), projectLines.join('|'))
  cases.push({ name: 'Swift run client -> host-authorized project list over granted-cert inner mTLS', passed: true })

  // 4. Output streaming: the granted device reads the assistant's real streamed
  //    output CONTENT for the settled run over the SAME granted-cert inner mTLS,
  //    strictly after a cursor. This is trace-derived content, distinct from the
  //    ledger lifecycle; the phone renders it as the actual run output.
  const outputArgs = ['output', '127.0.0.1', String(devicePort), identity.hostId, anchorPath, grantedCertPath, keyPath, okRunId, '0']
  const outputLines = (await runProbe(outputArgs)).trim().split('\n')
  assert.ok(outputLines.includes('output output stub says hello'), outputLines.join('|'))
  assert.ok(outputLines.includes('output tool Edit /w/file.ts'), outputLines.join('|'))
  assert.ok(outputLines.some(l => /^output-cursor [1-9]/.test(l)), outputLines.join('|'))
  // Strictly-after-cursor: re-polling at the last cursor yields no duplicate content.
  const lastCursor = outputLines.find(l => l.startsWith('output-cursor ')).slice('output-cursor '.length)
  const outputArgs2 = ['output', '127.0.0.1', String(devicePort), identity.hostId, anchorPath, grantedCertPath, keyPath, okRunId, lastCursor]
  const outputLines2 = (await runProbe(outputArgs2)).trim().split('\n')
  assert.ok(!outputLines2.some(l => l.startsWith('output output') || l.startsWith('output tool')), outputLines2.join('|'))
  cases.push({ name: 'Swift run client -> real streamed output content over granted-cert inner mTLS (cursor-based)', passed: true })

  // 5. Persistent lanes: ONE RelaySession carries submit and every watch
  //    long-poll. Watch wakes on each real output chunk (300 ms apart), so the
  //    stream is not quantized to a poll interval, and the run settles.
  const liveDetail = join(deviceDir, 'live-watch.json')
  writeFileSync(liveDetail, JSON.stringify({ cwd: authorizedCwd, providerId: 'claude', prompt: 'live-watch' }))
  const liveLines = (await runProbe(runArgs('live', liveDetail).concat('watch'))).trim().split('\n')
  const liveText = liveLines.filter(l => l.startsWith('output output ')).map(l => l.slice('output output '.length))
  assert.deepEqual(liveText, ['one', 'two', 'three'], liveLines.join('|'))
  assert.ok(liveLines.some(l => l.startsWith('watch state=settled')), liveLines.join('|'))
  const liveTotal = Number(liveLines.find(l => l.startsWith('total ms=')).slice('total ms='.length))
  assert.ok(liveTotal < 5_000, `watch must wake on change, total=${liveTotal}`)
  cases.push({ name: 'Swift RelaySession: submit + watch long-poll on persistent lanes stream each chunk and settle', passed: true, liveTotal, lines: liveLines })

  // 6. Stop: the device's stop request reaches the running executor's abort
  //    signal; the lifecycle settles from the executor's own result.
  const stopDetail = join(deviceDir, 'live-stop.json')
  writeFileSync(stopDetail, JSON.stringify({ cwd: authorizedCwd, providerId: 'claude', prompt: 'live-stop' }))
  const stopLines = (await runProbe(runArgs('live', stopDetail).concat('stop'))).trim().split('\n')
  assert.ok(stopLines.includes('live-run remote running self live-stop'), stopLines.join('|'))
  assert.ok(stopLines.some(l => l.startsWith('stop requested ')), stopLines.join('|'))
  assert.ok(stopLines.some(l => /^watch state=(failed|cancelled)/.test(l)), stopLines.join('|'))
  cases.push({ name: 'Swift RelaySession: liveRuns lists the running run on its own lane; stop reaches the executor and the run reaches a real terminal state', passed: true, lines: stopLines })

  console.log(JSON.stringify({ scope: 'REAL Swift iOS run client against production relay + InnerMtlsHost + HostController; synthetic confirmation, stub executor, no iPhone/human/Provider', cases }, null, 2))
} finally {
  for (const c of cleanups) { try { await c() } catch { /* best effort */ } }
  rmSync(deviceDir, { recursive: true, force: true })
  rmSync(hostDir, { recursive: true, force: true })
}
