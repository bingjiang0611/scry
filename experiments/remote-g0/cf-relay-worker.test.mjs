// Zero-dependency local tests for experiments/remote-g0/cf-relay/src/worker.js
// exercising RelayRoom's leg liveness, selection, auth/ping race, and forwarding
// teardown without deploying or touching the live Cloudflare relay.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

const OriginalResponse = globalThis.Response
const OriginalWebSocket = globalThis.WebSocket
const OriginalWebSocketPair = globalThis.WebSocketPair
const OriginalAutoPair = globalThis.WebSocketRequestResponsePair

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = FakeWebSocket.OPEN
  attachment = null
  sent = []
  closed = null
  throwOnSend = false
  peer = null
  onClose = null

  send(data) {
    if (this.throwOnSend || this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('socket_not_open')
    }
    this.sent.push(data)
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.closed = { code, reason }
    this.onClose?.(this)
  }

  serializeAttachment(value) {
    this.attachment = structuredClone(value)
  }

  deserializeAttachment() {
    return this.attachment === null ? null : structuredClone(this.attachment)
  }
}

class FakeWebSocketPair {
  constructor() {
    const client = new FakeWebSocket()
    const server = new FakeWebSocket()
    client.peer = server
    server.peer = client
    return [client, server]
  }
}

class FakeAutoPair {
  constructor(request, response) {
    this.request = request
    this.response = response
  }
}

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body
    this.status = init.status ?? 200
    this.webSocket = init.webSocket ?? null
    this.headers = new Headers(init.headers ?? {})
  }
}

globalThis.WebSocket = FakeWebSocket
globalThis.WebSocketPair = FakeWebSocketPair
globalThis.WebSocketRequestResponsePair = FakeAutoPair
globalThis.Response = FakeResponse

after(() => {
  globalThis.Response = OriginalResponse
  globalThis.WebSocket = OriginalWebSocket
  globalThis.WebSocketPair = OriginalWebSocketPair
  globalThis.WebSocketRequestResponsePair = OriginalAutoPair
})

const { RelayRoom } = await import('./cf-relay/src/worker.js')

