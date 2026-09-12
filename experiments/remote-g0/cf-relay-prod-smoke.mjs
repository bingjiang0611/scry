// Verify the LIVE deployed Cloudflare relay (public wss) end-to-end with the
// production host adapter. Reads URL + token from env so no secret is committed:
//   SCRY_CF_URL=wss://scry-relay.<subdomain>.workers.dev \
//   SCRY_CF_TOKEN=<RELAY_TOKEN> \
//   node --import ./ts-relative-resolve.mjs cf-relay-prod-smoke.mjs
//
// It wires createRelayConnectWS -> ReverseTunnelTransport -> RelayClient serving
// a trivial echo StreamServer, connects a device WebSocket to the public relay,
// and asserts bytes round-trip through the real Worker + Durable Object over
// real (publicly-trusted) outer TLS. This exercises deployment + hibernation +
// the host WSS leg, not the inner mTLS (covered by the loopback suites).
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRelayConnectWS } from '../../src/main/remote/relay-connect-ws.ts'
import { ReverseTunnelTransport, RelayClient } from '../../src/main/remote/relay-client.ts'

// Test-only: if this machine's egress is forced through an HTTP proxy, route the
// global WebSocket through it so the production adapter (which uses the global
// WebSocket unchanged) can reach the public relay. A real Mac with direct
// internet needs none of this.
const proxy = process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.https_proxy
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(new ProxyAgent(proxy))
}

const url = process.env.SCRY_CF_URL
const token = process.env.SCRY_CF_TOKEN
if (!url || !token) { console.error('set SCRY_CF_URL and SCRY_CF_TOKEN'); process.exit(2) }

const echoServer = {
  serve(stream) {
    stream.on('data', (chunk) => { stream.write(Buffer.from(chunk.toString('utf8').toUpperCase())) })
  }
}

const hostId = randomUUID()
const cases = []
let client
try {
  const { connect, readyEvent } = createRelayConnectWS({ url, hostId, token, mode: 'run' })
  const transport = new ReverseTunnelTransport({ connect, poolSize: 2, readyEvent })
  client = new RelayClient({ host: echoServer, transport })
  await client.start()
  await new Promise((r) => setTimeout(r, 1500)) // warm legs register with the DO over the internet

  let echoed = null
  for (let attempt = 0; attempt < 10 && echoed === null; attempt++) {
    const device = new WebSocket(`${url.replace(/\/+$/, '')}/?host=${hostId}&mode=run`)
    device.binaryType = 'arraybuffer'
    let closed1013 = false
    device.addEventListener('close', (ev) => { if (ev.code === 1013) closed1013 = true })
    await once(device, 'open')
    const got = new Promise((resolve) => {
      device.addEventListener('message', (ev) => resolve(Buffer.from(ev.data)), { once: true })
      device.addEventListener('close', () => resolve(null), { once: true })
    })
    device.send(new TextEncoder().encode('hello public relay'))
    const buf = await got
    if (buf) { echoed = buf.toString('utf8'); device.close(); break }
    if (!closed1013) { device.close(); break }
    await new Promise((r) => setTimeout(r, 400))
  }
  assert.equal(echoed, 'HELLO PUBLIC RELAY')
  cases.push({ name: 'live public wss relay echoes device bytes through the deployed Worker + DO', passed: true })

  // A wrong token must never register a warm leg: a device then gets 1013.
  {
    const badId = randomUUID()
    const bad = createRelayConnectWS({ url, hostId: badId, token: 'wrong-token', mode: 'run' })
    const badTransport = new ReverseTunnelTransport({ connect: bad.connect, poolSize: 1, readyEvent: bad.readyEvent })
    const badClient = new RelayClient({ host: echoServer, transport: badTransport })
    await badClient.start()
    await new Promise((r) => setTimeout(r, 1200))
    const device = new WebSocket(`${url.replace(/\/+$/, '')}/?host=${badId}&mode=run`)
    device.binaryType = 'arraybuffer'
    const code = await new Promise((resolve) => {
      device.addEventListener('close', (ev) => resolve(ev.code), { once: true })
      device.addEventListener('open', () => device.send(new TextEncoder().encode('x')), { once: true })
    })
    await badClient.close()
    assert.equal(code, 1013)
    cases.push({ name: 'wrong token registers no leg -> device 1013 on live relay', passed: true })
  }

  console.log(JSON.stringify({ scope: 'LIVE deployed Cloudflare relay (public wss) with production host adapter', url, cases }, null, 2))
} finally {
  if (client) await client.close()
}
