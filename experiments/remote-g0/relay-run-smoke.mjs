import 'reflect-metadata'
import assert from 'node:assert/strict'
import { mkdtempSync, chmodSync, rmSync, writeFileSync, accessSync, constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { PairingTransport } from '../../src/main/remote/pairing-transport.ts'
import { InnerMtlsHost } from '../../src/main/remote/inner-mtls-host.ts'
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { createRelayConnect } from '../../src/main/remote/relay-connect.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'
import { createRelayServer } from './relay-server.mjs'

cryptoProvider.set(webcrypto)
const exec = promisify(execFile)
const HOST_TOKEN = 'relay-run-smoke-token'

// End-to-end RUN-channel smoke: the ACTUAL Swift iOS run client (RemoteRunClient
// / G0Transport.relayRun*) drives submit/poll/runState through the production
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
const hostDir = mkdtempSync(join(tmpdir(), 'scry-relay-run-host-'))
const cleanups = []
const authorizedCwd = join(hostDir, 'authorized-project')
try {
  const { stdout: fingerprintLine } = await exec(generator, [deviceDir], { timeout: 30_000, maxBuffer: 1 << 20 })
  const devicePublicKeySHA256 = fingerprintLine.trim()
  const csrPath = join(deviceDir, 'swift-device.csr')
  const keyPath = join(deviceDir, 'swift-device.key')
  const bootstrapPath = join(deviceDir, 'swift-device-bootstrap.pem')

  const identity = await ensureHostIdentity(join(hostDir, 'identity'))

  // The dispatcher's leaf executor. NOT a Provider: for an authorized cwd it
  // resolves (=> settled); the workspace authorizer fails closed for anything
  // else (=> failed) BEFORE this is reached. Zero token cost either way.
  const started = []
  const binding = createHostController({
    stateDirectory: hostDir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: (cwd) => {
      if (cwd === authorizedCwd) return cwd
      const error = new Error('invalid_target'); error.code = 'invalid_target'; throw error
    },
    startRun: async ({ runId, routing, progress }) => { started.push({ runId, cwd: routing.cwd }); progress('smoke:ack') },
    gate: new ProviderOperationGate()
  })
  cleanups.push(() => binding.close())

  const server = await identity.issueHostServer()
  const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
  cleanups.push(() => pairingTransport.close())
  const runHost = new InnerMtlsHost({ controller: binding.controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
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
  const pollTerminal = async (runId, want) => {
    let cursor = 0
    for (let i = 0; i < 40; i++) {
      const lines = (await runProbe(runArgs('poll', String(cursor)))).trim().split('\n')
      for (const line of lines) {
        if (line.startsWith('poll-cursor ')) cursor = Number(line.slice('poll-cursor '.length))
        else if (line.startsWith('event ') && line.endsWith(' ' + runId)) {
          const kind = line.split(' ')[1]
          if (kind === want) return true
          if (kind === 'run_settled' || kind === 'run_failed' || kind === 'run_cancelled') return kind
        }
      }
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  }

  // 1. Authorized cwd: the granted device submits a durable intent and the host
  //    drives it to a terminal SETTLED lifecycle (recorded -> dispatched ->
  //    settled), observed purely by polling the ledger from the Swift client.
  const okDetailPath = join(deviceDir, 'ok-detail.json')
  writeFileSync(okDetailPath, JSON.stringify({ cwd: authorizedCwd, providerId: 'claude', prompt: 'smoke' }))
  const okSubmit = (await runProbe(runArgs('submit', okDetailPath))).trim()
  assert.match(okSubmit, /^submit [0-9a-f-]{36} recorded$/, okSubmit)
  const okRunId = okSubmit.split(' ')[1]
  assert.equal(await pollTerminal(okRunId, 'run_settled'), true, 'authorized run must settle')
  assert.ok(started.some(s => s.runId === okRunId && s.cwd === authorizedCwd), 'executor received the authorized run')
  const okState = (await runProbe(runArgs('state', okRunId))).trim()
  assert.equal(okState, 'state settled', okState)
  cases.push({ name: 'Swift run client -> relay -> InnerMtlsHost -> HostController: authorized cwd recorded->dispatched->settled', passed: true })

  // 2. Unauthorized cwd: the host fails closed at the workspace authorizer BEFORE
  //    any executor/Provider runs (recorded -> dispatched -> failed). The device
  //    sees an honest terminal failure, never a fabricated success.
  const badDetailPath = join(deviceDir, 'bad-detail.json')
  writeFileSync(badDetailPath, JSON.stringify({ cwd: '/scry-run-smoke-unauthorized', providerId: 'claude', prompt: 'smoke' }))
  const badSubmit = (await runProbe(runArgs('submit', badDetailPath))).trim()
  assert.match(badSubmit, /^submit [0-9a-f-]{36} recorded$/, badSubmit)
  const badRunId = badSubmit.split(' ')[1]
  assert.equal(await pollTerminal(badRunId, 'run_failed'), true, 'unauthorized run must fail closed')
  assert.ok(!started.some(s => s.runId === badRunId), 'executor never ran the unauthorized run')
  cases.push({ name: 'Swift run client -> unauthorized cwd fails closed at workspace authorizer (no executor)', passed: true })

  console.log(JSON.stringify({ scope: 'REAL Swift iOS run client against production relay + InnerMtlsHost + HostController; synthetic confirmation, stub executor, no iPhone/human/Provider', cases }, null, 2))
} finally {
  for (const c of cleanups) { try { await c() } catch { /* best effort */ } }
  rmSync(deviceDir, { recursive: true, force: true })
  rmSync(hostDir, { recursive: true, force: true })
}
