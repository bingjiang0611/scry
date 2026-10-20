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
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/_fixture_prepare') {
      for (const ws of this.state.getWebSockets('host')) {
        if (!ws.deserializeAttachment().authed) await this.webSocketMessage(ws, JSON.stringify({token: 'local-lifecycle-fixture'}))
      }
    } else if (url.pathname === '/_fixture_close') {
      this.state.getWebSockets('host')[0].close(1000, 'fixture idle recycle')
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
  rejected.on('upgrade', () => rejectionEvents.push('upgrade'))
  rejected.on('open', () => rejectionEvents.push('open'))
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ scenario: 'only-closing diagnostic', readyState: rejected.readyState, rejectionEvents }))
      reject(new Error('missing no_host_leg close'))
    }, 5000)
    rejected.once('close', (code, reason) => { clearTimeout(timeout); resolve({code, reason: String(reason)}) })
    rejected.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  assert.deepEqual(await closed, {code: 1013, reason: 'no_host_leg'})
  cases.push({ name: 'only closing hosts fails closed as no_host_leg', passed: true })
  console.log(JSON.stringify({scope: 'real local workerd + production selection; no deploy/spend', cases}, null, 2))
} finally {
  for (const socket of sockets) { socket.resume(); socket.terminate() }
  if (worker) await worker.stop()
  rmSync(directory, {recursive: true, force: true})
}