function createRoom({ autoResponse = true, freshMs = 100, waitMs = 150, offlineGraceMs = 40, recentHostMs = 500, txnDelayMs = 0 } = {}) {
  const accepted = []
  const autoPongAt = new WeakMap()
  const store = new Map()
  const state = {
    acceptWebSocket(ws, tags = []) {
      accepted.push({ ws, tags })
    },
    getWebSockets(tag) {
      return accepted
        .filter((entry) => entry.ws.readyState !== FakeWebSocket.CLOSED)
        .filter((entry) => !tag || entry.tags.includes(tag))
        .map((entry) => entry.ws)
    },
    setWebSocketAutoResponse(pair) {
      if (!autoResponse) throw new Error('auto_response_unsupported')
      state.autoPair = pair
    },
    getWebSocketAutoResponseTimestamp(ws) {
      const ts = autoPongAt.get(ws)
      return ts === undefined ? null : new Date(ts)
    },
    storage: {
      async transaction(fn) {
        if (txnDelayMs > 0) await new Promise((r) => setTimeout(r, txnDelayMs))
        const txn = {
          async get(key) { return store.get(key) },
          async put(key, value) { store.set(key, value) }
        }
        return fn(txn)
      }
    }
  }
  const room = new RelayRoom(state, { RELAY_TOKEN: 'legacy-test-token' })
  room.limits = { freshMs, waitMs, offlineGraceMs, recentHostMs }

  const openHost = async (hostId, mode = 'run') => {
    const res = await room.fetch(new Request(`https://relay.test/host?host=${hostId}&mode=${mode}`, {
      headers: { Upgrade: 'websocket' }
    }))
    return res.webSocket.peer
  }
  const openDevice = async (hostId, mode = 'run') => {
    const res = await room.fetch(new Request(`https://relay.test/?host=${hostId}&mode=${mode}`, {
      headers: { Upgrade: 'websocket' }
    }))
    return res.webSocket.peer
  }
  const recordAutoPing = (ws, at = Date.now()) => {
    autoPongAt.set(ws, at)
  }

  return { room, state, openHost, openDevice, recordAutoPing }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('pinging room evicts stale unpinged zombie host leg instead of gluing a device to it', async () => {
  const { room, openHost, openDevice, recordAutoPing } = createRoom({ freshMs: 60, waitMs: 80, offlineGraceMs: 20 })
  const hostId = randomUUID()
  const token = randomBytes(32).toString('base64url')

  // Leg 1 opens, authenticates, and proves this host is a pinging host.
  const liveLeg = await openHost(hostId)
  await room.webSocketMessage(liveLeg, JSON.stringify({ token, enroll: true }))
  recordAutoPing(liveLeg, Date.now())

  // Leg 2 opens and authenticates, then silently dies before ever sending a ping.
  const zombieLeg = await openHost(hostId)
  await room.webSocketMessage(zombieLeg, JSON.stringify({ token, enroll: true }))

  // Wait past freshMs; keep liveLeg alive with a fresh ping while zombieLeg stays silent.
  await wait(80)
  recordAutoPing(liveLeg, Date.now())

  // First device consumes liveLeg; second device must NOT be glued to the stale unpinged zombieLeg.
  const firstDevice = await openDevice(hostId)
  assert.equal(firstDevice.closed, null)

  const secondDevice = await openDevice(hostId)
  assert.deepEqual(zombieLeg.closed, { code: 1011, reason: 'stale_leg' })
  assert.deepEqual(secondDevice.closed, { code: 1013, reason: 'no_host_leg' })
})

test('manual-ping arriving during async auth is not lost and does not leave a zombie unpinged leg', async () => {
  const { room, openHost, openDevice } = createRoom({ autoResponse: false, freshMs: 60, waitMs: 80, offlineGraceMs: 20, txnDelayMs: 25 })
  const hostId = randomUUID()
  const token = randomBytes(32).toString('base64url')

  // Simulate createRelayConnectWS: auth JSON and HOST_PING sent back-to-back on open.
  const leg = await openHost(hostId)
  const authPromise = room.webSocketMessage(leg, JSON.stringify({ token, enroll: true }))
  const pingPromise = room.webSocketMessage(leg, '{"t":"ping"}')
  await Promise.all([authPromise, pingPromise])

  // Because the ping was recorded, going silent past freshMs must evict the leg as stale_leg
  // and report host_offline (4001), not glue a device to a dead socket.
  await wait(80)
  const device = await openDevice(hostId)
  assert.deepEqual(leg.closed, { code: 1011, reason: 'stale_leg' })
  assert.deepEqual(device.closed, { code: 4001, reason: 'host_offline' })
})

test('forwarding to a dead or throwing host leg closes the device immediately instead of timing out', async () => {
  const { room, openHost, openDevice, recordAutoPing } = createRoom({ freshMs: 500 })
  const hostId = randomUUID()

  const hostLeg = await openHost(hostId)
  await room.webSocketMessage(hostLeg, JSON.stringify({ token: 'legacy-test-token' }))
  recordAutoPing(hostLeg, Date.now())

  const device = await openDevice(hostId)
  assert.equal(device.closed, null)

  // Host socket fails on send (e.g. edge observed teardown while forwarding ClientHello).
  hostLeg.throwOnSend = true
  await room.webSocketMessage(device, new Uint8Array([0x16, 0x03, 0x01]))
  assert.deepEqual(device.closed, { code: 1000, reason: 'peer_closed' })
  assert.notEqual(hostLeg.closed, null)
})

test('legacy non-pinging host keeps working when the room has never observed a ping', async () => {
  const { room, openHost, openDevice } = createRoom({ freshMs: 40, waitMs: 80, offlineGraceMs: 20 })
  const hostId = randomUUID()

  const legacyLeg = await openHost(hostId)
  await room.webSocketMessage(legacyLeg, JSON.stringify({ token: 'legacy-test-token' }))
  // An unauthenticated socket sending ping must not flip hostPings for a legacy room.
  const unauthed = await openHost(hostId)
  await room.webSocketMessage(unauthed, '{"t":"ping"}')
  await wait(60)

  const device = await openDevice(hostId)
  assert.deepEqual(unauthed.closed, { code: 1008, reason: 'auth_timeout' })
  assert.equal(device.closed, null)
  await room.webSocketMessage(device, new Uint8Array([1, 2, 3]))
  assert.equal(legacyLeg.sent.length, 1)
})
