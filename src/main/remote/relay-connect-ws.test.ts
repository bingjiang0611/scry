import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import { expect, it } from 'vitest'
import { createRelayConnectWS } from './relay-connect-ws'

it('signals consumption once on actual websocket bytes without changing the payload', async () => {
  const server = createServer()
  let peer: Duplex | undefined
  server.on('upgrade', (request, socket) => {
    peer = socket
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    // Only the server->client wire matters here; consume auth/close frames.
    socket.on('data', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const { connect } = createRelayConnectWS({ url: `ws://127.0.0.1:${address.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run' })
  const leg = connect()
  let consumed = 0
  leg.on('relaySession', () => { consumed++ })
  try {
    await once(leg, 'connect')
    expect(consumed).toBe(0)
    for (const value of ['client-hello', 'next-tls-record']) {
      const data = once(leg, 'data')
      const bytes = Buffer.from(value)
      peer!.write(Buffer.concat([Buffer.from([0x82, bytes.length]), bytes]))
      expect((await data)[0]).toEqual(bytes)
      expect(consumed).toBe(1)
    }
  } finally {
    leg.destroy()
    peer?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
