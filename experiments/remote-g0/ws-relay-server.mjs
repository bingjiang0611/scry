import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

// Self-hostable relay speaking exactly the Cloudflare Worker's protocol
// (cf-relay/src/worker.js), for running the relay close to users, e.g. a VPS
// in the same region as both the phone and the Mac, instead of wherever
// Cloudflare places the room. Point a Mac at it with
//   SCRY_REMOTE_RELAY_WS='{"url":"wss://relay.example","token":"<RELAY_TOKEN>"}'
// and pair the phone again so its pairing code carries the new relay.
//
// SECURITY MODEL (unchanged): an UNTRUSTED byte rendezvous. Inner TLS 1.3 mTLS
// between phone and Mac runs end-to-end over the bytes; this process never
// sees keys or plaintext and stores only SHA-256 digests of room tokens.
//
// Protocol:
//   Mac legs   /host?host=<uuid>&mode=run|pair, first text frame
//              {"token": "...", "enroll"?: true}; later text frames
//              {"t":"ping"} are answered {"t":"pong"} and never forwarded.
//   Phones     /?host=<uuid>&mode=run|pair, binary frames only.
//   A phone is glued to the freshest live leg; with none free it waits up to
//   2 s for a live host to dial one (1013 no_host_leg), and with no live leg
//   at all it is closed 4001 host_offline: after a 600 ms grace when a host leg
//   opened, authenticated or closed in the last 10 s, otherwise at once.

const HOST_ID = /^[0-9a-f-]{36}$/i
const MODES = new Set(['run', 'pair'])
const PING = '{"t":"ping"}'
const PONG = '{"t":"pong"}'
const MAX_FRAME = 2 * 1024 * 1024
const MAX_LEGS_PER_ROOM = 64

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
function digestEqual(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right)
}

