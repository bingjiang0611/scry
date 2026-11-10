// Real local workerd lifecycle check. No account, deployment, real credentials
// or Provider execution. The private inspection routes exist only in this fixture.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { unstable_dev } from 'wrangler'

const directory = mkdtempSync(join(tmpdir(), 'scry-cf-lifecycle-'))
const production = fileURLToPath(new URL('cf-relay/src/worker.js', import.meta.url))
writeFileSync(join(directory, 'worker.js'), `
import production, { RelayRoom as ProductionRoom } from ${JSON.stringify(production)}
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/_fixture_')) return env.RELAY.get(env.RELAY.idFromName(url.searchParams.get('host'))).fetch(request)
    return production.fetch(request, env)
  }
}
export class RelayRoom extends ProductionRoom {
  constructor(state, env) {
    super(state, env)
    // Short windows so staleness and waiting are observable in seconds.
    this.limits = { freshMs: 600, waitMs: 1500, offlineGraceMs: 300, recentHostMs: 5000 }
  }
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/_fixture_prepare') {
      for (const ws of this.state.getWebSockets('host')) {
        if (!ws.deserializeAttachment().authed) await this.webSocketMessage(ws, JSON.stringify({token: 'local-lifecycle-fixture'}))
      }
    } else if (url.pathname === '/_fixture_close') {
      this.state.getWebSockets('host')[0].close(1000, 'fixture idle recycle')
    } else if (url.pathname === '/_fixture_live') {
      const now = Date.now()
      return Response.json(this.state.getWebSockets('host').map(ws => ({ state: ws.readyState, now, pong: this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null, ...ws.deserializeAttachment() })))
    } else if (!url.pathname.startsWith('/_fixture_')) return super.fetch(request)
    return Response.json(this.state.getWebSockets().map(ws => ({state: ws.readyState, ...ws.deserializeAttachment()})))
  }
}
`)
writeFileSync(join(directory, 'wrangler.toml'), `
name = "scry-local-lifecycle-fixture"
main = "worker.js"
compatibility_date = "2024-09-23"
[[durable_objects.bindings]]
name = "RELAY"
class_name = "RelayRoom"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["RelayRoom"]
`)
const listener = createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
let worker
const sockets = []
const cases = []
try {
  worker = await unstable_dev(join(directory, 'worker.js'), {
    config: join(directory, 'wrangler.toml'), local: true, persist: false, inspect: false, ip: '127.0.0.1', port,
    vars: { RELAY_TOKEN: 'local-lifecycle-fixture' },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false }
  })
  const base = `ws://127.0.0.1:${worker.port}`
  const inspect = (host, action) => fetch(`http://127.0.0.1:${worker.port}/_fixture_${action}?host=${host}`).then(response => response.json())
  async function pausedHost(host) {
    const socket = new WebSocket(`${base}/host?host=${host}&mode=run`)
    sockets.push(socket)
    await once(socket, 'open')
    // A real slow peer: do not ACK the server close. workerd therefore retains
    // this socket in getWebSockets() with readyState=CLOSING, not a mocked list.
    socket.pause()
  }
  const host = randomUUID()
  await pausedHost(host)
  await pausedHost(host)
  const prepared = await inspect(host, 'prepare')
  assert.equal(prepared.filter(socket => socket.role === 'host' && socket.authed).length, 2)
  const closing = await inspect(host, 'close')
  assert.equal(closing.filter(socket => socket.state === WebSocket.CLOSING).length, 1)
  assert.equal(closing.filter(socket => socket.state === WebSocket.OPEN).length, 1)
  const device = new WebSocket(`${base}/?host=${host}&mode=run`)
  sockets.push(device)
  await once(device, 'open')
  const attached = await inspect(host, 'inspect')
  const deviceState = attached.find(socket => socket.role === 'device')
  const selected = attached.find(socket => socket.id === deviceState?.hostId)
  cases.push({ name: 'closing host skipped while an authenticated open host exists', selectedReadyState: selected?.state })
  console.log(JSON.stringify(cases.at(-1)))
  assert.equal(selected?.state, WebSocket.OPEN)

  const unavailable = randomUUID()
  await pausedHost(unavailable)
  await inspect(unavailable, 'prepare')
  const unavailableStates = await inspect(unavailable, 'close')
  assert.equal(unavailableStates[0].state, WebSocket.CLOSING)
  // Assert the received close frame, not ws's default 30-second TCP close wait.
  // Bound only this diagnostic client's teardown; 1006 still fails the check.
  const rejected = new WebSocket(`${base}/?host=${unavailable}&mode=run`, { closeTimeout: 250 })
  sockets.push(rejected)
  const rejectionEvents = []
  let rejectedWait = null
  rejected.on('upgrade', (response) => { rejectionEvents.push('upgrade'); rejectedWait = Number(response.headers['x-scry-relay-wait-ms']) })
  rejected.on('open', () => rejectionEvents.push('open'))
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ scenario: 'only-closing diagnostic', readyState: rejected.readyState, rejectionEvents }))
      reject(new Error('missing no_host_leg close'))
    }, 5000)
    rejected.once('close', (code, reason) => { clearTimeout(timeout); resolve({code, reason: String(reason)}) })
    rejected.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  assert.deepEqual(await closed, {code: 4001, reason: 'host_offline'})
  // Its leg was just opened and recycled, so the room paid the replacement grace.
  assert.ok(rejectedWait >= 300, `recently active host waited ${rejectedWait} ms`)
  cases.push({ name: 'only closing hosts fails closed as host_offline after the grace', waitedMs: rejectedWait })

  // Current hosts authenticate themselves and ping as text frames.
  async function liveLeg(hostId) {
    const socket = new WebSocket(`${base}/host?host=${hostId}&mode=run`)
    sockets.push(socket)
    const received = []
    socket.on('message', (data, isBinary) => received.push({ data: Buffer.from(data), isBinary }))
    await once(socket, 'open')
    socket.send(JSON.stringify({ token: 'local-lifecycle-fixture' }))
    return { socket, received }
  }
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const ping = async (leg) => {
    const before = leg.received.length
    leg.socket.send('{"t":"ping"}')
    for (let i = 0; i < 100 && leg.received.length === before; i++) await wait(10)
    return leg.received.at(-1)
  }
  async function dial(hostId, timeoutMs = 4000) {
    const socket = new WebSocket(`${base}/?host=${hostId}&mode=run`, { closeTimeout: 250 })
    sockets.push(socket)
    const started = Date.now()
    let waitedMs = null
    socket.once('upgrade', (response) => { waitedMs = Number(response.headers['x-scry-relay-wait-ms']) })
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('device outcome timeout')), timeoutMs)
      socket.once('open', () => {
        // A rejected device is also upgraded first; give a close a moment to land.
        setTimeout(() => { clearTimeout(timer); resolve({ open: socket.readyState === WebSocket.OPEN }) }, 400)
      })
      socket.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason) }) })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
    return { socket, result, elapsedMs: Date.now() - started, waitedMs }
  }

  const pinged = randomUUID()
  const older = await liveLeg(pinged)
  const newer = await liveLeg(pinged)
  const pong = await ping(older)
  assert.equal(pong?.isBinary, false)
  assert.equal(pong?.data.toString(), '{"t":"pong"}')
  cases.push({ name: 'host ping answered with pong, never forwarded', passed: true })
  await wait(50)
  await ping(newer)
  const glued = await dial(pinged)
  assert.deepEqual(glued.result, { open: true })
  glued.socket.send(Buffer.from('inner-hello'))
  await wait(200)
  assert.ok(newer.received.some(m => m.isBinary && m.data.toString() === 'inner-hello'))
  assert.ok(!older.received.some(m => m.isBinary))
  cases.push({ name: 'device glued to the most recently pinged leg', passed: true })

  const stale = randomUUID()
  const silent = await liveLeg(stale)
  await ping(silent)
  const silentClosed = new Promise(resolve => silent.socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })))
  await wait(900)
  const offline = await dial(stale)
  assert.deepEqual(offline.result, { code: 4001, reason: 'host_offline' })
  assert.deepEqual(await silentClosed, { code: 1011, reason: 'stale_leg' })
  cases.push({ name: 'silent pinging leg is closed and the host reported offline', elapsedMs: offline.elapsedMs })

  const busy = randomUUID()
  const first = await liveLeg(busy)
  await ping(first)
  const holder = await dial(busy)
  assert.deepEqual(holder.result, { open: true })
  const waiting = dial(busy)
  await wait(300)
  const replacement = await liveLeg(busy)
  await ping(replacement)
  const late = await waiting
  assert.deepEqual(late.result, { open: true })
  late.socket.send(Buffer.from('second'))
  await wait(200)
  assert.ok(replacement.received.some(m => m.isBinary && m.data.toString() === 'second'))
  cases.push({ name: 'busy live host: device waits for the replacement leg', elapsedMs: late.elapsedMs })

  // Both legs are busy but alive: keep their liveness evidence current.
  await ping(first); await ping(replacement)
  const busyNoReplacement = await dial(busy)
  assert.deepEqual(busyNoReplacement.result, { code: 1013, reason: 'no_host_leg' })
  cases.push({ name: 'busy live host without replacement fails as no_host_leg', elapsedMs: busyNoReplacement.elapsedMs })

  const absent = await dial(randomUUID())
  assert.deepEqual(absent.result, { code: 4001, reason: 'host_offline' })
  assert.ok(absent.elapsedMs < 1500, `offline answer took ${absent.elapsedMs} ms`)
  // No host ever touched this room: nothing to wait for.
  assert.equal(absent.waitedMs, 0)
  cases.push({ name: 'host with no legs reported offline without a grace', elapsedMs: absent.elapsedMs, waitedMs: absent.waitedMs })
  console.log(JSON.stringify({scope: 'real local workerd + production selection; no deploy/spend', cases}, null, 2))
} finally {
  for (const socket of sockets) { socket.resume(); socket.terminate() }
  if (worker) await worker.stop()
  rmSync(directory, {recursive: true, force: true})
}
