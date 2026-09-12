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
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { createRelayConnect } from '../../src/main/remote/relay-connect.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'
import { createRelayServer } from './relay-server.mjs'

cryptoProvider.set(webcrypto)
const exec = promisify(execFile)
const HOST_TOKEN = 'relay-pair-smoke-token'

// Build the Swift probe (real iOS transport code) and locate the fixture that
// generates a device keypair + CSR + self-signed bootstrap cert in Keychain
// style. This smoke drives the ACTUAL Swift relay transport (WS + inner TLS 1.3
// mTLS) against the PRODUCTION relay-server, PairingTransport and
// PairingAuthority. There is no iPhone or human here: local confirmation is
// called directly to represent the Mac user pressing approve, so passing this
// is NOT completed device pairing - it is transport + wire + authority interop.
const packagePath = fileURLToPath(new URL('swift/', import.meta.url))
const { stdout: binPath } = await exec('swift', ['build', '--package-path', packagePath, '--show-bin-path'], { timeout: 300_000 })
const probe = join(binPath.trim(), 'scry-remote-probe')
const generator = join(binPath.trim(), 'scry-enrollment-fixture')
accessSync(probe, fsConstants.X_OK)
accessSync(generator, fsConstants.X_OK)

// The fixture insists on a 0700 dir under <tmp>/scry-g0-.
const deviceDir = mkdtempSync(join(tmpdir(), 'scry-g0-relay-pair-'))
chmodSync(deviceDir, 0o700)
const hostDir = mkdtempSync(join(tmpdir(), 'scry-relay-pair-host-'))
const cleanups = []
try {
  const { stdout: fingerprintLine } = await exec(generator, [deviceDir], { timeout: 30_000, maxBuffer: 1 << 20 })
  const devicePublicKeySHA256 = fingerprintLine.trim()
  const csrPath = join(deviceDir, 'swift-device.csr')
  const keyPath = join(deviceDir, 'swift-device.key')
  const bootstrapPath = join(deviceDir, 'swift-device-bootstrap.pem')

  const identity = await ensureHostIdentity(join(hostDir, 'identity'))
  const binding = createHostController({
    stateDirectory: hostDir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: (cwd) => cwd, startRun: async () => {}, gate: new ProviderOperationGate()
  })
  cleanups.push(() => binding.close())
  const server = await identity.issueHostServer()
  const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
  cleanups.push(() => pairingTransport.close())

  const relay = createRelayServer({ authorizeHost: ({ hostId, token }) => hostId === identity.hostId && token === HOST_TOKEN })
  const { hostPort, devicePort } = await relay.listen({})
  cleanups.push(() => relay.close())

  const pairConn = createRelayConnect({ host: '127.0.0.1', port: hostPort, hostId: identity.hostId, token: HOST_TOKEN, mode: 'pair' })
  const pairClient = new RelayClient({ host: pairingTransport, transport: new ReverseTunnelTransport({ connect: pairConn.connect, readyEvent: pairConn.readyEvent, poolSize: 2 }) })
  await pairClient.start()
  cleanups.unshift(() => pairClient.close()) // LIFO: close client (warm legs) before relay

  const anchorPath = join(hostDir, 'anchor.pem')
  writeFileSync(anchorPath, identity.caCertificatePEM, { mode: 0o600 })

  async function relayPair(args) {
    const { stdout } = await exec(probe, ['relay-pair', ...args], { timeout: 30_000, maxBuffer: 1 << 20 })
    return stdout
  }
  const proveArgs = (pairingId, secret) => ['prove', '127.0.0.1', String(devicePort), identity.hostId, anchorPath, bootstrapPath, keyPath, pairingId, secret, csrPath, 'Test iPhone']

  const cases = []
  const pair = await binding.controller.authority.begin()

  // 1. A wrong secret is denied over the real Swift transport; nothing granted.
  const wrong = await relayPair(proveArgs(pair.pairingId, 'z'.repeat(43)))
  assert.match(wrong, /^denied /, wrong)

  // 2. Correct secret + CSR: the Swift device proves possession (self-signed
  //    client cert over inner mTLS) and reaches a pending state whose key
  //    fingerprint the host derived from the TLS peer cert, matching the CSR.
  const pending = await relayPair(proveArgs(pair.pairingId, pair.secret))
  assert.equal(pending.trim(), `pending ${devicePublicKeySHA256}`, pending)
  assert.equal(binding.controller.authority.authorizesCertificate('0'.repeat(64)), false)

  // 3. The Mac user approves (synthetic); a re-prove returns the granted cert.
  const grant = await binding.controller.authority.confirmLocal(pair.pairingId, devicePublicKeySHA256)
  const granted = await relayPair(proveArgs(pair.pairingId, pair.secret))
  const [summary, ...pem] = granted.split('\n')
  const [, deviceId] = summary.split(' ')
  assert.equal(deviceId, grant.deviceId, granted)
  assert.ok(pem.join('\n').includes('BEGIN CERTIFICATE'), granted)
  assert.equal(pem.join('\n').trim(), grant.certificatePEM.trim(), 'device receives exactly the granted certificate')

  cases.push({ name: 'Swift relay transport -> WSS relay -> reverse tunnel -> PairingTransport -> authority: deny/pending/grant', passed: true })
  console.log(JSON.stringify({ scope: 'REAL Swift iOS relay transport against production relay + PairingTransport + PairingAuthority; synthetic local confirmation, no iPhone or human', cases }, null, 2))
} finally {
  for (const c of cleanups) { try { await c() } catch { /* best effort */ } }
  rmSync(deviceDir, { recursive: true, force: true })
  rmSync(hostDir, { recursive: true, force: true })
}
