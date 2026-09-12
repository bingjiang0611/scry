import { createServer as netServer } from 'node:net'
import { createServer as tlsServer } from 'node:tls'
import { createServer as httpServer } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'

// Deployable outer relay for the Scry iOS remote path.
//
// SECURITY MODEL. The relay is an UNTRUSTED byte rendezvous and is NEVER the
// security root: the inner TLS 1.3 mTLS between device and Mac host runs
// end-to-end over whatever bytes this relay shuttles, so a fully compromised
// relay can at most drop/delay/observe *ciphertext* - it cannot read or forge
// inner traffic, and an unpaired or ungranted device is refused by the host's
// fingerprint check regardless of what the relay does. This server therefore
// only solves ROUTING: connect the right device to the right Mac host without
// letting a random party squat a host's slot or receive its device traffic.
//
// TOPOLOGY. The Mac host is typically behind NAT, so it DIALS OUT and keeps a
// warm pool of "host legs" (reverse tunnel). A host leg authenticates once with
// a per-host bearer token (provisioned out of band; production SHOULD also front
// this listener with mutual TLS at the load balancer). Devices connect over WSS
// (iOS URLSession, no native dependency). The relay pops a warm leg for the
// requested hostId and raw-shuttles bytes: WS binary <-> host-leg stream. It
// keeps NO inner keys and parses NONE of the inner protocol.
//
// The Electron app stays dependency-free: only THIS service (a standalone cloud
// process) uses `ws`. The host leg is a plain byte stream (node:tls/net),
// produced by src/main/remote/relay-connect.ts.

const HOST_ID = /^[0-9a-f-]{36}$/i
const MODES = new Set(['run', 'pair'])
const MAX_AUTH_LINE = 4096

function tokenEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  // Compare fixed-length digests so length is not a timing oracle.
  const ah = createHash('sha256').update(ab).digest()
  const bh = createHash('sha256').update(bb).digest()
  return timingSafeEqual(ah, bh)
}

// authorizeHost({ hostId, token }) -> boolean. Injected so the deployment binds
// its own provisioning (env, KMS, DB). Never log the token.
export function createRelayServer({ authorizeHost, tls, maxLegsPerHost = 8, legIdleMs = 60_000 } = {}) {
  if (typeof authorizeHost !== 'function') throw new Error('authorizeHost required')
  // hostId -> array of { stream, timer } warm legs waiting for a device.
  const warm = new Map()
  const openStreams = new Set()

  const key = (hostId, mode) => `${hostId}:${mode}`
  const pushLeg = (hostId, mode, stream) => {
    const k = key(hostId, mode)
    const legs = warm.get(k) ?? []
    if (legs.length >= maxLegsPerHost) { stream.destroy(); return }
    const timer = setTimeout(() => {
      const list = warm.get(k)
      if (!list) return
      const i = list.findIndex((l) => l.stream === stream)
      if (i >= 0) { list.splice(i, 1); stream.destroy() }
    }, legIdleMs)
    if (typeof timer.unref === 'function') timer.unref()
    legs.push({ stream, timer })
    warm.set(k, legs)
  }

  const popLeg = (hostId, mode) => {
    const legs = warm.get(key(hostId, mode))
    while (legs && legs.length > 0) {
      const leg = legs.shift()
      clearTimeout(leg.timer)
      if (!leg.stream.destroyed && leg.stream.writable) return leg.stream
      leg.stream.destroy()
    }
    return null
  }

  // Host leg listener: first line is a JSON auth frame, then raw inner-TLS bytes.
  const onHostConnection = (stream) => {
    openStreams.add(stream)
    stream.on('close', () => openStreams.delete(stream))
    stream.on('error', () => stream.destroy())
    let buffer = ''
    let authed = false
    const onData = (chunk) => {
      if (authed) return
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_AUTH_LINE) { stream.destroy(); return }
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      const line = buffer.slice(0, nl)
      const rest = buffer.slice(nl + 1)
      let creds
      try { creds = JSON.parse(line) } catch { stream.destroy(); return }
      const mode = creds && typeof creds.mode === 'string' ? creds.mode : 'run'
      if (!creds || typeof creds.hostId !== 'string' || !HOST_ID.test(creds.hostId) || typeof creds.token !== 'string' || !MODES.has(mode)) { stream.destroy(); return }
      let ok = false
      try { ok = authorizeHost({ hostId: creds.hostId, token: creds.token }) === true } catch { ok = false }
      if (!ok) { try { stream.write('{"error":"host_unauthorized"}\n') } catch { /* closing */ } stream.destroy(); return }
      authed = true
      stream.removeListener('data', onData)
      // Any bytes after the auth line belong to the inner stream; do not drop them.
      if (rest.length > 0) stream.unshift(Buffer.from(rest, 'utf8'))
      pushLeg(creds.hostId, mode, stream)
    }
    stream.on('data', onData)
  }

  const netHost = netServer(onHostConnection)
  const tlsHost = tls ? tlsServer(tls, onHostConnection) : null

  // Device side: WSS. iOS opens wss://relay/?host=<hostId>; binary messages carry
  // inner-TLS bytes.
  const http = httpServer((_req, res) => { res.writeHead(426); res.end('upgrade required') })
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (ws, req) => {
    let hostId = null
    let mode = 'run'
    try {
      const params = new URL(req.url, 'http://relay').searchParams
      hostId = params.get('host')
      mode = params.get('mode') ?? 'run'
    } catch { hostId = null }
    if (!hostId || !HOST_ID.test(hostId) || !MODES.has(mode)) { ws.close(1008, 'bad_host'); return }
    const leg = popLeg(hostId, mode)
    if (!leg) { ws.close(1013, 'no_host_leg'); return }
    // Bridge WS binary <-> host leg raw bytes. No inner parsing.
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      if (leg.writable) leg.write(data)
    })
    leg.on('data', (chunk) => { if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true }) })
    const teardown = () => { try { ws.close() } catch { /* closed */ } leg.destroy() }
    ws.on('close', teardown); ws.on('error', teardown)
    leg.on('close', teardown); leg.on('error', teardown)
  })

  return {
    async listen({ hostPort = 0, tlsHostPort = 0, devicePort = 0, address = '127.0.0.1' } = {}) {
      await new Promise((r) => netHost.listen(hostPort, address, r))
      if (tlsHost) await new Promise((r) => tlsHost.listen(tlsHostPort, address, r))
      await new Promise((r) => http.listen(devicePort, address, r))
      return {
        hostPort: netHost.address().port,
        tlsHostPort: tlsHost ? tlsHost.address().port : null,
        devicePort: http.address().port
      }
    },
    async close() {
      for (const s of openStreams) s.destroy()
      for (const legs of warm.values()) for (const l of legs) { clearTimeout(l.timer); l.stream.destroy() }
      warm.clear()
      wss.close()
      await Promise.all([
        new Promise((r) => netHost.close(() => r())),
        tlsHost ? new Promise((r) => tlsHost.close(() => r())) : Promise.resolve(),
        new Promise((r) => http.close(() => r()))
      ])
    }
  }
}
