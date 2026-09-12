import 'reflect-metadata'
import { createServer, type TLSSocket, type Server } from 'node:tls'
import { constants, createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { X509Certificate } from '@peculiar/x509'
import type { PairingAuthority } from './pairing'

// Device-facing pairing-prove transport. A not-yet-granted device reaches this
// (through the same outer relay) to PROVE possession of its keypair during
// pairing, before it has any CA-signed certificate. It is deliberately separate
// from InnerMtlsHost (which serves only CA-granted devices over strict mTLS):
//
//   - The device presents a SELF-SIGNED client certificate built from its
//     pairing keypair. TLS 1.3 still forces the client to sign CertificateVerify
//     with that key, so a completed handshake PROVES private-key possession even
//     though the cert chains to no CA. rejectUnauthorized is therefore false, but
//     the handshake only completes for a client that actually holds the key.
//   - The host presents its CA-signed serverAuth credential; the device pins the
//     anchor (CA) it learned out of band in the pairing code, so it authenticates
//     the host.
//   - publicKeySHA256 is derived from the VERIFIED PEER CERTIFICATE's
//     SubjectPublicKeyInfo, exactly as verifyCSR derives it from the CSR, and is
//     handed to PairingAuthority.prove/status. The device can never assert its
//     own key fingerprint in the request body.
//
// One line-delimited JSON request/response per connection. The wire is the
// canonical pairing protocol (versioned + requestId-correlated) that the iOS
// device client speaks: request { protocolMajor, requestId, operation:
// 'pair.prove'|'pair.status', pairingId, secret, csrPEM?, deviceLabel? };
// response { protocolMajor, requestId, kind: 'pair.pending'|'pair.granted'|
// 'pair.revoked'|'pair.denied', ... }. The device correlates requestId before
// trusting any field.

export interface PairingTransportOptions {
  authority: PairingAuthority
  // CA-signed serverAuth credential (HostIdentity.issueHostServer()).
  serverCertPEM: string
  serverKeyPEM: string
  maxFrameBytes?: number
}

const DEFAULT_MAX_FRAME = 64 * 1024

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

export class PairingTransport {
  #server: Server
  #maxFrame: number

  constructor(options: PairingTransportOptions) {
    this.#maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_FRAME
    this.#server = createServer({
      key: options.serverKeyPEM,
      cert: options.serverCertPEM,
      // Accept the device's self-signed client cert: we need key possession, not
      // CA trust. The TLS 1.3 handshake still verifies the client's signature.
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      secureOptions: constants.SSL_OP_NO_TICKET
    }, (socket) => this.#onConnection(socket as TLSSocket, options.authority))
    this.#server.on('tlsClientError', () => { /* rejected handshakes are not host errors */ })
  }

  // Serve the pairing endpoint over a relay-delivered byte stream, mirroring
  // InnerMtlsHost.serve so the same Mac relay client bridges both.
  serve(stream: Duplex): void {
    this.#server.emit('connection', stream)
  }

  #onConnection(socket: TLSSocket, authority: PairingAuthority): void {
    // Fail closed on anything but a fresh TLS 1.3 session that presented a client
    // certificate (possession proof). authorized is intentionally NOT required:
    // the pairing cert is self-signed and trusts no CA.
    if (socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) { socket.destroy(); return }
    const peer = socket.getPeerCertificate()
    if (!peer || !peer.raw) { socket.destroy(); return }
    let publicKeySHA256: string
    try { publicKeySHA256 = digest(new Uint8Array(new X509Certificate(peer.raw).publicKey.rawData)) }
    catch { socket.destroy(); return }
    let buffer = Buffer.alloc(0)
    let used = false
    socket.on('data', (bytes: Buffer) => {
      if (used || buffer.length + bytes.length > this.#maxFrame) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      used = true
      void this.#dispatch(authority, publicKeySHA256, buffer.subarray(0, end))
        .then((reply) => socket.end(JSON.stringify(reply) + '\n'))
        .catch(() => socket.destroy())
    })
    socket.on('error', () => { /* peer reset; nothing to report */ })
  }

  async #dispatch(authority: PairingAuthority, publicKeySHA256: string, line: Buffer): Promise<unknown> {
    let request: { protocolMajor?: number; requestId?: string; operation?: string; pairingId?: string; secret?: string; csrPEM?: string; deviceLabel?: string }
    try { request = JSON.parse(line.toString('utf8')) }
    catch { return { protocolMajor: 1, requestId: '', kind: 'pair.denied', code: 'invalid_request' } }
    const requestId = typeof request.requestId === 'string' ? request.requestId : ''
    const deny = (code: string) => ({ protocolMajor: 1, requestId, kind: 'pair.denied', code: code.slice(0, 64) })
    if (request.protocolMajor !== 1 || !requestId) return deny('invalid_request')
    try {
      if (request.operation === 'pair.prove') {
        if (typeof request.pairingId !== 'string' || typeof request.secret !== 'string' || typeof request.csrPEM !== 'string' || typeof request.deviceLabel !== 'string') {
          return deny('invalid_request')
        }
        const receipt = await authority.prove({ pairingId: request.pairingId, secret: request.secret, csrPEM: request.csrPEM, deviceLabel: request.deviceLabel }, publicKeySHA256)
        return this.#encodeReceipt(requestId, request.pairingId, receipt)
      }
      if (request.operation === 'pair.status') {
        if (typeof request.pairingId !== 'string' || typeof request.secret !== 'string') return deny('invalid_request')
        const receipt = await authority.status(request.pairingId, request.secret, publicKeySHA256)
        return this.#encodeReceipt(requestId, request.pairingId, receipt)
      }
      return deny('unknown_op')
    } catch (error) {
      // Pairing failures (bad secret, expired, key mismatch) surface as truthful
      // bounded denial codes, never as a success shape.
      return deny(String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'error'))
    }
  }

  // Map a PairingAuthority receipt to the canonical wire response. A pending
  // receipt NEVER carries a certificate; only a locally-confirmed grant does.
  #encodeReceipt(requestId: string, pairingId: string, receipt: {
    state: string
    publicKeySHA256?: string
    deviceId?: string
    grant?: { deviceId: string; certificatePEM: string; certificateSHA256: string; expiresAt: number }
  }): unknown {
    if (receipt.state === 'awaiting_local_confirmation') {
      return { protocolMajor: 1, requestId, kind: 'pair.pending', pairingId, publicKeySHA256: receipt.publicKeySHA256 }
    }
    if (receipt.state === 'paired' && receipt.grant) {
      return { protocolMajor: 1, requestId, kind: 'pair.granted', pairingId, deviceId: receipt.grant.deviceId, certificatePEM: receipt.grant.certificatePEM, certificateSHA256: receipt.grant.certificateSHA256, expiresAt: receipt.grant.expiresAt, scope: 'g0_echo_only' }
    }
    if (receipt.state === 'revoked') {
      return { protocolMajor: 1, requestId, kind: 'pair.revoked', pairingId, deviceId: receipt.deviceId }
    }
    return { protocolMajor: 1, requestId, kind: 'pair.denied', code: receipt.state.slice(0, 64) }
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, host, () => { this.#server.off('error', reject); resolve() })
    })
    const address = this.#server.address()
    if (!address || typeof address === 'string') throw new Error('pairing_transport_not_listening')
    return { port: address.port, host: address.address }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}
