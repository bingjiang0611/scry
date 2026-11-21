import { createServer, type TLSSocket, type Server } from 'node:tls'
import { constants, createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { HostController } from './host-controller'
import type { PairingAuthority } from './pairing'
import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import type { ExecutionTargetRouter } from './execution-targets'
import type { LanAdvertisement } from './remote-lan-listener'
import type { LocalEndpointHandlers } from './host-local-ops'
import { DEFAULT_MAX_FRAME } from './inner-mtls-protocol'
import { serveInnerConnection, type RequestTiming } from './inner-mtls-connection'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import { protocolMismatch } from './remote-protocol'
import { remoteOperationCounters, remoteRequestTrace } from './remote-request-timing'

// Protocol constants live in inner-mtls-protocol.ts; re-exported for callers.
export { HOST_TRANSPORT_CAPABILITIES, INNER_IDLE_TIMEOUT_MS, MAX_MUX_INFLIGHT, WATCH_STREAM_MAX_MS, WATCH_STREAM_WAIT_MS } from './inner-mtls-protocol'

// Production inner-mTLS host: the TLS 1.3 mutually-authenticated endpoint that a
// paired device reaches (through the outer WSS byte relay, which never sees
// inner keys). It is the transport in front of HostController. Every request is
// authorized by the fingerprint DERIVED FROM THE VERIFIED PEER CERTIFICATE
// (socket.getPeerCertificate().raw), never from anything in the request body -
// the same invariant proven by experiments/remote-g0/g1-smoke, now in src/main.
//
// Line-delimited JSON. A request without `keepAlive: true` is a one-shot exchange
// and the connection ends after its reply. A device may opt a connection into
// reuse: every following request must also opt in, and every reply then starts
// with `{"keepAlive":true,` so a client can tell a reusable lane from an older
// one-shot host without guessing. A kept-alive request carrying a numeric `id`
// switches the lane to multiplexed requests (inner-mtls-connection.ts). Reuse
// changes no authorization: each request is re-authorized by HostController
// against the verified peer fingerprint, and by transport scope here.

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
  // How peers reach this endpoint. 'network' (default) covers TCP listeners, the
  // relay tunnel, the LAN route and SSH; 'local' is the daemon's 0600 unix socket.
  // A grant issued over the local socket is refused here when this is 'network', so
  // it cannot be replayed from another machine even if its certificate leaks.
  transport?: 'local' | 'network'
  // Answers `daemonInfo` on this endpoint. The local socket serves it so the App can
  // check the daemon's version, build, and idle state before it uses a grant.
  info?: { version: string; build?: string; activeRuns?: () => number; subscribe?: 1 }
  // App-only work: run controls over the daemon's own registry and the App channels the
  // daemon answers (local ops). Supplied on the local endpoint only; on the network
  // endpoint the ops are absent, not merely refused.
  localEndpoint?: LocalEndpointHandlers
  // Fired when the last live TLS socket for a verified peer closes (used by local-endpoint bridges).
  onPeerDisconnected?: (fingerprint: string) => void
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

// Ops a multiplexed lane answers itself (pushed streams), before request dispatch.
const LANE_OPS = new Set(['watchStream', 'cancel'])

export class InnerMtlsHost {
  #server: Server
  #maxFrame: number
  #transport: 'local' | 'network'
  #info?: InnerMtlsHostOptions['info']
  #connections = new Set<TLSSocket>()
  // Open sockets by verified peer fingerprint, so revoking a device closes the
  // tunnels it holds open instead of waiting for their idle timeout.
  #peers = new Map<string, Set<TLSSocket>>()
  #lanAdvertisement: () => LanAdvertisement | undefined = () => undefined
  #onPeerDisconnected?: (fingerprint: string) => void

  constructor(options: InnerMtlsHostOptions) {
    this.#maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_FRAME
    this.#transport = options.transport ?? 'network'
    this.#info = options.info
    this.#onPeerDisconnected = options.onPeerDisconnected
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
    }, (socket) => this.#onConnection(socket as TLSSocket, options.controller, options.executionTargets, options.localEndpoint))
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

  #onConnection(socket: TLSSocket, controller: HostController, executionTargets?: ExecutionTargetRouter, localEndpoint?: LocalEndpointHandlers): void {
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
    const peerSockets = this.#peers.get(fingerprint) ?? new Set<TLSSocket>()
    peerSockets.add(socket)
    this.#peers.set(fingerprint, peerSockets)
    const connAbort = new AbortController()
    socket.once('close', () => {
      connAbort.abort()
      this.#connections.delete(socket)
      peerSockets.delete(socket)
      if (peerSockets.size === 0 && this.#peers.get(fingerprint) === peerSockets) {
        this.#peers.delete(fingerprint)
        this.#onPeerDisconnected?.(fingerprint)
      }
    })
    serveInnerConnection(socket, {
      controller, fingerprint, certificateExpiresAt, maxFrame: this.#maxFrame,
      preflight: (parsed) => this.#preflight(controller, fingerprint, parsed),
      dispatch: (parsed) => dispatchRemoteRequest(controller, fingerprint, parsed, executionTargets, localEndpoint, () => this.#lanAdvertisement(), connAbort.signal),
      timing: (parsed) => requestTiming(parsed)
    })
  }

  // Checked for every frame before any controller work. The scope rule lives at the
  // transport, not in the request: a grant enrolled over the local socket is only
  // good on the local socket, and revoking takes effect on the next frame. Fail
  // closed: a controller that cannot answer the transport question cannot prove the
  // grant belongs on this transport. Same envelope shape as a controller rejection.
  #preflight(controller: HostController, fingerprint: string, parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const authority: PairingAuthority | undefined = controller.authority
    if (typeof authority?.authorizesCertificate !== 'function' || !authority.authorizesCertificate(fingerprint, this.#transport)) {
      return { error: 'device_not_authorized' }
    }
    // Version handshake: answered here because it describes this endpoint's process,
    // and it must be reachable before the App owns a run or a catalog.
    if (this.#info && parsed?.op === 'daemonInfo') {
      const { version, build, activeRuns, subscribe } = this.#info
      const runs = activeRuns?.()
      return {
        op: 'daemonInfo', version,
        ...(build ? { build } : {}),
        ...(typeof runs === 'number' && Number.isSafeInteger(runs) && runs >= 0 ? { activeRuns: runs } : {}),
        ...(subscribe === 1 ? { subscribe: 1 as const } : {}),
        protocol: REMOTE_PROTOCOL_VERSION
      }
    }
    // Pushed-stream ops never reach request dispatch, so its version gate runs here.
    if (parsed && typeof parsed.op === 'string' && LANE_OPS.has(parsed.op)) {
      const mismatch = protocolMismatch(parsed)
      if (mismatch) return { ...mismatch }
    }
    return undefined
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

  // Called after a grant is revoked. Requests already fail authorization; this
  // drops the peer's open tunnels, including one waiting inside a long poll.
  closePeer(certificateSHA256: string): void {
    for (const socket of this.#peers.get(certificateSHA256) ?? []) socket.destroy()
  }

  async close(): Promise<void> {
    for (const socket of this.#connections) socket.destroy()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}

// Segmented timing for one dispatched request: frame received, dispatch settled,
// response written. Absent when performance recording is off.
function requestTiming(parsed: Record<string, unknown> | undefined): RequestTiming | undefined {
  const timing = remoteRequestTrace('remote.host.request')
  if (!timing) return undefined
  timing.mark('frame_received')
  let outcome: 'completed' | 'error' = 'completed'
  return {
    settled: (response) => {
      timing.mark('dispatch_settled', remoteOperationCounters(parsed))
      outcome = (response as { error?: unknown } | undefined)?.error === undefined ? 'completed' : 'error'
    },
    written: () => {
      timing.mark('response_written')
      timing.finish(remoteOperationCounters(parsed), outcome)
    },
    failed: () => timing.finish(undefined, 'error')
  }
}
