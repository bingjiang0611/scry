import { Duplex } from 'node:stream'
import { EnvHttpProxyAgent, WebSocket } from 'undici'
import type { OutboundLeg } from './relay-client'

// Electron's Node WebSocket does not automatically inherit HTTP(S)_PROXY. Use
// undici's env-aware dispatcher so restricted networks can reach the public
// relay while NO_PROXY/local private relays still connect directly.
const relayDispatcher = new EnvHttpProxyAgent()

// Host-side outbound leg for the Cloudflare Worker relay. On Cloudflare the relay
// speaks WebSocket (Workers cannot accept arbitrary inbound TCP), so the Mac host
// dials each warm reverse-tunnel leg over WSS and adapts it to the Duplex that
// InnerMtlsHost/PairingTransport serve. This uses the Node/Electron GLOBAL
// WebSocket (Node 22+/Electron 42), so Electron main gains no `ws` dependency.
//
// It adds no security: the inner TLS 1.3 mTLS still runs end-to-end over these
// bytes. The first frame is the relay-admission JSON the Worker validates; every
// subsequent binary frame is opaque inner-TLS ciphertext.
export interface RelayWSOptions {
  // Base URL of the relay, e.g. wss://scry-relay.example.workers.dev (no path).
  url: string
  hostId: string
  token: string
  // Official builds use a random per-host token and atomically claim their
  // unguessable relay room on first connect. Explicit legacy deployments keep
  // using their pre-provisioned bearer without requesting enrollment.
  enroll?: boolean
  mode: 'run' | 'pair'
}

export function createRelayConnectWS(opts: RelayWSOptions): { connect: () => OutboundLeg; readyEvent: 'connect' } {
  return { connect: () => wsLeg(opts), readyEvent: 'connect' }
}

function wsLeg(opts: RelayWSOptions): OutboundLeg {
  const base = opts.url.replace(/\/+$/, '')
  const url = `${base}/host?host=${encodeURIComponent(opts.hostId)}&mode=${opts.mode}`
  const ws = new WebSocket(url, { dispatcher: relayDispatcher })
  ws.binaryType = 'arraybuffer'
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      try { ws.send(chunk as Uint8Array); cb() }
      catch (err) { cb(err as Error) }
    },
    // TLS `socket.end(response)` reaches this after queueing its close_notify.
    // Do not close the outer WebSocket immediately: the relay may tear down the
    // device peer before that final TLS record is delivered. The device normally
    // closes after reading the newline; this timer bounds a broken peer.
    final(cb) {
      const timer = setTimeout(() => { try { ws.close(1000) } catch { /* already closing */ } }, 15_000)
      timer.unref()
      cb()
    },
    destroy(err, cb) { try { ws.close() } catch { /* already closing */ } cb(err) }
  })
  ws.addEventListener('open', () => {
    // Authenticate (and, for the official relay, claim this host's room), then
    // hand the leg to ReverseTunnelTransport via 'connect'.
    ws.send(JSON.stringify({ token: opts.token, ...(opts.enroll ? { enroll: true } : {}) }))
    duplex.emit('connect')
  })
  let consumed = false
  ws.addEventListener('message', (event) => {
    // This leg is no longer available at the relay once device TLS bytes arrive.
    // Notify before delivering bytes; authorization remains entirely in mTLS.
    if (!consumed) { consumed = true; duplex.emit('relaySession') }
    const data = event.data
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as ArrayBuffer)
    duplex.push(buf)
  })
  ws.addEventListener('close', () => { duplex.push(null); if (!duplex.destroyed) duplex.destroy() })
  ws.addEventListener('error', () => { if (!duplex.destroyed) duplex.destroy(new Error('relay_ws_error')) })
  return duplex
}
