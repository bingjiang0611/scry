import { createServer, type TLSSocket, type Server } from 'node:tls'
import { constants, createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { HostController } from './host-controller'
import type { ExecutionTargetRouter } from './execution-targets'
import type { LanAdvertisement } from './remote-lan-listener'
import { DEFAULT_MAX_FRAME } from './inner-mtls-protocol'
import { serveInnerConnection } from './inner-mtls-connection'
import { dispatchInnerRequest } from './inner-mtls-dispatch'

// Protocol constants live in inner-mtls-protocol.ts; re-exported for callers.
export { HOST_TRANSPORT_CAPABILITIES, INNER_IDLE_TIMEOUT_MS, MAX_MUX_INFLIGHT, WATCH_STREAM_MAX_MS, WATCH_STREAM_WAIT_MS } from './inner-mtls-protocol'

// Production inner-mTLS host: the TLS 1.3 mutually-authenticated endpoint that a
// paired device reaches (through the outer WSS byte relay, which never sees
// inner keys). It is the transport in front of HostController. Every request is
// authorized by the fingerprint DERIVED FROM THE VERIFIED PEER CERTIFICATE
// (socket.getPeerCertificate().raw), never from anything in the request body -
// the same invariant proven by experiments/remote-g0/g1-smoke, now in src/main.
//
// Line-delimited JSON, one outstanding request at a time. A request without
// `keepAlive: true` is a one-shot exchange and the connection ends after its
// reply. A device may opt a connection into reuse: every following request must
// also opt in, and every reply then starts with `{"keepAlive":true,` so a client
// can tell a reusable lane from an older one-shot host without guessing. Reuse
// changes no authorization: each request re-derives nothing from the body and is
// re-authorized by HostController against the verified peer fingerprint.

export interface InnerMtlsHostOptions {
  controller: HostController
  // CA-signed serverAuth credential (HostIdentity.issueHostServer()).
  serverCertPEM: string
  serverKeyPEM: string
  // The pinned inner CA; only device certs chaining to it complete the handshake.
  caPEM: string
  // Bytes cap for a single framed request.
  maxFrameBytes?: number
  // Optional Mac1 -> Mac2 target route. Local mobile operations never use it.
  executionTargets?: ExecutionTargetRouter
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

export class InnerMtlsHost {
  #server: Server
  #maxFrame: number
  #connections = new Set<TLSSocket>()
  #lanAdvertisement: () => LanAdvertisement | undefined = () => undefined

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
      secureOptions: constants.SSL_OP_NO_TICKET,
      // Relay legs start TLS only once device bytes arrive and direct LAN
      // peers are unauthenticated until the handshake ends: bound it.
      handshakeTimeout: 10_000
    }, (socket) => this.#onConnection(socket as TLSSocket, options.controller, options.executionTargets))
    this.#server.on('tlsClientError', (err) => {
      // Rejected handshakes are not host errors. Optional diagnostics only.
      if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] tlsClientError: ${(err as Error)?.message}`)
    })
  }

  // Direct-route addresses reported to an authorized phone's ping. Set once the
  // LAN listener is up; absent, phones keep using the relay.
  setLanAdvertisement(source: () => LanAdvertisement | undefined): void {
    this.#lanAdvertisement = source
  }

  // Serve inner-mTLS over an already-established byte stream (e.g. one leg of the
  // outer WSS relay). The stream is handed to the same configured TLS server as
  // listen(), so it inherits the identical credentials, TLS 1.3 pinning,
  // requestCert/rejectUnauthorized policy and per-connection authorization.
  serve(stream: Duplex): void {
    this.#server.emit('connection', stream)
  }

  #onConnection(socket: TLSSocket, controller: HostController, executionTargets?: ExecutionTargetRouter): void {
    // Fail closed on anything but a fresh, fully-verified TLS 1.3 session.
    if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] onConnection authorized=${socket.authorized} authErr=${socket.authorizationError} proto=${socket.getProtocol()} reused=${socket.isSessionReused()}`)
    if (!socket.authorized || socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) { socket.destroy(); return }
    const peer = socket.getPeerCertificate()
    const fingerprint = peer && peer.raw ? digest(peer.raw) : ''
    const certificateExpiresAt = Date.parse(peer.valid_to)
    if (!Number.isFinite(certificateExpiresAt)) { socket.destroy(); return }
    this.#connections.add(socket)
    socket.once('close', () => this.#connections.delete(socket))
    const request = { controller, fingerprint, ...(executionTargets ? { executionTargets } : {}), lanAdvertisement: () => this.#lanAdvertisement() }
    serveInnerConnection(socket, {
      controller, fingerprint, certificateExpiresAt, maxFrame: this.#maxFrame,
      dispatch: (parsed) => dispatchInnerRequest(request, parsed)
    })
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
    for (const socket of this.#connections) socket.destroy()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}
