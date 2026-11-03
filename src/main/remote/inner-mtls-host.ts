import { createServer, type TLSSocket, type Server } from 'node:tls'
import { constants, createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { HostController } from './host-controller'
import type { ExecutionTargetRouter } from './execution-targets'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import { remoteOperationCounters, remoteRequestTrace } from './remote-request-timing'

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

// Remote prompts may carry a small, explicitly bounded image/text attachment.
// The relay still sees only inner-TLS ciphertext; 1.25 MiB is enough for the
// mobile attachment budget while preventing unbounded buffering.
const DEFAULT_MAX_FRAME = 1_310_720

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

export class InnerMtlsHost {
  #server: Server
  #maxFrame: number
  #connections = new Set<TLSSocket>()

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
    }, (socket) => this.#onConnection(socket as TLSSocket, options.controller, options.executionTargets))
    this.#server.on('tlsClientError', (err) => {
      // Rejected handshakes are not host errors. Optional diagnostics only.
      if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] tlsClientError: ${(err as Error)?.message}`)
    })
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
    // Handshake segment: mTLS verification cost is paid once per connection, and
    // telling it apart from dispatch is the point of the segmentation.
    const handshake = remoteRequestTrace('remote.host.connection')
    handshake?.mark('peer_verified', { connections: 1 })
    handshake?.finish({ connections: 1 })
    this.#connections.add(socket)
    socket.once('close', () => this.#connections.delete(socket))
    let buffer = Buffer.alloc(0)
    let busy = false
    let kept = false
    // Diagnostics only: name why the host tore a channel down, because the device
    // sees every host-side destroy as the same relay `peer_closed`.
    const abort = (reason: string): void => {
      if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] destroy reason=${reason} buffered=${buffer.length}`)
      socket.destroy()
    }
    // This is an idle timeout, not a computation deadline. A history/archive
    // read may legitimately take longer than 30 seconds; the client can cancel
    // the TLS channel when its request is superseded. Disable the idle timer
    // while dispatching and arm it again only after a response is written.
    // One listener for the connection's lifetime; re-arming only resets the timer.
    // Passing a callback per arm would stack a listener per keep-alive request.
    socket.on('timeout', () => abort('idle_timeout'))
    const armIdleTimeout = (): void => { socket.setTimeout(30_000) }
    armIdleTimeout()
    socket.on('data', (bytes: Buffer) => {
      if (busy) { abort('data_while_busy'); return }
      if (Date.now() >= certificateExpiresAt) { abort('certificate_expired'); return }
      if (buffer.length + bytes.length > this.#maxFrame) { abort(`frame_too_large:${buffer.length + bytes.length}`); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      // One outstanding request, never pipelined commands; every request still
      // checks the device grant inside HostController.
      if (end !== buffer.length - 1) { abort('pipelined_request'); return }
      const frame = buffer.subarray(0, end)
      buffer = Buffer.alloc(0)
      // Parse the frame once: keep-alive framing and dispatch share the object.
      let parsed: unknown
      try { parsed = JSON.parse(frame.toString('utf8')) } catch { parsed = undefined }
      const keepAlive = !!(parsed && typeof parsed === 'object' && (parsed as { keepAlive?: unknown }).keepAlive === true)
      if (kept && !keepAlive) { socket.end(JSON.stringify({ error: 'keep_alive_required' }) + '\n'); return }
      kept ||= keepAlive
      busy = true
      socket.setTimeout(0)
      const timing = remoteRequestTrace('remote.host.request')
      timing?.mark('frame_received')
      void dispatchRemoteRequest(controller, fingerprint, parsed, executionTargets)
        .then((res) => {
          busy = false
          timing?.mark('dispatch_settled', remoteOperationCounters(parsed))
          const outcome = (res as { error?: unknown }).error === undefined ? 'completed' : 'error'
          if (keepAlive) {
            // keepAlive must be the first key: clients check this exact prefix.
            const reply = JSON.stringify({ keepAlive: true, ...(res as object) }) + '\n'
            socket.write(reply)
            timing?.mark('response_written')
            armIdleTimeout()
          } else {
            socket.end(JSON.stringify(res) + '\n')
            timing?.mark('response_written')
          }
          timing?.finish(remoteOperationCounters(parsed), outcome)
        })
        .catch((error) => {
          timing?.finish(undefined, 'error')
          abort(`dispatch_threw:${String((error as Error)?.message ?? error).slice(0, 200)}`)
        })
    })
    socket.on('error', (error) => {
      // Peer reset; nothing to report to the device.
      if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] socket error: ${error.message}`)
    })
    if (process.env.SCRY_INNER_MTLS_DEBUG) {
      socket.once('close', (hadError) => console.log(`[inner-mtls] close hadError=${hadError} busy=${busy} buffered=${buffer.length}`))
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
    for (const socket of this.#connections) socket.destroy()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}
