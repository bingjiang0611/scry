// Scry relay on Cloudflare Workers + Durable Objects (SQLite backend).
//
// Same role as experiments/remote-g0/relay-server.mjs: an UNTRUSTED byte
// rendezvous. It never sees inner keys or stores payloads; the inner TLS 1.3
// mTLS between device and Mac host is the only security root. It retains only
// the SHA-256 digest of an enrolled room credential. (Contrast Etch,
// whose relay stores messages in plaintext R2 for 30 days.) On Cloudflare,
// Workers cannot accept arbitrary inbound TCP, so BOTH sides connect over
// WebSocket:
//
//   - The NAT-bound Mac host opens a warm pool of legs to
//     `/host?host=<hostId>&mode=<run|pair>` and authenticates with a first-frame
//     JSON credential (never in the URL or logs). Official clients atomically
//     claim their unguessable room with a random per-host token; private legacy
//     deployments may keep using the per-deploy RELAY_TOKEN.
//   - The iOS device opens `/?host=<hostId>&mode=<run|pair>`.
//
// A Durable Object keyed by hostId keeps a separate warm pool per mode and glues
// one device to one host leg, raw-shuttling binary frames both ways. A pairing
// device (mode=pair) can never land on the strict-mTLS run pool and vice versa.
//
// It uses the WebSocket Hibernation API (state.acceptWebSocket + webSocket*
// handlers) so idle warm legs incur NO duration charges. The only durable value
// is the SHA-256 digest of each room's admission token; relay payload bytes are
// never persisted. This keeps a personal always-on relay comfortably inside the
// Workers Free plan (SQLite-backed Durable Objects are free-tier eligible).

const HOST_ID = /^[0-9a-f-]{36}$/i
const LOCATION_HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'])
const MODES = new Set(['run', 'pair'])
let COUNTER = 0

// Leg liveness. (Module-local: workerd treats every named export of the main
// module as an entrypoint, so constants must not be exported.)
// A hibernated relay cannot see a host TCP connection die (Mac
// sleep, Wi-Fi change, proxy idle drop): the socket stays OPEN here and a device
// glued to it waits for an inner handshake that never answers. Current hosts
// send HOST_PING as a text frame on every leg; the runtime answers it with
// HOST_PONG without waking this object and records the time, which survives
// hibernation (getWebSocketAutoResponseTimestamp). Inner TLS is always binary,
// so a text frame never collides with tunnel bytes.
const HOST_PING = '{"t":"ping"}'
const HOST_PONG = '{"t":"pong"}'
// A pinging leg silent for this long is presumed dead. Hosts ping every 10 s.
const LEG_FRESH_MS = 30_000
// A device that arrives while every live leg is busy waits this long for the
// host to dial a replacement instead of failing at once.
const LEG_WAIT_MS = 2_000
// With no live leg at all, wait only long enough to cover a host replacing a
// recycled leg, then report the host offline.
const OFFLINE_GRACE_MS = 600
const LEG_WAIT_STEP_MS = 50
// Application close codes. 1013 keeps its meaning (host reachable, no free
// leg). 4001 means no live leg at all: the host is offline or asleep, so the
// phone can say so immediately instead of retrying into a timeout.
const CLOSE_NO_HOST_LEG = 1013
const CLOSE_HOST_OFFLINE = 4001

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const hostId = url.searchParams.get('host')
    const mode = url.searchParams.get('mode') || 'run'
    if (!hostId || !HOST_ID.test(hostId) || !MODES.has(mode)) return new Response('bad_request', { status: 400 })
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('upgrade_required', { status: 426 })
    // Route every connection for a hostId to the same Durable Object instance so
    // the host's warm legs and the device rendezvous share state. A room is
    // placed near its FIRST request and never moves; RELAY_LOCATION_HINT (e.g.
    // "apac") places new rooms in a region instead, so a Mac whose relay
    // traffic exits through a distant proxy does not pin its room there.
    const hint = LOCATION_HINTS.has(env.RELAY_LOCATION_HINT) ? { locationHint: env.RELAY_LOCATION_HINT } : undefined
    const stub = env.RELAY.get(env.RELAY.idFromName(hostId), hint)
    return stub.fetch(request)
  }
}

