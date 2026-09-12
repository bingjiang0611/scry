import { createServer, type Server, type TLSSocket } from 'node:tls'
import { constants, createHash } from 'node:crypto'
import type { HostController } from './host-controller'

// Production inner-mTLS host: the TLS 1.3 mutually-authenticated endpoint that a
// paired device reaches (through the outer WSS byte relay, which never sees
// inner keys). It is the transport in front of HostController. Every request is
// authorized by the fingerprint DERIVED FROM THE VERIFIED PEER CERTIFICATE
// (socket.getPeerCertificate().raw), never from anything in the request body -
// the same invariant proven by experiments/remote-g0/g1-smoke, now in src/main.
//
// One line-delimited JSON request/response per connection. This module does no
// authorization itself; it extracts the verified fingerprint and delegates to
// HostController, which fails closed for any non-authorized device.

export interface InnerMtlsHostOptions {
  controller: HostController
  // CA-signed serverAuth credential (HostIdentity.issueHostServer()).
  serverCertPEM: string
  serverKeyPEM: string
  // The pinned inner CA; only device certs chaining to it complete the handshake.
  caPEM: string
  // Bytes cap for a single framed request.
  maxFrameBytes?: number
}

const DEFAULT_MAX_FRAME = 64 * 1024

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

export class InnerMtlsHost {
  #server: Server
  #maxFrame: number

  constructor(options: InnerMtlsHostOptions) {
    this.#maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_FRAME
    this.#server = createServer({
      key: options.serverKeyPEM,
      cert: options.serverCertPEM,
      ca: options.caPEM,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      secureOptions: constants.SSL_OP_NO_TICKET
    }, (socket) => this.#onConnection(socket as TLSSocket, options.controller))
    this.#server.on('tlsClientError', () => { /* rejected handshakes are not host errors */ })
  }

  #onConnection(socket: TLSSocket, controller: HostController): void {
    // Fail closed on anything but a fresh, fully-verified TLS 1.3 session.
    if (!socket.authorized || socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) { socket.destroy(); return }
    const peer = socket.getPeerCertificate()
    const fingerprint = peer && peer.raw ? digest(peer.raw) : ''
    let buffer = Buffer.alloc(0)
    let used = false
    socket.on('data', (bytes: Buffer) => {
      if (used || buffer.length + bytes.length > this.#maxFrame) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      used = true
      socket.end(JSON.stringify(this.#dispatch(controller, fingerprint, buffer.subarray(0, end))) + '\n')
    })
    socket.on('error', () => { /* peer reset; nothing to report */ })
  }

  #dispatch(controller: HostController, fingerprint: string, line: Buffer): unknown {
    let request: { op?: string; intentId?: string; detail?: string; cursor?: number; runId?: string }
    try { request = JSON.parse(line.toString('utf8')) }
    catch { return { error: 'invalid_request' } }
    try {
      if (request.op === 'submit') {
        if (typeof request.intentId !== 'string') return { error: 'invalid_request' }
        return controller.submitIntent(fingerprint, { intentId: request.intentId, detail: request.detail })
      }
      if (request.op === 'poll') {
        if (!Number.isSafeInteger(request.cursor)) return { error: 'invalid_request' }
        return { poll: controller.poll(fingerprint, { cursor: request.cursor as number }) }
      }
      if (request.op === 'runState') {
        if (typeof request.runId !== 'string') return { error: 'invalid_request' }
        return { state: controller.runState(fingerprint, { runId: request.runId }) ?? null }
      }
      return { error: 'unknown_op' }
    } catch (error) {
      // Authorization and ledger failures surface as truthful codes, never as
      // success. The message is bounded and non-secret.
      return { error: String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'error').slice(0, 64) }
    }
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, host, () => { this.#server.off('error', reject); resolve() })
    })
    const address = this.#server.address()
    if (!address || typeof address === 'string') throw new Error('inner_mtls_host_not_listening')
    return { port: address.port, host: address.address }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}
