// Scry relay on Cloudflare Workers + Durable Objects.
//
// Same role as experiments/remote-g0/relay-server.mjs: an UNTRUSTED byte
// rendezvous. It never sees inner keys; the inner TLS 1.3 mTLS between device
// and Mac host is the only security root. On Cloudflare, Workers cannot accept
// arbitrary inbound TCP, so BOTH sides connect over WebSocket:
//
//   - The NAT-bound Mac host opens a warm pool of WebSocket legs to
//     `/host?host=<hostId>&mode=<run|pair>` and authenticates with a first-frame
//     JSON { token } (per-deploy bearer secret; never in the URL, never logged).
//   - The iOS device opens `/?host=<hostId>&mode=<run|pair>`.
//
// A Durable Object keyed by hostId keeps a separate warm pool per mode and glues
// one device to one host leg, raw-shuttling binary frames both ways. A pairing
// device (mode=pair) can never land on the strict-mTLS run pool and vice versa.

const HOST_ID = /^[0-9a-f-]{36}$/i
const MODES = new Set(['run', 'pair'])
const OPEN = 1

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
    this.env = env
    this.warm = new Map() // mode -> array of host-leg WebSockets
  }

  #push(mode, ws) {
    const legs = this.warm.get(mode) || []
    legs.push(ws)
    this.warm.set(mode, legs)
  }

  #pop(mode) {
    const legs = this.warm.get(mode)
    while (legs && legs.length > 0) {
      const ws = legs.shift()
      if (ws.readyState === OPEN && !ws._device) return ws
    }
    return null
  }

  async fetch(request) {
    const url = new URL(request.url)
    const mode = url.searchParams.get('mode') || 'run'
    const isHost = url.pathname === '/host'
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    if (isHost) this.#handleHost(server, mode)
    else this.#handleDevice(server, mode)
    return new Response(null, { status: 101, webSocket: client })
  }

  // Host leg: first frame is the JSON auth { token }; after that the leg is a raw
  // byte pipe whose frames (once glued) forward to its paired device.
  #handleHost(ws, mode) {
    ws._authed = false
    ws._device = null
    ws.addEventListener('message', (event) => {
      if (!ws._authed) {
        let ok = false
        try {
          const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
          const creds = JSON.parse(text)
          ok = creds && typeof creds.token === 'string' && this.#tokenOk(creds.token)
        } catch { ok = false }
        if (!ok) { try { ws.close(1008, 'host_unauthorized') } catch { /* closing */ } return }
        ws._authed = true
        this.#push(mode, ws)
        return
      }
      // Post-pairing: forward inner-TLS bytes to the glued device.
      if (ws._device && ws._device.readyState === OPEN) ws._device.send(event.data)
    })
    ws.addEventListener('close', () => { if (ws._device) { try { ws._device.close() } catch { /* closing */ } } })
    ws.addEventListener('error', () => { try { ws.close() } catch { /* closing */ } })
  }

  #handleDevice(ws, mode) {
    const host = this.#pop(mode)
    if (!host) { try { ws.close(1013, 'no_host_leg') } catch { /* closing */ } return }
    host._device = ws
    ws._host = host
    const closeBoth = () => { try { ws.close() } catch { /* closing */ } ; try { host.close() } catch { /* closing */ } }
    ws.addEventListener('message', (event) => { if (host.readyState === OPEN) host.send(event.data) })
    ws.addEventListener('close', closeBoth)
    ws.addEventListener('error', closeBoth)
    host.addEventListener('close', closeBoth)
    host.addEventListener('error', closeBoth)
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
