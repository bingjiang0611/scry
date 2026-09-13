// Scry relay on Cloudflare Workers + Durable Objects (SQLite backend).
//
// Same role as experiments/remote-g0/relay-server.mjs: an UNTRUSTED byte
// rendezvous. It never sees inner keys and stores NOTHING; the inner TLS 1.3
// mTLS between device and Mac host is the only security root. (Contrast Etch,
// whose relay stores messages in plaintext R2 for 30 days.) On Cloudflare,
// Workers cannot accept arbitrary inbound TCP, so BOTH sides connect over
// WebSocket:
//
//   - The NAT-bound Mac host opens a warm pool of legs to
//     `/host?host=<hostId>&mode=<run|pair>` and authenticates with a first-frame
//     JSON { token } (per-deploy bearer secret; never in the URL, never logged).
//   - The iOS device opens `/?host=<hostId>&mode=<run|pair>`.
//
// A Durable Object keyed by hostId keeps a separate warm pool per mode and glues
// one device to one host leg, raw-shuttling binary frames both ways. A pairing
// device (mode=pair) can never land on the strict-mTLS run pool and vice versa.
//
// It uses the WebSocket Hibernation API (state.acceptWebSocket + webSocket*
// handlers) so idle warm legs incur NO duration charges. This keeps a personal
// always-on relay comfortably inside the Workers Free plan (SQLite-backed
// Durable Objects are free-tier eligible); no paid plan required.

const HOST_ID = /^[0-9a-f-]{36}$/i
const MODES = new Set(['run', 'pair'])
let COUNTER = 0

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const hostId = url.searchParams.get('host')
    const mode = url.searchParams.get('mode') || 'run'
    if (!hostId || !HOST_ID.test(hostId) || !MODES.has(mode)) return new Response('bad_request', { status: 400 })
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('upgrade_required', { status: 426 })
    // Route every connection for a hostId to the same Durable Object instance so
    // the host's warm legs and the device rendezvous share state.
    const stub = env.RELAY.get(env.RELAY.idFromName(hostId))
    return stub.fetch(request)
  }
}

export class RelayRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  async fetch(request) {
    const url = new URL(request.url)
    const mode = url.searchParams.get('mode') || 'run'
    const isHost = url.pathname === '/host'
    const wsPair = new WebSocketPair()
    const client = wsPair[0]
    const server = wsPair[1]

    if (isHost) {
      // Warm leg: accept for hibernation, tag by role, await the first-frame auth.
      this.state.acceptWebSocket(server, ['host'])
      server.serializeAttachment({ role: 'host', mode, authed: false, id: newId(), deviceId: null })
      return new Response(null, { status: 101, webSocket: client })
    }

    // Device: glue to one warm, authenticated, unpaired host leg for this mode.
    const host = this.#popWarmHost(mode)
    try { const legs = this.state.getWebSockets('host').map((w) => w.deserializeAttachment()).filter(Boolean); console.log(`[relay] device mode=${mode} hostLeg=${host ? 'FOUND' : 'MISSING'} warm{run:${legs.filter((a) => a.mode === 'run' && a.authed && !a.deviceId).length},pair:${legs.filter((a) => a.mode === 'pair' && a.authed && !a.deviceId).length}} total=${legs.length}`) } catch {}
    this.state.acceptWebSocket(server, ['device'])
    if (!host) {
      try { server.close(1013, 'no_host_leg') } catch { /* closing */ }
      return new Response(null, { status: 101, webSocket: client })
    }
    const deviceId = newId()
    server.serializeAttachment({ role: 'device', mode, id: deviceId, hostId: idOf(host) })
    const hostAtt = host.deserializeAttachment()
    hostAtt.deviceId = deviceId
    host.serializeAttachment(hostAtt)
    return new Response(null, { status: 101, webSocket: client })
  }

  // First open, authenticated, unpaired host leg for the mode. DO execution is
  // serialized, so this pop is race-free.
  #popWarmHost(mode) {
    for (const ws of this.state.getWebSockets('host')) {
      const att = ws.deserializeAttachment()
      if (att && att.mode === mode && att.authed && !att.deviceId) return ws
    }
    return null
  }

  #find(id) {
    if (!id) return null
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment()
      if (att && att.id === id) return ws
    }
    return null
  }

  webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment()
    if (!att) { try { ws.close(1011, 'no_state') } catch { /* closing */ } return }
    if (att.role === 'host') {
      if (!att.authed) {
        let ok = false
        try {
          const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const creds = JSON.parse(text)
          ok = creds && typeof creds.token === 'string' && this.#tokenOk(creds.token)
        } catch { ok = false }
        if (!ok) { try { ws.close(1008, 'host_unauthorized') } catch { /* closing */ } return }
        att.authed = true
        ws.serializeAttachment(att)
        console.log(`[relay] host leg authed mode=${att.mode}`)
        return
      }
      // Post-pairing: forward inner-TLS bytes to the glued device.
      const device = this.#find(att.deviceId)
      if (device) { try { device.send(message) } catch { /* closing */ } }
      return
    }
    // Device -> host leg.
    const host = this.#find(att.hostId)
    if (host) { try { host.send(message) } catch { /* closing */ } }
  }

  webSocketClose(ws) { this.#teardown(ws) }
  webSocketError(ws) { this.#teardown(ws) }

  #teardown(ws) {
    const att = ws.deserializeAttachment()
    if (att) {
      const peerId = att.role === 'host' ? att.deviceId : att.hostId
      const peer = this.#find(peerId)
      if (peer) { try { peer.close(1000, 'peer_closed') } catch { /* closing */ } }
    }
    try { ws.close() } catch { /* closing */ }
  }

  // Constant-ish comparison of the per-deploy bearer secret. Cloudflare secrets
  // are set with `wrangler secret put RELAY_TOKEN`.
  #tokenOk(candidate) {
    const expected = this.env.RELAY_TOKEN || ''
    if (typeof candidate !== 'string' || candidate.length !== expected.length || expected.length === 0) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i)
    return diff === 0
  }
}

function newId() {
  return Date.now().toString(36) + '-' + (COUNTER++).toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}
function idOf(ws) {
  const att = ws.deserializeAttachment()
  return att ? att.id : null
}
