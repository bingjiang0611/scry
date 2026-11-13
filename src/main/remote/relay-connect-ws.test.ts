import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import { expect, it } from 'vitest'
import { createRelayConnectWS, MAX_RELAY_WS_MESSAGE_BYTES, RELAY_HOST_PING, RELAY_HOST_PONG } from './relay-connect-ws'

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

// A relay fixture that records client text frames and can answer with text.
async function heartbeatRelay(): Promise<{ port: number; texts: string[]; binary: Buffer[]; sendText: (text: string) => void; sendBinary: (bytes: Buffer) => void; close: () => Promise<void> }> {
  const server = createServer()
  let peer: Duplex | undefined
  let pending = Buffer.alloc(0)
  const texts: string[] = []
  const binary: Buffer[] = []
  server.on('upgrade', (request, socket) => {
    peer = socket
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', (data: Buffer) => {
      const parsed = readClientFrames(Buffer.concat([pending, data]))
      pending = Buffer.from(parsed.rest)
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x1) texts.push(frame.payload.toString('utf8'))
        if (frame.opcode === 0x2) binary.push(frame.payload)
      }
    })
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const frame = (opcode: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
  return {
    port: (server.address() as { port: number }).port,
    texts,
    binary,
    sendText: (text) => peer?.write(frame(0x1, Buffer.from(text))),
    sendBinary: (bytes) => peer?.write(frame(0x2, bytes)),
    close: async () => { peer?.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  }
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

it('pings the relay as text and never lets a pong enter the tunnel', async () => {
  const relay = await heartbeatRelay()
  const { connect } = createRelayConnectWS({ url: `ws://127.0.0.1:${relay.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run', pingIntervalMs: 40 })
  const leg = connect()
  const pushed: Buffer[] = []
  let sessions = 0
  leg.on('data', (chunk: Buffer) => pushed.push(chunk))
  leg.on('relaySession', () => { sessions++ })
  try {
    await once(leg, 'connect')
    await until(() => relay.texts.filter((text) => text === RELAY_HOST_PING).length >= 2)
    expect(relay.texts[0]).toContain('isolated-fixture')
    relay.sendText(RELAY_HOST_PONG)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pushed).toEqual([])
    expect(sessions).toBe(0)
    relay.sendBinary(Buffer.from([7, 7]))
    await until(() => pushed.length === 1)
    expect(Buffer.concat(pushed)).toEqual(Buffer.from([7, 7]))
    expect(sessions).toBe(1)
  } finally {
    leg.destroy()
    await relay.close()
  }
})

it('destroys a leg whose relay stopped answering pings', async () => {
  const relay = await heartbeatRelay()
  const { connect } = createRelayConnectWS({ url: `ws://127.0.0.1:${relay.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run', pingIntervalMs: 20, pongTimeoutMs: 120 })
  const leg = connect()
  let failure: Error | undefined
  leg.on('error', (error: Error) => { failure = error })
  try {
    await once(leg, 'connect')
    relay.sendText(RELAY_HOST_PONG)
    await until(() => leg.destroyed, 2_000)
    expect(failure?.message).toBe('relay_leg_stale')
  } finally {
    leg.destroy()
    await relay.close()
  }
})

it('keeps legs on a relay that never answers pings (older deployment)', async () => {
  const relay = await heartbeatRelay()
  const { connect } = createRelayConnectWS({ url: `ws://127.0.0.1:${relay.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run', pingIntervalMs: 10, pongTimeoutMs: 30 })
  const leg = connect()
  try {
    await once(leg, 'connect')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(leg.destroyed).toBe(false)
    expect(relay.texts.filter((text) => text === RELAY_HOST_PING).length).toBeGreaterThan(3)
  } finally {
    leg.destroy()
    await relay.close()
  }
})

it('stops pinging a leg carrying a phone until the relay has proved it answers pings', async () => {
  const relay = await heartbeatRelay()
  const { connect } = createRelayConnectWS({ url: `ws://127.0.0.1:${relay.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run', pingIntervalMs: 15 })
  const leg = connect()
  try {
    await once(leg, 'connect')
    await until(() => relay.texts.filter((text) => text === RELAY_HOST_PING).length >= 2)
    // An older relay never pongs and would forward a glued leg's pings to the phone.
    relay.sendBinary(Buffer.from([1]))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const afterGlue = relay.texts.filter((text) => text === RELAY_HOST_PING).length
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(relay.texts.filter((text) => text === RELAY_HOST_PING).length).toBe(afterGlue)
    // Once the relay answers, the glued leg is pinged again.
    relay.sendText(RELAY_HOST_PONG)
    await until(() => relay.texts.filter((text) => text === RELAY_HOST_PING).length > afterGlue)
  } finally {
    leg.destroy()
    await relay.close()
  }
})

it('drops a leg that survived a process suspension instead of trusting it', async () => {
  const relay = await heartbeatRelay()
  let clock = 1_000_000
  const { connect } = createRelayConnectWS({
    url: `ws://127.0.0.1:${relay.port}`, hostId: randomUUID(), token: 'isolated-fixture', mode: 'run',
    pingIntervalMs: 25, pongTimeoutMs: 60_000, now: () => clock
  })
  const leg = connect()
  let failure: Error | undefined
  leg.on('error', (error: Error) => { failure = error })
  try {
    await once(leg, 'connect')
    relay.sendText(RELAY_HOST_PONG)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(leg.destroyed).toBe(false)
    // The Mac slept for ten minutes: wall clock jumps far past the interval.
    clock += 600_000
    await until(() => leg.destroyed, 2_000)
    expect(failure?.message).toBe('relay_leg_suspended')
  } finally {
    leg.destroy()
    await relay.close()
  }
})
