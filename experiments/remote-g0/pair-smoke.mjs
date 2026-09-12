import assert from 'node:assert/strict'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import { constants } from 'node:crypto'
import { once } from 'node:events'
import { access, writeFile, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws'
import { certificates } from './fixture.mjs'
import { loopbackRelay } from './loopback-relay.mjs'
import { verifyCSR, certificateIssuer } from './enrollment.mjs'
import { decodeWire } from './generated/wire.mjs'
import { PairingAuthority } from '../../src/main/remote/pairing.ts'

const exec = promisify(execFile)
const MAX = 262_144
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const digest = value => createHash('sha256').update(value).digest('hex')

// A test fixture, NOT a production pairing endpoint. The bootstrap channel is
// server-authenticated (the device pinned the host anchor from the QR code);
// the device proves key possession by the in-channel CSR signature, not a
// client certificate it does not yet own. There is no real human here: local
// confirmation is driven directly against the authority to represent the Mac
// user pressing approve. Passing this smoke is NOT completed device pairing.
async function pairingHost(identity, handle) {
  const server = tls.createServer({
    key: await identity.read('host.key'), cert: await identity.read('host.pem'),
    requestCert: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', secureOptions: constants.SSL_OP_NO_TICKET
  }, socket => {
    if (socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) { socket.destroy(); return }
    let buffer = Buffer.alloc(0)
    let used = false
    socket.on('data', async bytes => {
      if (used || buffer.length + bytes.length > 65_536) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      used = true
      try {
        if (end !== buffer.length - 1) throw new Error('unexpected trailing frame')
        const parsed = JSON.parse(buffer.subarray(0, end).toString('utf8'))
        const response = await handle(parsed)
        socket.end(JSON.stringify(response) + '\n')
      } catch { socket.destroy() }
    })
    socket.on('error', () => {})
  })
  const port = await listen(server)
  return { port, close: () => new Promise(resolve => server.close(resolve)) }
}

async function bootstrapRelay(identity, hostPort) {
  const sockets = new Set()
  const streams = new Set()
  const relay = https.createServer({ key: await identity.read('outer.key'), cert: await identity.read('outer.pem'), minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
    (_request, response) => response.writeHead(404).end())
  relay.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX, perMessageDeflate: false })
  relay.on('upgrade', (request, socket, head) => {
    if (request.url !== '/pair') { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  })
  wss.on('connection', ws => {
    ws.on('error', () => {})
    const tcp = net.connect({ host: '127.0.0.1', port: hostPort })
    const tunnel = createWebSocketStream(ws, { highWaterMark: MAX })
    streams.add(tunnel); streams.add(tcp)
    const destroy = () => { tunnel.destroy(); tcp.destroy(); ws.terminate() }
    tunnel.on('error', destroy); tcp.on('error', destroy)
    tcp.on('close', () => { streams.delete(tcp); tunnel.end() })
    tunnel.on('close', () => { streams.delete(tunnel); destroy() })
    tcp.pipe(tunnel).pipe(tcp)
  })
  const port = await listen(relay)
  return {
    port,
    async cleanup() {
      for (const ws of wss.clients) ws.terminate()
      for (const stream of streams) stream.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => wss.close(() => relay.close(resolve)))
    }
  }
}

const packagePath = fileURLToPath(new URL('swift/', import.meta.url))
const { stdout: binPath } = await exec('swift', ['build', '--package-path', packagePath, '--show-bin-path'], { timeout: 30_000 })
const probe = join(binPath.trim(), 'scry-remote-probe')
const generator = join(binPath.trim(), 'scry-enrollment-fixture')
await Promise.all([access(probe, fsConstants.X_OK), access(generator, fsConstants.X_OK)])

