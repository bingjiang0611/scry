// Strongest sandbox-possible check for real-device pairing through Cloudflare:
// the REAL Swift iOS relay transport completes a full deny/pending/grant pairing
// conversation against the PRODUCTION host stack (PairingTransport +
// PairingAuthority + reverse tunnel) glued by the ACTUAL relay Worker + Durable
// Object code, running under local workerd (byte-identical to the deployed
// artifact). Loopback needs no proxy, so this exercises the true Worker byte
// shuttle + warm-pool rendezvous + inner TLS 1.3 mTLS end-to-end.
//
// What this still does NOT prove (honest boundary): the deployed public edge
// over real internet, the device's `.system` outer-TLS to Cloudflare's public
// root, and a human on a physical iPhone. Those need the user's real Mac +
// device + network; see docs/research/scry-ios-remote-test-deployment.md.
//
//   node --import ./ts-relative-resolve.mjs cf-relay-pair-smoke.mjs
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
import { unstable_dev } from 'wrangler'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { PairingTransport } from '../../src/main/remote/pairing-transport.ts'
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { createRelayConnectWS } from '../../src/main/remote/relay-connect-ws.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'

cryptoProvider.set(webcrypto)
const exec = promisify(execFile)
const TOKEN = 'local-dev-token'

// Build the real Swift probe + the device-material fixture (keypair + CSR +
// self-signed bootstrap cert). This drives the ACTUAL iOS transport code.
const packagePath = fileURLToPath(new URL('swift/', import.meta.url))
const cfDir = fileURLToPath(new URL('cf-relay/', import.meta.url))
const { stdout: binPath } = await exec('swift', ['build', '--package-path', packagePath, '--show-bin-path'], { timeout: 300_000 })
const probe = join(binPath.trim(), 'scry-remote-probe')
const generator = join(binPath.trim(), 'scry-enrollment-fixture')
accessSync(probe, fsConstants.X_OK)
accessSync(generator, fsConstants.X_OK)

const deviceDir = mkdtempSync(join(tmpdir(), 'scry-g0-cf-pair-'))
chmodSync(deviceDir, 0o700)
const hostDir = mkdtempSync(join(tmpdir(), 'scry-cf-pair-host-'))
const cleanups = []
let worker
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

  // The ACTUAL relay Worker + Durable Object under local workerd.
  worker = await unstable_dev(cfDir + 'src/worker.js', {
    config: cfDir + 'wrangler.toml',
    vars: { RELAY_TOKEN: TOKEN },
    experimental: { disableExperimentalWarning: true }
  })
  const base = `ws://127.0.0.1:${worker.port}`

  // Production host pair leg over the Worker: a bigger warm pool because each
  // completed prove consumes (and the tunnel then replenishes) one leg.
  const pairConn = createRelayConnectWS({ url: base, hostId: identity.hostId, token: TOKEN, mode: 'pair' })
  const pairClient = new RelayClient({ host: pairingTransport, transport: new ReverseTunnelTransport({ connect: pairConn.connect, readyEvent: pairConn.readyEvent, poolSize: 4 }) })
  await pairClient.start()
  cleanups.unshift(() => pairClient.close()) // LIFO: warm legs before the Worker
  await new Promise((r) => setTimeout(r, 1500)) // warm legs register with the DO

  const anchorPath = join(hostDir, 'anchor.pem')
  writeFileSync(anchorPath, identity.caCertificatePEM, { mode: 0o600 })

  // Each call is a fresh Swift process dialing ws://127.0.0.1:<workerd>/?host=&mode=pair,
  // so the Worker pops a warm host leg and glues raw bytes; inner TLS 1.3 mTLS
  // runs host<->device on top. A brief settle lets the tunnel replenish the pool.
  async function relayPair(args) {
    const { stdout } = await exec(probe, ['relay-pair', ...args], { timeout: 30_000, maxBuffer: 1 << 20 })
    await new Promise((r) => setTimeout(r, 700))
    return stdout
  }
  const proveArgs = (pairingId, secret) => ['prove', '127.0.0.1', String(worker.port), identity.hostId, anchorPath, bootstrapPath, keyPath, pairingId, secret, csrPath, 'CF Test iPhone']

  const cases = []
  const pair = await binding.controller.authority.begin()

  // 1. Wrong secret is denied over the real transport, through the real Worker.
  const wrong = await relayPair(proveArgs(pair.pairingId, 'z'.repeat(43)))
  assert.match(wrong, /^denied /, wrong)

  // 2. Correct secret + CSR: device proves possession (self-signed client cert
  //    over inner mTLS); host derives the SAME key fingerprint from the verified
  //    TLS peer cert, all shuttled through the Worker + DO.
  const pending = await relayPair(proveArgs(pair.pairingId, pair.secret))
  assert.equal(pending.trim(), `pending ${devicePublicKeySHA256}`, pending)
  assert.equal(binding.controller.authority.authorizesCertificate('0'.repeat(64)), false)

  // 3. Synthetic local approval (stands in for the Mac user), then a re-prove
  //    returns exactly the granted certificate back across the Worker.
  const grant = await binding.controller.authority.confirmLocal(pair.pairingId, devicePublicKeySHA256)
  const granted = await relayPair(proveArgs(pair.pairingId, pair.secret))
  const [summary, ...pem] = granted.split('\n')
  const [, deviceId] = summary.split(' ')
  assert.equal(deviceId, grant.deviceId, granted)
  assert.equal(pem.join('\n').trim(), grant.certificatePEM.trim(), 'device receives exactly the granted certificate through the Worker')

  cases.push({ name: 'REAL Swift iOS transport -> actual relay Worker + Durable Object (local workerd) -> reverse tunnel -> PairingTransport -> authority: deny/pending/grant with inner TLS 1.3 mTLS', passed: true })
  console.log(JSON.stringify({ scope: 'REAL Swift iOS relay transport pairing through the ACTUAL Cloudflare relay Worker + DO under local workerd; synthetic local confirmation, no iPhone/human/deployed-edge', cases }, null, 2))
} finally {
  for (const c of cleanups) { try { await c() } catch { /* best effort */ } }
  if (worker) await worker.stop()
  rmSync(deviceDir, { recursive: true, force: true })
  rmSync(hostDir, { recursive: true, force: true })
}
