import 'reflect-metadata'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID, webcrypto } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { WebSocket, createWebSocketStream } from 'ws'
import { Pkcs10CertificateRequestGenerator, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { InnerMtlsHost } from '../../src/main/remote/inner-mtls-host.ts'
import { PairingTransport } from '../../src/main/remote/pairing-transport.ts'
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { createRelayConnect } from '../../src/main/remote/relay-connect.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'
import { createRelayServer } from './relay-server.mjs'

// Full outer-relay end-to-end WITHOUT the cloud: a device runs inner TLS 1.3
// mTLS over a real WSS connection to the deployable relay-server, which pairs it
// with the Mac host's authenticated reverse-tunnel leg and raw-shuttles bytes.
// The device reaches the production HostController and its run is routed. This
// is the same code path a deployed relay uses; only the address/credentials and
// outer-TLS termination differ in production.

cryptoProvider.set(webcrypto)
const AUTHORIZED = '/authorized/project'
const HOST_TOKEN = 'provisioned-host-token'

async function deviceKeyAndCSR() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  const selfSigned = await X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name: 'CN=device', notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 3_600_000), keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return { keyPEM, csrPEM: csr.toString('pem'), selfSignedPEM: selfSigned.toString('pem') }
}

async function deviceCall(devicePort, hostId, caPEM, certPEM, keyPEM, request, mode = 'run') {
  const ws = new WebSocket(`ws://127.0.0.1:${devicePort}/?host=${hostId}&mode=${mode}`)
  await once(ws, 'open')
  const duplex = createWebSocketStream(ws)
  const socket = tlsConnect({ socket: duplex, ca: caPEM, cert: certPEM, key: keyPEM, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
  await once(socket, 'secureConnect')
  socket.write(JSON.stringify(request) + '\n')
  let buffer = ''
  for await (const chunk of socket) { buffer += chunk.toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy(); ws.close()
  return JSON.parse(buffer.split('\n')[0])
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-relay-e2e-'))
  const seen = []
  const identity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = createHostController({
    stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('no'); return cwd },
    startRun: async ({ routing }) => { seen.push(routing) }, gate: new ProviderOperationGate()
  })
  const controller = binding.controller
  const server = await identity.issueHostServer()
  const innerHost = new InnerMtlsHost({ controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
  const pairingTransport = new PairingTransport({ authority: controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })

  // Deployable relay (local instance). Only THIS host token is admitted.
  const relay = createRelayServer({ authorizeHost: ({ hostId, token }) => hostId === identity.hostId && token === HOST_TOKEN })
  const { hostPort, devicePort } = await relay.listen({})

  // Mac host dials out to the relay with the dependency-free TLS/TCP leg factory,
  // one reverse tunnel per mode (run + pair).
  const runConn = createRelayConnect({ host: '127.0.0.1', port: hostPort, hostId: identity.hostId, token: HOST_TOKEN, mode: 'run' })
  const pairConn = createRelayConnect({ host: '127.0.0.1', port: hostPort, hostId: identity.hostId, token: HOST_TOKEN, mode: 'pair' })
  const runClient = new RelayClient({ host: innerHost, transport: new ReverseTunnelTransport({ connect: runConn.connect, readyEvent: runConn.readyEvent, poolSize: 3 }) })
  const pairClient = new RelayClient({ host: pairingTransport, transport: new ReverseTunnelTransport({ connect: pairConn.connect, readyEvent: pairConn.readyEvent, poolSize: 2 }) })
  await runClient.start(); await pairClient.start()

  // Pair a device over the relay: the device proves possession with a self-signed
  // client cert on the PAIR endpoint, then the Mac confirms locally.
  const { keyPEM, csrPEM, selfSignedPEM } = await deviceKeyAndCSR()
  const pair = await controller.authority.begin()
  const proved = await deviceCall(devicePort, identity.hostId, identity.caCertificatePEM, selfSignedPEM, keyPEM, { op: 'prove', pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, 'pair')
  assert.equal(proved.receipt.state, 'awaiting_local_confirmation')
  const grant = await controller.authority.confirmLocal(pair.pairingId, proved.receipt.publicKeySHA256)

  // Device submits an intent through the real relay + WSS + inner mTLS.
  const submit = await deviceCall(devicePort, identity.hostId, identity.caCertificatePEM, grant.certificatePEM, keyPEM, { op: 'submit', intentId: randomUUID(), detail: JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', prompt: 'go' }) })
  assert.equal(submit.status, 'recorded')
  await controller.idle()
  assert.deepEqual(seen, [{ cwd: AUTHORIZED, providerId: 'claude', prompt: 'go' }])

  // A second session reuses the warm pool, and the ledger feed is observable.
  const feed = await deviceCall(devicePort, identity.hostId, identity.caCertificatePEM, grant.certificatePEM, keyPEM, { op: 'poll', cursor: 0 })
  assert.deepEqual(feed.poll.events.map((e) => e.kind), ['intent_recorded', 'run_dispatched', 'run_settled'])

  // An unpaired (CA-trusted but never granted) device is refused across the relay.
  const stranger = await deviceKeyAndCSR()
  const strangerVerified = await identity.verifyCSR(stranger.csrPEM)
  const strangerCert = await identity.issue({ ...strangerVerified, deviceId: randomUUID() })
  const refused = await deviceCall(devicePort, identity.hostId, identity.caCertificatePEM, strangerCert.certificatePEM, stranger.keyPEM, { op: 'submit', intentId: randomUUID(), detail: JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude' }) })
  assert.equal(refused.error, 'device_not_authorized')

  await runClient.close(); await pairClient.close(); await relay.close(); binding.close()
  rmSync(dir, { recursive: true, force: true })
  console.log('relay-e2e OK: pair over relay (self-signed prove) + run over relay (mTLS) -> HostController (routed run, warm-pool reuse, unpaired refused)')
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