const identity = await certificates()
const cases = []
try {
  await exec(generator, [identity.path('')], { timeout: 15_000, maxBuffer: 1024 * 1024 })
  const csrPEM = await readFile(identity.path('swift-device.csr'), 'utf8')
  const csr = await verifyCSR(csrPEM)
  const rawIssue = await certificateIssuer({ certificatePEM: await identity.read('inner-ca.pem'), privateKeyPEM: await identity.read('inner-ca.key') })
  let issuedCount = 0

  const authority = new PairingAuthority({
    store: { assertAvailable() {}, load: () => undefined, commit: () => {} },
    hostId: randomUUID(),
    anchorSHA256: digest(await identity.read('inner-ca.pem')),
    verifyCSR: async pem => verifyCSR(pem),
    issue: async input => { issuedCount++; return rawIssue({ csrPEM: input.csrPEM, expectedCSRHash: input.csrSHA256, expectedPublicKeySHA256: input.publicKeySHA256, deviceId: input.deviceId }) }
  })

  const seen = { proves: 0 }
  const host = await pairingHost(identity, async parsed => {
    if (parsed?.operation === 'pair.prove') {
      const input = decodeWire('PairProofRequest', parsed)
      seen.proves++
      const verified = await verifyCSR(input.csrPEM)
      let receipt
      try { receipt = await authority.prove({ pairingId: input.pairingId, secret: input.secret, csrPEM: input.csrPEM, deviceLabel: input.deviceLabel }, verified.publicKeySHA256) }
      catch (error) { return decodeWire('PairDeniedResponse', { protocolMajor: 1, requestId: input.requestId, kind: 'pair.denied', code: String(error.message).slice(0, 64) }) }
      if (receipt.state === 'awaiting_local_confirmation') return decodeWire('PairPendingResponse', { protocolMajor: 1, requestId: input.requestId, kind: 'pair.pending', pairingId: receipt.pairingId, publicKeySHA256: receipt.publicKeySHA256 })
      if (receipt.state === 'revoked') return decodeWire('PairRevokedResponse', { protocolMajor: 1, requestId: input.requestId, kind: 'pair.revoked', pairingId: input.pairingId, deviceId: receipt.deviceId })
      return decodeWire('PairGrantedResponse', { protocolMajor: 1, requestId: input.requestId, kind: 'pair.granted', pairingId: input.pairingId, deviceId: receipt.grant.deviceId, certificatePEM: receipt.grant.certificatePEM, certificateSHA256: receipt.grant.certificateSHA256, expiresAt: receipt.grant.expiresAt, scope: 'g0_echo_only' })
    }
    // Status alone cannot retrieve a grant on a server-auth-only bootstrap
    // channel; the device must re-prove key possession to receive a credential.
    const input = decodeWire('PairStatusRequest', parsed)
    return decodeWire('PairDeniedResponse', { protocolMajor: 1, requestId: input.requestId, kind: 'pair.denied', code: 're_prove_required' })
  })
  const relay = await bootstrapRelay(identity, host.port)

  async function proveCLI(pairingId, secret) {
    const { stdout } = await exec(probe, ['pair', 'prove', String(relay.port), identity.path('outer-ca.pem'), identity.path('inner-ca.pem'), pairingId, secret, identity.path('swift-device.csr'), 'Test iPhone'], { timeout: 20_000, maxBuffer: 1024 * 1024 })
    return stdout
  }

  try {
    // 1. A wrong secret is denied and never reaches issuance or confirmation.
    const session = await authority.begin()
    const wrong = await proveCLI(session.pairingId, 'z'.repeat(43))
    assert.match(wrong, /^denied invalid_pairing_proof\n?$/, wrong)
    assert.equal(issuedCount, 0)

    // 2. Correct secret + CSR yields only a pending state before confirmation.
    const pending = await proveCLI(session.pairingId, session.secret)
    assert.equal(pending.trim(), `pending ${csr.publicKeySHA256}`, pending)
    assert.equal(issuedCount, 0, 'no certificate before local confirmation')
    assert.equal(authority.authorizesCertificate(csr.csrSHA256), false)

    // 3. The Mac user approves (synthetic here); a granted cert is returned.
    const grant = await authority.confirmLocal(session.pairingId, csr.publicKeySHA256)
    assert.equal(issuedCount, 1)
    const granted = await proveCLI(session.pairingId, session.secret)
    const [summary, ...pem] = granted.split('\n')
    const [, deviceId] = summary.split(' ')
    assert.equal(deviceId, grant.deviceId, granted)
    const certificatePEM = pem.join('\n')
    assert.ok(certificatePEM.includes('BEGIN CERTIFICATE'), granted)
    assert.equal(certificatePEM.trim(), grant.certificatePEM.trim(), 'device receives exactly the granted certificate')

    // 4. The issued credential is a real working mTLS identity: use it on the
    //    echo business channel and confirm the encrypted round trip.
    await writeFile(identity.path('paired-device.pem'), certificatePEM, { mode: 0o600, flag: 'wx' })
    const sentinel = 'scry-g0-paired-' + randomUUID()
    const echo = await loopbackRelay(identity, { sentinel })
    try {
      const { stdout } = await exec(probe, [String(echo.port), identity.path('outer-ca.pem'), identity.path('inner-ca.pem'), identity.path('paired-device.pem'), identity.path('swift-device.key'), sentinel], { timeout: 20_000, maxBuffer: 1024 * 1024 })
      assert.equal(decodeWire('ProbeResponse', JSON.parse(stdout)).payload, sentinel)
      assert.equal(echo.stats.requests, 1)
      assert.deepEqual(echo.stats.innerTLS, [{ protocol: 'TLSv1.3', resumed: false }])
      assert.equal(echo.stats.plaintextObserved, false)
    } finally { await echo.cleanup() }

    // 5. Revoke, then even a valid secret + CSR must no longer be granted.
    await authority.revoke(grant.deviceId)
    assert.equal(authority.authorizesCertificate(grant.certificateSHA256), false)
    const afterRevoke = await proveCLI(session.pairingId, session.secret)
    assert.match(afterRevoke, /^revoked /, afterRevoke)

    cases.push({ name: 'bootstrap prove → local confirm → grant → mTLS echo → revoke', passed: true, proves: seen.proves, issued: issuedCount })
  } finally { await relay.cleanup(); await host.close() }
  console.log(JSON.stringify({ scope: 'G0 pairing state machine over a real host-authenticated bootstrap channel; synthetic local confirmation, no iPhone or human', cases }, null, 2))
} finally { await identity.cleanup() }