export class RelayRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    // id -> WebSocket. Lost on hibernation and rebuilt lazily on a miss, so
    // forwarding a frame no longer deserializes every socket in the room.
    this.byId = new Map()
    // Instance copies so a local fixture can shorten the windows.
    this.limits = { freshMs: LEG_FRESH_MS, waitMs: LEG_WAIT_MS, offlineGraceMs: OFFLINE_GRACE_MS }
    try {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HOST_PING, HOST_PONG))
    } catch { /* older runtime: hosts fall back to the manual reply below */ }
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
      const id = newId()
      server.serializeAttachment({ role: 'host', mode, authed: false, id, deviceId: null, openedAt: Date.now() })
      this.byId.set(id, server)
      return new Response(null, { status: 101, webSocket: client })
    }

    // Device: glue to the freshest warm, authenticated, unpaired host leg. When
    // none is free, wait briefly: a live host replaces a consumed leg within a
    // round trip, and yielding here lets that leg's admission frame run.
    const started = Date.now()
    let host = this.#popWarmHost(mode)
    // Judge liveness on arrival: the wait itself must not age the evidence.
    const alive = host ? true : this.#hostAlive()
    const budget = host ? 0 : alive ? this.limits.waitMs : this.limits.offlineGraceMs
    while (!host && Date.now() - started < budget) {
      await sleep(LEG_WAIT_STEP_MS)
      host = this.#popWarmHost(mode)
    }
    const waitedMs = Date.now() - started
    console.log(`[relay] device mode=${mode} hostLeg=${host ? 'FOUND' : alive ? 'BUSY' : 'OFFLINE'} waitedMs=${waitedMs}`)
    this.state.acceptWebSocket(server, ['device'])
    if (!host) {
      try {
        if (alive) server.close(CLOSE_NO_HOST_LEG, 'no_host_leg')
        else server.close(CLOSE_HOST_OFFLINE, 'host_offline')
      } catch { /* closing */ }
      return new Response(null, { status: 101, webSocket: client, headers: { 'x-scry-relay-wait-ms': String(waitedMs) } })
    }
    const deviceId = newId()
    server.serializeAttachment({ role: 'device', mode, id: deviceId, hostId: idOf(host) })
    this.byId.set(deviceId, server)
    const hostAtt = host.deserializeAttachment()
    hostAtt.deviceId = deviceId
    host.serializeAttachment(hostAtt)
    return new Response(null, { status: 101, webSocket: client, headers: { 'x-scry-relay-wait-ms': String(waitedMs) } })
  }

  // Most recent liveness evidence for a host leg: its last auto-answered ping,
  // or its admission time. `pinging` distinguishes current hosts from older
  // ones that never ping, whose liveness is unknown rather than stale.
  #liveness(ws, att) {
    let pong = null
    try { pong = this.state.getWebSocketAutoResponseTimestamp(ws) } catch { pong = null }
    const manual = typeof att.pingedAt === 'number' ? att.pingedAt : 0
    const pinged = Math.max(pong ? pong.getTime() : 0, manual)
    return { pinging: pinged > 0, last: Math.max(pinged, att.openedAt ?? 0) }
  }

  // Freshest open, authenticated, unpaired leg for the mode. Pinging legs that
  // went silent are closed here so their host notices. DO execution is
  // serialized, so this pop is race-free.
  #popWarmHost(mode) {
    const now = Date.now()
    let best = null
    let bestRank = -Infinity
    for (const ws of this.state.getWebSockets('host')) {
      // Hibernatable sockets remain listed while their close handshake runs.
      // Their old admission attachment is not proof they can accept a device.
      if (ws.readyState !== WebSocket.OPEN) continue
      const att = ws.deserializeAttachment()
      if (!att || att.mode !== mode || !att.authed || att.deviceId) continue
      const { pinging, last } = this.#liveness(ws, att)
      if (pinging && now - last > this.limits.freshMs) {
        try { ws.close(1011, 'stale_leg') } catch { /* closing */ }
        continue
      }
      // Proven-live legs first, newest evidence first; legacy legs keep
      // working but rank below them, newest first instead of oldest first.
      const rank = (pinging ? 1e15 : 0) + last
      if (rank > bestRank) { best = ws; bestRank = rank }
    }
    return best
  }

  // Any open, authenticated leg (of either mode, busy or not) with recent
  // evidence means the host process is reachable. Legacy legs count as alive:
  // without pings their state is unknown, never proof of absence.
  #hostAlive() {
    const now = Date.now()
    for (const ws of this.state.getWebSockets('host')) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const att = ws.deserializeAttachment()
      if (!att || !att.authed) continue
      const { pinging, last } = this.#liveness(ws, att)
      if (!pinging || now - last <= this.limits.freshMs) return true
    }
    return false
  }

  #find(id) {
    if (!id) return null
    const cached = this.byId.get(id)
    if (cached) return cached
    // Miss: first frame after hibernation, or the peer is gone. Rebuild once.
    this.byId.clear()
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment()
      if (att && att.id) this.byId.set(att.id, ws)
    }
    return this.byId.get(id) ?? null
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment()
    if (!att) { try { ws.close(1011, 'no_state') } catch { /* closing */ } return }
    if (att.role === 'host') {
      // Runtimes without auto-response deliver the ping here. Never forward
      // it: the device side carries only inner-TLS bytes.
      if (typeof message === 'string' && message === HOST_PING) {
        if (att.authed) { att.pingedAt = Date.now(); ws.serializeAttachment(att) }
        try { ws.send(HOST_PONG) } catch { /* closing */ }
        return
      }
      if (!att.authed) {
        let ok = false
        try {
          const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const creds = JSON.parse(text)
          ok = creds && typeof creds.token === 'string' &&
            await this.#tokenOk(creds.token, creds.enroll === true)
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
      this.byId.delete(att.id)
      const peerId = att.role === 'host' ? att.deviceId : att.hostId
      const peer = this.#find(peerId)
      if (peer) { try { peer.close(1000, 'peer_closed') } catch { /* closing */ } }
    }
    try { ws.close() } catch { /* closing */ }
  }

  async #tokenOk(candidate, enroll) {
    // Preserve private/legacy deployments and existing manually provisioned
    // hosts. This is an administrator credential, not shipped in the app.
    if (constantTimeEqual(candidate, this.env.RELAY_TOKEN || '')) return true

    // Official clients generate a 256-bit token locally. The first connection
    // atomically claims the UUID-addressed room; later connections must prove the
    // same token. A leaked/guessed hostId alone therefore cannot impersonate its
    // host, and a single extractable app-wide bearer is never distributed.
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false
    const digest = await sha256Hex(candidate)
    return this.state.storage.transaction(async (txn) => {
      const stored = await txn.get('hostTokenSHA256')
      if (typeof stored === 'string') return constantTimeEqual(digest, stored)
      if (!enroll) return false
      await txn.put('hostTokenSHA256', digest)
      return true
    })
  }
}

function constantTimeEqual(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length || expected.length === 0) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function newId() {
  return Date.now().toString(36) + '-' + (COUNTER++).toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}
function idOf(ws) {
  const att = ws.deserializeAttachment()
  return att ? att.id : null
}