export function createWsRelayServer({
  adminToken = '', storePath, tls,
  freshMs = 30_000, waitMs = 2_000, offlineGraceMs = 600, recentHostMs = 10_000, log = () => {}
} = {}) {
  // hostId -> SHA-256 of the room's enrolled token. Persisted atomically.
  const enrolled = new Map(storePath && existsSync(storePath)
    ? Object.entries(JSON.parse(readFileSync(storePath, 'utf8'))) : [])
  const persist = () => {
    if (!storePath) return
    const temporary = `${storePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(enrolled)), { mode: 0o600 })
    renameSync(temporary, storePath)
  }
  const adminDigest = adminToken ? sha256(adminToken) : ''
  const tokenOk = (hostId, token, enroll) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return false
    const digest = sha256(token)
    if (adminDigest && digestEqual(digest, adminDigest)) return true
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false
    const stored = enrolled.get(hostId)
    if (stored) return digestEqual(digest, stored)
    if (!enroll) return false
    enrolled.set(hostId, digest)
    persist()
    return true
  }

  // hostId -> Set of legs { ws, mode, authed, openedAt, lastPingAt, device }
  const rooms = new Map()
  // hostId -> last time a host leg opened, authenticated or closed. Only rooms
  // within the window matter, so stale entries are pruned as rooms empty.
  const hostActivity = new Map()
  const touchHost = (hostId) => {
    const now = Date.now()
    hostActivity.set(hostId, now)
    if (hostActivity.size > 1024) {
      for (const [id, at] of hostActivity) if (now - at > recentHostMs) hostActivity.delete(id)
    }
  }
  const room = (hostId) => {
    let legs = rooms.get(hostId)
    if (!legs) { legs = new Set(); rooms.set(hostId, legs) }
    return legs
  }
  const OPEN = 1
  const lastEvidence = (leg) => Math.max(leg.openedAt, leg.lastPingAt ?? 0)
  const pop = (hostId, mode) => {
    const now = Date.now()
    let best = null
    let bestRank = -Infinity
    for (const leg of rooms.get(hostId) ?? []) {
      if (leg.ws.readyState !== OPEN || !leg.authed || leg.mode !== mode || leg.device) continue
      const pinging = leg.lastPingAt !== undefined
      if (pinging && now - leg.lastPingAt > freshMs) { leg.ws.close(1011, 'stale_leg'); continue }
      const rank = (pinging ? 1e15 : 0) + lastEvidence(leg)
      if (rank > bestRank) { best = leg; bestRank = rank }
    }
    return best
  }
  const alive = (hostId) => {
    const now = Date.now()
    for (const leg of rooms.get(hostId) ?? []) {
      if (leg.ws.readyState !== OPEN || !leg.authed) continue
      if (leg.lastPingAt === undefined || now - leg.lastPingAt <= freshMs) return true
    }
    return false
  }

  const server = tls ? httpsServer(tls) : httpServer()
  server.on('request', (_request, response) => { response.writeHead(426); response.end('upgrade_required') })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })

  server.on('upgrade', (request, socket, head) => {
    let url
    try { url = new URL(request.url, 'http://relay') } catch { socket.destroy(); return }
    const hostId = url.searchParams.get('host')
    const mode = url.searchParams.get('mode') || 'run'
    const isHost = url.pathname === '/host'
    if (!hostId || !HOST_ID.test(hostId) || !MODES.has(mode) || (!isHost && url.pathname !== '/')) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return
    }
    if (isHost) {
      if (room(hostId).size >= MAX_LEGS_PER_ROOM) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return }
      wss.handleUpgrade(request, socket, head, (ws) => acceptHost(ws, hostId, mode))
      return
    }
    void acceptDevice(request, socket, head, hostId, mode)
  })

  function acceptHost(ws, hostId, mode) {
    const leg = { ws, mode, authed: false, openedAt: Date.now(), lastPingAt: undefined, device: null }
    room(hostId).add(leg)
    touchHost(hostId)
    const teardown = () => {
      touchHost(hostId)
      room(hostId).delete(leg)
      if (rooms.get(hostId)?.size === 0) rooms.delete(hostId)
      if (leg.device && leg.device.readyState === OPEN) leg.device.close(1000, 'peer_closed')
    }
    ws.on('close', teardown)
    ws.on('error', () => ws.terminate())
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString('utf8')
        if (leg.authed && text === PING) { leg.lastPingAt = Date.now(); ws.send(PONG); return }
        if (leg.authed) return
        let credentials
        try { credentials = JSON.parse(text) } catch { credentials = null }
        if (!credentials || !tokenOk(hostId, credentials.token, credentials.enroll === true)) { ws.close(1008, 'host_unauthorized'); return }
        leg.authed = true
        touchHost(hostId)
        return
      }
      if (leg.device && leg.device.readyState === OPEN) leg.device.send(data, { binary: true })
    })
  }

  async function acceptDevice(request, socket, head, hostId, mode) {
    const started = Date.now()
    let leg = pop(hostId, mode)
    const live = leg ? true : alive(hostId)
    const recent = started - (hostActivity.get(hostId) ?? 0) <= recentHostMs
    const budget = leg ? 0 : live ? waitMs : recent ? offlineGraceMs : 0
    while (!leg && Date.now() - started < budget && !socket.destroyed) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      leg = pop(hostId, mode)
    }
    if (socket.destroyed) return
    // Claim before the async upgrade so a concurrent phone cannot take it.
    const claimed = leg
    const placeholder = {}
    if (claimed) claimed.device = placeholder
    const waited = Date.now() - started
    // Bound to this request: a handshake ws aborts (bad Sec-WebSocket-Key, a
    // socket closed mid-upgrade) never emits 'headers' or runs the callback,
    // so neither the header nor the claim may outlive it.
    const onHeaders = (headers, req) => { if (req === request) headers.push(`x-scry-relay-wait-ms: ${waited}`) }
    wss.on('headers', onHeaders)
    let upgraded = false
    socket.once('close', () => {
      wss.off('headers', onHeaders)
      if (!upgraded && claimed && claimed.device === placeholder) claimed.device = null
    })
    wss.handleUpgrade(request, socket, head, (device) => {
      upgraded = true
      wss.off('headers', onHeaders)
      log(`device mode=${mode} leg=${claimed ? 'FOUND' : live ? 'BUSY' : 'OFFLINE'} waitedMs=${waited}`)
      if (!claimed || claimed.ws.readyState !== OPEN) {
        if (claimed) claimed.device = null
        device.close(live ? 1013 : 4001, live ? 'no_host_leg' : 'host_offline')
        return
      }
      claimed.device = device
      device.on('message', (data, isBinary) => {
        if (isBinary && claimed.ws.readyState === OPEN) claimed.ws.send(data, { binary: true })
      })
      const teardown = () => { if (claimed.ws.readyState === OPEN) claimed.ws.close(1000, 'peer_closed') }
      device.on('close', teardown)
      device.on('error', () => device.terminate())
    })
  }

  return {
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve) => server.listen(port, host, resolve))
      return server.address().port
    },
    async close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

// CLI: node ws-relay-server.mjs --port=8080 [--host=127.0.0.1] [--store=rooms.json]
//      [--tls-cert=cert.pem --tls-key=key.pem]; RELAY_TOKEN env is optional.
// Prefer terminating TLS in a reverse proxy (Caddy/nginx) on 443 in front of a
// loopback listener; the phone's outer TLS uses the system trust store.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const option = (name, fallback) => (process.argv.find((arg) => arg.startsWith(`--${name}=`)) ?? `=${fallback ?? ''}`).split('=').slice(1).join('=')
  const cert = option('tls-cert')
  const key = option('tls-key')
  const relay = createWsRelayServer({
    adminToken: process.env.RELAY_TOKEN ?? '',
    storePath: option('store', 'relay-rooms.json'),
    ...(cert && key ? { tls: { cert: readFileSync(cert), key: readFileSync(key) } } : {}),
    log: (line) => console.log(`[relay ${new Date().toISOString()}] ${line}`)
  })
  const port = await relay.listen(Number(option('port', '8080')), option('host', '127.0.0.1'))
  console.log(`[relay] listening on ${option('host', '127.0.0.1')}:${port} (${cert ? 'wss' : 'ws'}) id=${randomUUID().slice(0, 8)}`)
}
