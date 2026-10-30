import assert from 'node:assert/strict'
import tls from 'node:tls'
import { constants, createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { certificates } from './fixture.mjs'
import { verifyCSR, certificateIssuer } from './enrollment.mjs'
import { PairingAuthority } from '../../src/main/remote/pairing.ts'
import { SessionLedger } from '../../src/main/remote/session-ledger.ts'
import { RemoteGateway } from '../../src/main/remote/remote-gateway.ts'

// End-to-end G1 application-service smoke over a REAL inner-mTLS channel.
//
// The security-critical claim under test: RemoteGateway authorizes a device by
// the certificate fingerprint the host derives from the VERIFIED mTLS peer
// certificate (socket.getPeerCertificate().raw), never from a field in the JSON
// body. A different but still inner-CA-trusted certificate completes the TLS
// handshake yet is refused by the gateway, and a revoked grant is refused on the
// next request. This is a test fixture, not a deployed endpoint; the outer WSS
// relay and its ticket admission are proven separately.

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

const memoryLedgerStore = () => {
  const log = []
  return { assertAvailable() {}, loadAll: () => log.map(e => ({ ...e })), append: e => { log.push({ ...e }) } }
}

// One mTLS request/response per connection, mirroring the echo host shape.
async function gatewayHost(id, gateway) {
  const server = tls.createServer({
    key: await id.read('host.key'), cert: await id.read('host.pem'), ca: await id.read('inner-ca.pem'),
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
    secureOptions: constants.SSL_OP_NO_TICKET
  }, socket => {
    if (!socket.authorized || socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) { socket.destroy(); return }
    const peer = socket.getPeerCertificate()
    const fingerprint = peer && peer.raw ? digest(peer.raw) : ''
    let buffer = Buffer.alloc(0)
    let used = false
    socket.on('data', bytes => {
      if (used || buffer.length + bytes.length > 65_536) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      used = true
      let reply
      try {
        const request = JSON.parse(buffer.subarray(0, end).toString('utf8'))
        if (request.op === 'submit') reply = gateway.submitIntent(fingerprint, { intentId: request.intentId, detail: request.detail })
        else if (request.op === 'poll') reply = { poll: gateway.poll(fingerprint, { cursor: request.cursor }) }
        else if (request.op === 'runState') reply = { state: gateway.runState(fingerprint, { runId: request.runId }) ?? null }
        else reply = { error: 'unknown_op' }
      } catch (error) { reply = { error: String(error.code ?? error.message).slice(0, 64) } }
      socket.end(JSON.stringify(reply) + '\n')
    })
    socket.on('error', () => {})
  })
  server.on('tlsClientError', () => {})
  const port = await listen(server)
  return { port, close: () => new Promise(resolve => server.close(resolve)) }
}

async function call(port, id, certName, keyName, request) {
  const socket = tls.connect({
    port, host: '127.0.0.1', ca: await id.read('inner-ca.pem'),
    cert: await id.read(certName), key: await id.read(keyName), servername: 'scry-host.test',
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3'
  })
  await once(socket, 'secureConnect')
  socket.write(JSON.stringify(request) + '\n')
  let buffer = ''
  for await (const chunk of socket) { buffer += chunk.toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0])
}

const id = await certificates()
const cases = []
try {
  // 1. Enroll: verify the device CSR and issue a real client certificate, then
  //    drive the real pairing authority to a granted owner device.
  const csrPEM = await id.read('device.csr').then(b => b.toString('utf8'))
  const verified = await verifyCSR(csrPEM)
  const rawIssue = await certificateIssuer({ certificatePEM: await id.read('inner-ca.pem'), privateKeyPEM: await id.read('inner-ca.key') })
  const authority = new PairingAuthority({
    store: { assertAvailable() {}, load: () => undefined, commit: () => {} },
    hostId: randomUUID(), anchorSHA256: digest(await id.read('inner-ca.pem')),
    verifyCSR: pem => verifyCSR(pem),
    issue: input => rawIssue({ csrPEM: input.csrPEM, expectedCSRHash: input.csrSHA256, expectedPublicKeySHA256: input.publicKeySHA256, deviceId: input.deviceId })
  })
  const session = await authority.begin()
  await authority.prove({ pairingId: session.pairingId, secret: session.secret, csrPEM, deviceLabel: 'Test iPhone' }, verified.publicKeySHA256)
  const grant = await authority.confirmLocal(session.pairingId, verified.publicKeySHA256)

  // The device will present exactly the issued certificate over mTLS.
  const fs = await import('node:fs/promises')
  await fs.writeFile(id.path('g1-device.pem'), grant.certificatePEM, { mode: 0o600, flag: 'wx' })

  const ledger = new SessionLedger({ store: memoryLedgerStore() })
  const gateway = new RemoteGateway({ authority, ledger })
  const host = await gatewayHost(id, gateway)
  try {
    // 2. The authorized device submits a durable intent over real mTLS.
    const intentId = randomUUID()
    const submit = await call(host.port, id, 'g1-device.pem', 'device.key', { op: 'submit', intentId, detail: 'ship it' })
    assert.equal(submit.status, 'recorded', JSON.stringify(submit))
    assert.ok(/^[0-9a-f-]{36}$/.test(submit.runId), JSON.stringify(submit))

    // 3. Identical payloads replay the receipt; changing the payload must be rejected.
    const retry = await call(host.port, id, 'g1-device.pem', 'device.key', { op: 'submit', intentId, detail: 'ship it' })
    assert.equal(retry.status, 'duplicate', JSON.stringify(retry))
    assert.equal(retry.runId, submit.runId)
    const conflict = await call(host.port, id, 'g1-device.pem', 'device.key', { op: 'submit', intentId, detail: 'again' })
    assert.equal(conflict.error, 'intent_payload_conflict', JSON.stringify(conflict))

    // 4. The trusted host executor drives lifecycle; the device only reads it.
    ledger.markDispatched(submit.runId)
    ledger.markSettled(submit.runId)
    const feed = await call(host.port, id, 'g1-device.pem', 'device.key', { op: 'poll', cursor: 0 })
    assert.deepEqual(feed.poll.events.map(e => e.kind), ['intent_recorded', 'run_dispatched', 'run_settled'])
    const state = await call(host.port, id, 'g1-device.pem', 'device.key', { op: 'runState', runId: submit.runId })
    assert.equal(state.state, 'settled')

    // 5. A different, still inner-CA-trusted certificate completes the TLS
    //    handshake but is NOT a granted device: the gateway refuses it.
    const stranger = await call(host.port, id, 'device.pem', 'device.key', { op: 'submit', intentId: randomUUID() })
    assert.equal(stranger.error, 'device_not_authorized', JSON.stringify(stranger))
    assert.equal(ledger.describe().events, 3, 'stranger must not mutate the ledger')

    // 6. After revocation, the previously-authorized device is refused next call.
    await authority.revoke(grant.deviceId)
    const afterRevoke = await call(host.port, id, 'g1-device.pem', 'device.key', { op: 'poll', cursor: 0 })
    assert.equal(afterRevoke.error, 'device_not_authorized', JSON.stringify(afterRevoke))

    cases.push({ name: 'authorize-by-verified-peer-cert over real mTLS; stranger + revoked refused', passed: true, events: ledger.describe().events })
  } finally { await host.close() }
  console.log(JSON.stringify({ scope: 'G1 RemoteGateway over real inner mTLS; synthetic local confirmation, no iPhone or human', cases }, null, 2))
} finally { await id.cleanup() }
