import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect as netConnect } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createRelayServer } from './relay-server.mjs'

const HOST_ID = '00000000-0000-4000-8000-000000000abc'
const GOOD = 'good-token'

function authorizeHost({ hostId, token }) {
  return hostId === HOST_ID && token === GOOD
}

async function warmLeg(hostPort, { hostId = HOST_ID, token = GOOD, mode = 'run' } = {}) {
  const leg = netConnect({ port: hostPort, host: '127.0.0.1' })
  leg.on('error', () => {})
  await once(leg, 'connect')
  leg.write(JSON.stringify({ hostId, token, mode }) + '\n')
  return leg
}

test('relay bridges an authenticated host leg to a device over WSS, raw-shuttling bytes', async () => {
  const server = createRelayServer({ authorizeHost })
  const { hostPort, devicePort } = await server.listen({})
  try {
    const leg = await warmLeg(hostPort)
    await delay(50) // let the relay register the warm leg

    const ws = new WebSocket(`ws://127.0.0.1:${devicePort}/?host=${HOST_ID}&mode=run`)
    await once(ws, 'open')

    // device -> host
    const hostRecv = once(leg, 'data')
    ws.send(Buffer.from('client-hello'), { binary: true })
    const [fromDevice] = await hostRecv
    assert.equal(fromDevice.toString('utf8'), 'client-hello')

    // host -> device
    const devRecv = once(ws, 'message')
    leg.write(Buffer.from('server-hello'))
    const [fromHost, isBinary] = await devRecv
    assert.equal(isBinary, true)
    assert.equal(Buffer.from(fromHost).toString('utf8'), 'server-hello')

    ws.close(); leg.destroy()
  } finally {
    await server.close()
  }
})

test('relay refuses a host leg with a bad token and never registers it as a warm leg', async () => {
  const server = createRelayServer({ authorizeHost })
  const { hostPort, devicePort } = await server.listen({})
  try {
    const leg = netConnect({ port: hostPort, host: '127.0.0.1' })
    leg.on('error', () => {})
    await once(leg, 'connect')
    leg.write(JSON.stringify({ hostId: HOST_ID, token: 'wrong', mode: 'run' }) + '\n')
    await delay(100) // let the relay evaluate + reject the auth line

    // The unauthorized leg was never registered, so a device for that host has
    // no leg to bridge to and is closed (1013) rather than connected.
    const ws = new WebSocket(`ws://127.0.0.1:${devicePort}/?host=${HOST_ID}`)
    const [code] = await once(ws, 'close')
    assert.equal(code, 1013)
    leg.destroy()
  } finally {
    await server.close()
  }
})

test('relay refuses a device for an unknown host id', async () => {
  const server = createRelayServer({ authorizeHost })
  const { devicePort } = await server.listen({})
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${devicePort}/?host=not-a-uuid`)
    const [code] = await once(ws, 'close')
    assert.equal(code, 1008)
  } finally {
    await server.close()
  }
})

test('relay keeps run and pair legs in separate pools (a run device never gets a pair leg)', async () => {
  const server = createRelayServer({ authorizeHost })
  const { hostPort, devicePort } = await server.listen({})
  try {
    // Only a PAIR leg is warm; a RUN device must not be bridged to it.
    await warmLeg(hostPort, { mode: 'pair' })
    await delay(50)
    const ws = new WebSocket(`ws://127.0.0.1:${devicePort}/?host=${HOST_ID}&mode=run`)
    const [code] = await once(ws, 'close')
    assert.equal(code, 1013)
  } finally {
    await server.close()
  }
})
