import { Duplex } from 'node:stream'
import { EnvHttpProxyAgent, WebSocket } from 'undici'
import type { OutboundLeg } from './relay-client'

// Electron's Node WebSocket does not automatically inherit HTTP(S)_PROXY. Use
// undici's env-aware dispatcher so restricted networks can reach the public
// relay while NO_PROXY/local private relays still connect directly.
const relayDispatcher = new EnvHttpProxyAgent()

// Node TLS hands one large plaintext write (e.g. a multi-MB history page) to
// this Duplex as ONE ciphertext chunk. The relay forwards each WebSocket
// message as one frame, and the iOS device rejects frames above 1.5 MiB
// (NIO maxFrameSize), which closed the tunnel and failed every large read.
// Bound each message well below that limit; the bytes stay one ordered stream.
export const MAX_RELAY_WS_MESSAGE_BYTES = 256 * 1024

// Leg heartbeat. The relay cannot see a host connection die (sleep, Wi-Fi
// change, a proxy dropping idle sockets) and would glue a phone to it. Each leg
// sends this text frame; the relay answers without waking and records when, so
// it can pick only live legs and tell the phone the host is offline. Inner TLS
// is always binary, so text frames never enter the tunnel in either direction.
export const RELAY_HOST_PING = '{"t":"ping"}'
export const RELAY_HOST_PONG = '{"t":"pong"}'
export const RELAY_PING_INTERVAL_MS = 10_000
// No pong for this long after one was seen: the leg is dead. Wall-clock time,
// so a Mac that slept through several intervals notices on its first tick.
export const RELAY_PONG_TIMEOUT_MS = 30_000

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
  // Test seams for the heartbeat; production uses the constants above.
  pingIntervalMs?: number
  pongTimeoutMs?: number
  now?: () => number
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

export function createRelayConnectWS(opts: RelayWSOptions): { connect: () => OutboundLeg; readyEvent: 'relaySession' } {
  // An idle relay leg is not a TLS peer yet. Start the inner server only when
  // device bytes arrive, otherwise its handshake deadline expires while idle.
  return { connect: () => wsLeg(opts), readyEvent: 'relaySession' }
}

function wsLeg(opts: RelayWSOptions): OutboundLeg {
  const base = opts.url.replace(/\/+$/, '')
  const url = `${base}/host?host=${encodeURIComponent(opts.hostId)}&mode=${opts.mode}`
  const ws = new WebSocket(url, { dispatcher: relayDispatcher })
  ws.binaryType = 'arraybuffer'
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      const bytes = chunk as Buffer
      try {
        for (let offset = 0; offset < bytes.length; offset += MAX_RELAY_WS_MESSAGE_BYTES) {
          ws.send(bytes.subarray(offset, offset + MAX_RELAY_WS_MESSAGE_BYTES))
        }
        cb()
      } catch (err) { cb(err as Error) }
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
    destroy(err, cb) { stopHeartbeat(); try { ws.close() } catch { /* already closing */ } cb(err) }
  })
  const now = opts.now ?? Date.now
  const pingIntervalMs = opts.pingIntervalMs ?? RELAY_PING_INTERVAL_MS
  const pongTimeoutMs = opts.pongTimeoutMs ?? RELAY_PONG_TIMEOUT_MS
  let heartbeat: ReturnType<typeof setInterval> | undefined
  // Only enforce the deadline once this relay has proved it answers pings:
  // an older relay deployment never does, and its legs must keep working.
  let lastPongAt: number | undefined
  // Last heartbeat tick, sent or skipped: a gap far beyond the interval means
  // this process was suspended.
  let lastTickAt = 0
  const stopHeartbeat = (): void => { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined }
  // Set once device bytes arrive: the relay has glued a phone to this leg.
  let consumed = false
  ws.addEventListener('open', () => {
    // Authenticate (and, for the official relay, claim this host's room), then
    // mark outer connectivity. Inner TLS starts on the first device bytes.
    ws.send(JSON.stringify({ token: opts.token, ...(opts.enroll ? { enroll: true } : {}) }))
    duplex.emit('connect')
    const tick = (): void => {
      const at = now()
      // A gap far beyond the interval means this process was suspended
      // (sleep). Judge staleness against the last pong only after a fresh ping
      // has had a chance to be answered, but never trust a pre-sleep leg.
      const suspended = lastTickAt > 0 && at - lastTickAt > pingIntervalMs * 3
      lastTickAt = at
      if (lastPongAt !== undefined && (suspended || at - lastPongAt > pongTimeoutMs)) {
        stopHeartbeat()
        if (!duplex.destroyed) duplex.destroy(new Error(suspended ? 'relay_leg_suspended' : 'relay_leg_stale'))
        return
      }
      // A relay deployment older than the heartbeat forwards a glued leg's text
      // frames to the phone. Until this relay has answered a ping, ping only
      // legs that carry no phone (an old relay drops those).
      if (lastPongAt === undefined && consumed) return
      try { ws.send(RELAY_HOST_PING) } catch { /* closing */ }
    }
    tick()
    heartbeat = setInterval(tick, pingIntervalMs)
    heartbeat.unref?.()
  })
  ws.addEventListener('message', (event) => {
    const data = event.data
    // Text frames are relay control, never inner-TLS bytes.
    if (typeof data === 'string') {
      if (data === RELAY_HOST_PONG) lastPongAt = now()
      return
    }
    // This leg is no longer available at the relay once device TLS bytes arrive.
    // Notify before delivering bytes; authorization remains entirely in mTLS.
    if (!consumed) { consumed = true; duplex.emit('relaySession') }
    duplex.push(Buffer.from(data as ArrayBuffer))
  })
  ws.addEventListener('close', () => { stopHeartbeat(); duplex.push(null); if (!duplex.destroyed) duplex.destroy() })
  ws.addEventListener('error', () => { if (!duplex.destroyed) duplex.destroy(new Error('relay_ws_error')) })
  return duplex
}
