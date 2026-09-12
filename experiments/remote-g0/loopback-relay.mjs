import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import { constants } from 'node:crypto'
import { once } from 'node:events'
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws'
import { decodeWire } from './generated/wire.mjs'

const MAX_FRAME = 262_144
const MAX_BUFFER = 524_288
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const close = server => new Promise(resolve => server.close(resolve))

// G0-only relay. Both endpoints dial out; the relay has no filesystem/Provider
// operation and no arbitrary destination URL. All listeners are loopback only.
// Routing here is a two-peer test fixture, NOT cloud account authorization.
export async function loopbackRelay(certificates, { fault = null, sentinel = '' } = {}) {
  const peers = new Map()
  const sockets = new Set()
  const streams = new Set()
  const stats = { frames: 0, bytes: 0, plaintextObserved: false, requests: 0, innerTLS: [], faultInjected: false }
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
        if (end !== buffer.length - 1) throw new Error('unexpected trailing frame')
        const input = decodeWire('ProbeRequest', JSON.parse(buffer.subarray(0, end).toString('utf8')))
        stats.requests++
        socket.end(JSON.stringify(decodeWire('ProbeResponse', { protocolMajor: 1, requestId: input.requestId, kind: 'result', payload: input.payload })) + '\n')
      } catch { socket.destroy() }
    })
    socket.on('error', () => {})
  })
  hostServer.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  hostServer.on('tlsClientError', () => {})
  const hostPort = await listen(hostServer)
  const outerCA = await certificates.read('outer-ca.pem')
  const relay = https.createServer({ key: await certificates.read('outer.key'), cert: await certificates.read('outer.pem'), minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, (_request, response) => {
    response.writeHead(404).end()
  })
  relay.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })
  relay.on('upgrade', (request, socket, head) => {
    if (!['/host', '/device'].includes(request.url) || peers.has(request.url)) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  })
  wss.on('connection', (ws, request) => {
    const role = request.url
    const otherRole = role === '/host' ? '/device' : '/host'
    peers.set(role, ws)
    let deviceFrames = 0
    ws.on('error', () => {})
    ws.on('message', (input, binary) => {
      const other = peers.get(otherRole)
      if (!binary || !other || other.readyState !== WebSocket.OPEN || other.bufferedAmount + input.length > MAX_BUFFER) { ws.terminate(); other?.terminate(); return }
      stats.frames++; stats.bytes += input.length
      if (sentinel && input.includes(Buffer.from(sentinel))) stats.plaintextObserved = true
      let bytes = input
      if (role === '/device') deviceFrames++
      // First frame is the ClientHello. Mutate/drop the following encrypted
      // handshake/application record instead of just corrupting an HTTP header.
      if (role === '/device' && deviceFrames >= 2 && fault && !stats.faultInjected) {
        stats.faultInjected = true
        if (fault === 'disconnect') { ws.terminate(); other.terminate(); return }
        bytes = Buffer.from(input); bytes[bytes.length - 1] ^= 1
      }
      other.send(bytes, { binary: true }, error => { if (error) { ws.terminate(); other.terminate() } })
    })
    ws.on('close', code => {
      if (peers.get(role) === ws) peers.delete(role)
      const other = peers.get(otherRole)
      // A clean close must follow previously queued ciphertext, not discard it.
      if (code === 1000 || code === 1005) other?.close(1000)
      else other?.terminate()
    })
  })
  const port = await listen(relay)
  async function connectHost() {
    const ws = new WebSocket(`wss://localhost:${port}/host`, { ca: outerCA, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', perMessageDeflate: false, maxPayload: MAX_FRAME, handshakeTimeout: 5_000 })
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
  await connectHost()
  return {
    port, stats,
    async cleanup() {
      for (const ws of wss.clients) ws.terminate()
      for (const stream of streams) stream.destroy()
      for (const socket of sockets) socket.destroy()
      await Promise.all([close(wss), close(relay), close(hostServer)])
    }
  }
}
