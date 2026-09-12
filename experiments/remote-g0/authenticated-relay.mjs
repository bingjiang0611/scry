import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import { constants } from 'node:crypto'
import { once } from 'node:events'
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws'
import { decodeWire } from './generated/wire.mjs'
import { RelayAdmission, AdmissionError, redactTicket } from './relay-admission.mjs'

const MAX_FRAME = 262_144
const MAX_BUFFER = 524_288
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const close = server => new Promise(resolve => server.close(resolve))

// G0 authenticated rendezvous relay. Unlike loopback-relay.mjs (an unauthenticated
// byte fixture), this requires a valid single-use ticket bound to a session+role
// before a peer is bridged. The relay still only shuttles opaque ciphertext of the
// inner TLS 1.3 mTLS session; it never sees inner keys and is not the security root.
//
// register() models the trusted Mac control channel publishing token hashes; its
// own authentication is the caller's responsibility (out of scope for this fixture).
export async function authenticatedRelay(certificates, { admission } = {}) {
  const admit = admission ?? new RelayAdmission()
  const peers = new Map() // `${sessionId}:${role}` -> ws
  const bridged = new Set() // sessionId once wired, to avoid double-wiring
  const sockets = new Set()
  const streams = new Set()
  const log = []
  const stats = { frames: 0, bytes: 0, requests: 0, rejected: 0, innerTLS: [], plaintextObserved: false }

  // Inner TLS 1.3 mTLS echo host (the byte destination the host peer pipes to).
  const hostServer = tls.createServer({
    key: await certificates.read('host.key'), cert: await certificates.read('host.pem'),
    ca: await certificates.read('inner-ca.pem'), requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', secureOptions: constants.SSL_OP_NO_TICKET
  }, socket => {
    if (!socket.authorized || socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) { socket.destroy(); return }
    stats.innerTLS.push({ protocol: socket.getProtocol(), resumed: socket.isSessionReused() })
    let buffer = Buffer.alloc(0)
    let used = false
    socket.on('data', bytes => {
      if (used || buffer.length + bytes.length > 65_536) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      used = true
      try {
        if (end !== buffer.length - 1) throw new Error('trailing')
        const input = decodeWire('ProbeRequest', JSON.parse(buffer.subarray(0, end).toString('utf8')))
        stats.requests++
        socket.end(JSON.stringify(decodeWire('ProbeResponse', { protocolMajor: 1, requestId: input.requestId, kind: 'result', payload: input.payload })) + '\n')
      } catch { socket.destroy() }
    })
    socket.on('error', () => {})
  })
  hostServer.on('tlsClientError', () => {})
  const hostPort = await listen(hostServer)
  const outerCA = await certificates.read('outer-ca.pem')

  const relay = https.createServer({
    key: await certificates.read('outer.key'), cert: await certificates.read('outer.pem'),
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3'
  }, (_request, response) => response.writeHead(404).end())
  relay.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })

  relay.on('upgrade', (request, socket, head) => {
    // Only /join is served, and only with a valid single-use ticket + role. On
    // any admission failure the socket is closed without leaking the reason on
    // the wire, and the token is never logged in the clear.
    if (request.url !== '/join') { socket.destroy(); return }
    const role = request.headers['x-scry-role']
    const token = request.headers['x-scry-ticket']
    let outcome
    try {
      outcome = admit.admit({ token: typeof token === 'string' ? token : '', role: typeof role === 'string' ? role : '' })
    } catch (error) {
      stats.rejected++
      log.push({ event: 'reject', role: typeof role === 'string' ? role : '?', ticket: redactTicket(typeof token === 'string' ? token : ''), code: error instanceof AdmissionError ? error.code : 'error' })
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    log.push({ event: 'admit', role, ticket: redactTicket(token), session: outcome.sessionId })
    wss.handleUpgrade(request, socket, head, ws => {
      ws._scrySession = outcome.sessionId
      ws._scryRole = role
      wss.emit('connection', ws, request)
    })
  })

  function wireBridge(sessionId) {
    if (bridged.has(sessionId)) return
    const host = peers.get(`${sessionId}:host`)
    const device = peers.get(`${sessionId}:device`)
    if (!host || !device || host.readyState !== WebSocket.OPEN || device.readyState !== WebSocket.OPEN) return
    bridged.add(sessionId)
    for (const [from, to] of [[host, device], [device, host]]) {
      from.on('message', (input, binary) => {
        if (!binary || to.readyState !== WebSocket.OPEN || to.bufferedAmount + input.length > MAX_BUFFER) { from.terminate(); to.terminate(); return }
        stats.frames++; stats.bytes += input.length
        to.send(input, { binary: true }, error => { if (error) { from.terminate(); to.terminate() } })
      })
    }
  }

  wss.on('connection', ws => {
    const sessionId = ws._scrySession
    const role = ws._scryRole
    const key = `${sessionId}:${role}`
    peers.set(key, ws)
    ws.on('error', () => {})
    ws.on('close', () => {
      if (peers.get(key) === ws) peers.delete(key)
      const other = peers.get(`${sessionId}:${role === 'host' ? 'device' : 'host'}`)
      other?.close(1000)
      admit.release(sessionId)
      bridged.delete(sessionId)
    })
    wireBridge(sessionId)
  })

  const port = await listen(relay)

  // The relay-operated host leg: dials /join as the host role and pipes the WSS
  // stream into the inner TLS echo server. Requires the session's host ticket.
  async function connectHost(hostTicket) {
    const ws = new WebSocket(`wss://localhost:${port}/join`, {
      ca: outerCA, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', perMessageDeflate: false,
      maxPayload: MAX_FRAME, handshakeTimeout: 5_000, headers: { 'x-scry-role': 'host', 'x-scry-ticket': hostTicket }
    })
    ws.on('error', () => {})
    await once(ws, 'open')
    const tcp = net.connect({ host: '127.0.0.1', port: hostPort })
    const tunnel = createWebSocketStream(ws, { highWaterMark: MAX_BUFFER })
    streams.add(tunnel); streams.add(tcp)
    const destroy = () => { tunnel.destroy(); tcp.destroy(); ws.terminate() }
    tunnel.on('error', destroy); tcp.on('error', destroy)
    tcp.on('close', hadError => { streams.delete(tcp); if (hadError) destroy(); else tunnel.end() })
    tunnel.on('close', () => { streams.delete(tunnel); destroy() })
    tcp.pipe(tunnel).pipe(tcp)
    await once(tcp, 'connect')
  }

  return {
    port, stats, admission: admit,
    log: () => log.slice(),
    connectHost,
    async cleanup() {
      for (const ws of wss.clients) ws.terminate()
      for (const stream of streams) stream.destroy()
      for (const socket of sockets) socket.destroy()
      await Promise.all([close(wss), close(relay), close(hostServer)])
    }
  }
}
