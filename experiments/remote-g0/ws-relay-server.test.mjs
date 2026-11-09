import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { createWsRelayServer } from './ws-relay-server.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-ws-relay-'))
  const relay = createWsRelayServer({ storePath: join(dir, 'rooms.json'), adminToken: 'admin-token', freshMs: 600, waitMs: 1_500, offlineGraceMs: 300, ...options })
  const port = await relay.listen(0)
  const sockets = []
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    await relay.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const base = `ws://127.0.0.1:${port}`
  async function leg(hostId, token = 'admin-token', extra = {}) {
    const socket = new WebSocket(`${base}/host?host=${hostId}&mode=run`)
    sockets.push(socket)
    const received = []
    socket.on('message', (data, isBinary) => received.push({ data: Buffer.from(data), isBinary }))
    await once(socket, 'open')
    socket.send(JSON.stringify({ token, ...extra }))
    await wait(30)
    return { socket, received }
  }
  async function ping(host) {
    const before = host.received.length
    host.socket.send('{"t":"ping"}')
    for (let i = 0; i < 100 && host.received.length === before; i++) await wait(5)
    return host.received.at(-1)
  }
  async function device(hostId) {
    const socket = new WebSocket(`${base}/?host=${hostId}&mode=run`)
    sockets.push(socket)
    const started = Date.now()
    let waitHeader
    socket.on('upgrade', (response) => { waitHeader = response.headers['x-scry-relay-wait-ms'] })
    const result = await new Promise((resolve, reject) => {
      socket.once('open', () => setTimeout(() => resolve({ open: socket.readyState === WebSocket.OPEN }), 150))
      socket.once('close', (code, reason) => resolve({ code, reason: String(reason) }))
      socket.once('error', reject)
    })
    return { socket, result, elapsedMs: Date.now() - started, waitHeader }
  }
  return { dir, leg, ping, device }
}

test('shuttles binary both ways, answers pings without forwarding them, and picks the freshest leg', async (t) => {
  const { leg, ping, device } = await harness(t)
  const hostId = randomUUID()
  const older = await leg(hostId)
  const newer = await leg(hostId)
  const pong = await ping(older)
  assert.equal(pong.isBinary, false)
  assert.equal(pong.data.toString(), '{"t":"pong"}')
  await wait(20)
  await ping(newer)
  const phone = await device(hostId)
  assert.deepEqual(phone.result, { open: true })
  phone.socket.send(Buffer.from('hello'))
  await wait(50)
  assert.ok(newer.received.some((m) => m.isBinary && m.data.toString() === 'hello'))
  assert.ok(!older.received.some((m) => m.isBinary))
  const back = once(phone.socket, 'message')
  newer.socket.send(Buffer.from('world'))
  const [data, isBinary] = await back
  assert.equal(isBinary, true)
  assert.equal(Buffer.from(data).toString(), 'world')
  // A ping on the glued leg still never reaches the phone.
  const phoneFrames = []
  phone.socket.on('message', (frame) => phoneFrames.push(frame))
  await ping(newer)
  await wait(50)
  assert.equal(phoneFrames.length, 0)
})

test('reports an offline host fast, waits for a busy live host, and closes silent legs', async (t) => {
  const { leg, ping, device } = await harness(t)
  const absent = await device(randomUUID())
  assert.deepEqual(absent.result, { code: 4001, reason: 'host_offline' })
  assert.ok(absent.elapsedMs < 1_200)
  assert.ok(Number(absent.waitHeader) >= 250)

  const busy = randomUUID()
  const first = await leg(busy)
  await ping(first)
  const holder = await device(busy)
  assert.deepEqual(holder.result, { open: true })
  const waiting = device(busy)
  await wait(200)
  const replacement = await leg(busy)
  await ping(replacement)
  assert.deepEqual((await waiting).result, { open: true })
  await ping(first); await ping(replacement)
  assert.deepEqual((await device(busy)).result, { code: 1013, reason: 'no_host_leg' })

  const stale = randomUUID()
  const silent = await leg(stale)
  await ping(silent)
  const closed = once(silent.socket, 'close')
  await wait(800)
  assert.deepEqual((await device(stale)).result, { code: 4001, reason: 'host_offline' })
  const [code] = await closed
  assert.equal(code, 1011)
})

test('enrolls a room token once, persists only its digest, and refuses a takeover', async (t) => {
  const { dir, leg, device } = await harness(t)
  const hostId = randomUUID()
  const token = randomBytes(32).toString('base64url')
  await leg(hostId, token, { enroll: true })
  const stored = JSON.parse(readFileSync(join(dir, 'rooms.json'), 'utf8'))
  assert.equal(Object.keys(stored).length, 1)
  assert.ok(!JSON.stringify(stored).includes(token))
  const attacker = await leg(hostId, randomBytes(32).toString('base64url'), { enroll: true })
  if (attacker.socket.readyState !== WebSocket.CLOSED) await once(attacker.socket, 'close')
  const phone = await device(hostId)
  assert.deepEqual(phone.result, { open: true })
})
