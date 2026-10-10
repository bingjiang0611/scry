import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Socket, type Server } from 'node:net'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import { createRelayConnect } from './relay-connect'
import { ReverseTunnelTransport } from './relay-client'

const HOST_ID = '00000000-0000-4000-8000-000000000abc'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

// A raw TCP relay stand-in: records each host leg and the auth line it sent.
async function tcpRelay(): Promise<{ port: number; legs: Array<{ socket: Socket; auth: Promise<string> }> }> {
  const legs: Array<{ socket: Socket; auth: Promise<string> }> = []
  const server: Server = createServer((socket) => {
    const auth = new Promise<string>((resolve) => {
      let buffer = ''
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const nl = buffer.indexOf('\n')
        if (nl < 0) return
        socket.off('data', onData)
        resolve(buffer.slice(0, nl))
      }
      socket.on('data', onData)
    })
    legs.push({ socket, auth })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    for (const leg of legs) leg.socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { port: (server.address() as { port: number }).port, legs }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('createRelayConnect (raw TCP relay leg)', () => {
  it('authenticates, then reports the device session and shuttles bytes both ways', async () => {
    const relay = await tcpRelay()
    const { connect, readyEvent } = createRelayConnect({ host: '127.0.0.1', port: relay.port, hostId: HOST_ID, token: 't', mode: 'run' })
    const leg = connect()
    await once(leg, readyEvent)
    await until(() => relay.legs.length === 1)
    expect(JSON.parse(await relay.legs[0].auth)).toEqual({ hostId: HOST_ID, token: 't', mode: 'run' })

    const events: string[] = []
    leg.once('relaySession', () => events.push('relaySession'))
    leg.on('data', (bytes: Buffer) => events.push(`data:${bytes.toString('utf8')}`))
    relay.legs[0].socket.write('device-hello')
    await until(() => events.length >= 2)
    expect(events).toEqual(['relaySession', 'data:device-hello'])

    const reply = once(relay.legs[0].socket, 'data')
    leg.write('host-reply')
    expect(String((await reply)[0])).toBe('host-reply')
    leg.destroy()
  })

  // Persistent device lanes hold legs open. The pool must still keep its warm
  // legs, otherwise the relay has none left for the next lane (observed: the
  // third lane of one device failed with no_host_leg while two were open).
  it('keeps the warm pool full while device sessions hold legs open', async () => {
    const relay = await tcpRelay()
    const { connect, readyEvent } = createRelayConnect({ host: '127.0.0.1', port: relay.port, hostId: HOST_ID, token: 't', mode: 'run' })
    const served: Duplex[] = []
    const transport = new ReverseTunnelTransport({ connect, readyEvent, poolSize: 2 })
    cleanups.push(() => transport.close())
    await transport.start((stream) => { served.push(stream) })
    await until(() => relay.legs.length === 2)
    relay.legs[0].socket.write('lane-1')
    relay.legs[1].socket.write('lane-2')
    // Both sessions stay open; two fresh waiting legs replace them.
    await until(() => relay.legs.length === 4)
    expect(relay.legs.slice(0, 2).every((leg) => !leg.socket.destroyed)).toBe(true)
  })
})
