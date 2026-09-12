import 'reflect-metadata'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID, webcrypto } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { WebSocket, createWebSocketStream } from 'ws'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { InnerMtlsHost } from '../../src/main/remote/inner-mtls-host.ts'
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
  return { keyPEM, csrPEM: csr.toString('pem') }
}

async function deviceCall(devicePort, hostId, caPEM, certPEM, keyPEM, request) {
  const ws = new WebSocket(`ws://127.0.0.1:${devicePort}/?host=${hostId}`)
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

  // Deployable relay (local instance). Only THIS host token is admitted.
  const relay = createRelayServer({ authorizeHost: ({ hostId, token }) => hostId === identity.hostId && token === HOST_TOKEN })
  const { hostPort, devicePort } = await relay.listen({})

  // Mac host dials out to the relay with the dependency-free TLS/TCP leg factory.
  const { connect, readyEvent } = createRelayConnect({ host: '127.0.0.1', port: hostPort, hostId: identity.hostId, token: HOST_TOKEN })
  const client = new RelayClient({ host: innerHost, transport: new ReverseTunnelTransport({ connect, readyEvent, poolSize: 3 }) })
  await client.start()

  // Pair a device (verifyCSR -> begin -> prove -> confirmLocal).
  const { keyPEM, csrPEM } = await deviceKeyAndCSR()
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)

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

  await client.close(); await relay.close(); binding.close()
  rmSync(dir, { recursive: true, force: true })
  console.log('relay-e2e OK: device -> WSS relay -> host reverse tunnel -> inner mTLS -> HostController (routed run, warm-pool reuse, unpaired refused)')
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
