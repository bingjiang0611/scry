import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import { expect, it } from 'vitest'
import { createRelayConnectWS, MAX_RELAY_WS_MESSAGE_BYTES } from './relay-connect-ws'

// Minimal RFC 6455 client-frame reader (clients always mask).
function readClientFrames(buffer: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f
    let length = buffer[offset + 1] & 0x7f
    let header = 2
    if (length === 126) { if (buffer.length - offset < 4) break; length = buffer.readUInt16BE(offset + 2); header = 4 }
    else if (length === 127) { if (buffer.length - offset < 10) break; length = Number(buffer.readBigUInt64BE(offset + 2)); header = 10 }
    if (buffer.length - offset < header + 4 + length) break
    const mask = buffer.subarray(offset + header, offset + header + 4)
    const payload = Buffer.from(buffer.subarray(offset + header + 4, offset + header + 4 + length))
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
    frames.push({ opcode, payload })
    offset += header + 4 + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

it('splits one large TLS write into bounded binary messages without changing the byte stream', async () => {
  const server = createServer()
  let peer: Duplex | undefined
  let pending = Buffer.alloc(0)
  const binary: Buffer[] = []
  server.on('upgrade', (request, socket) => {
    peer = socket
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', (data: Buffer) => {
      const parsed = readClientFrames(Buffer.concat([pending, data]))
      pending = Buffer.from(parsed.rest)
      for (const frame of parsed.frames) if (frame.opcode === 0x2) binary.push(frame.payload)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const { connect } = createRelayConnectWS({ url: `ws://127.0.0.1:${address.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run' })
  const leg = connect()
  try {
    await once(leg, 'connect')
    // A real history page measured 3.6 MB; Node TLS emits it as one chunk.
    const payload = Buffer.alloc(3_605_350)
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251
    leg.write(payload)
    const deadline = Date.now() + 10_000
    while (binary.reduce((sum, frame) => sum + frame.length, 0) < payload.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(Buffer.concat(binary).equals(payload)).toBe(true)
    expect(binary.length).toBe(Math.ceil(payload.length / MAX_RELAY_WS_MESSAGE_BYTES))
    // iOS NIO rejects frames above 1_572_864 bytes and closes the tunnel.
    expect(Math.max(...binary.map((frame) => frame.length))).toBeLessThanOrEqual(MAX_RELAY_WS_MESSAGE_BYTES)
    expect(MAX_RELAY_WS_MESSAGE_BYTES).toBeLessThan(1_572_864)
  } finally {
    leg.destroy()
    peer?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

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
  const { connect, readyEvent } = createRelayConnectWS({ url: `ws://127.0.0.1:${address.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run' })
  const leg = connect()
  let consumed = 0
  let served = 0
  leg.once(readyEvent, () => { served++ })
  leg.on('relaySession', () => { consumed++ })
  try {
    await once(leg, 'connect')
    expect(consumed).toBe(0)
    expect(served).toBe(0) // Idle relay registration must not start the TLS handshake timer.
    for (const value of ['client-hello', 'next-tls-record']) {
      const data = once(leg, 'data')
      const bytes = Buffer.from(value)
      peer!.write(Buffer.concat([Buffer.from([0x82, bytes.length]), bytes]))
      expect((await data)[0]).toEqual(bytes)
      expect(consumed).toBe(1)
      expect(served).toBe(1)
    }
  } finally {
    leg.destroy()
    peer?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
