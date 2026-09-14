// End-to-end check of the PRODUCTION Cloudflare host leg against the real relay
// Worker under local workerd (wrangler dev). It wires createRelayConnectWS ->
// ReverseTunnelTransport -> RelayClient serving a trivial echo StreamServer, then
// connects a device WebSocket and asserts bytes round-trip through the Worker and
// the production Duplex adapter. No account/deploy/spend; global WebSocket only.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { unstable_dev } from 'wrangler'
import { createRelayConnectWS } from '../../src/main/remote/relay-connect-ws.ts'
import { ReverseTunnelTransport, RelayClient } from '../../src/main/remote/relay-client.ts'

const cfDir = fileURLToPath(new URL('cf-relay/', import.meta.url))
const TOKEN = randomBytes(32).toString('base64url')

// Trivial StreamServer: echo every chunk back, upper-cased, proving the host
// Duplex both receives device bytes and writes bytes back through the Worker.
const echoServer = {
  serve(stream) {
    stream.on('data', (chunk) => { stream.write(Buffer.from(chunk.toString('utf8').toUpperCase())) })
  }
}

const worker = await unstable_dev(cfDir + 'src/worker.js', {
  config: cfDir + 'wrangler.toml',
  vars: { RELAY_TOKEN: 'local-dev-token' },
  experimental: { disableExperimentalWarning: true }
})
const base = `ws://127.0.0.1:${worker.port}`
const hostId = randomUUID()
const cases = []
let client
try {
  const { connect, readyEvent } = createRelayConnectWS({ url: base, hostId, token: TOKEN, enroll: true, mode: 'run' })
  const transport = new ReverseTunnelTransport({ connect, poolSize: 2, readyEvent })
  client = new RelayClient({ host: echoServer, transport })
  await client.start()
  await new Promise((r) => setTimeout(r, 1200)) // warm pool opens + registers with the DO

  // Retry the device connection until a warm leg is available (relay returns 1013
  // only while no leg is registered). Proves rendezvous, not just first-shot luck.
  let echoed = null
  for (let attempt = 0; attempt < 8 && echoed === null; attempt++) {
    const device = new WebSocket(`${base}/?host=${hostId}&mode=run`)
    device.binaryType = 'arraybuffer'
    let closed1013 = false
    device.addEventListener('close', (ev) => { if (ev.code === 1013) closed1013 = true })
    await once(device, 'open')
    const got = new Promise((resolve) => {
      device.addEventListener('message', (ev) => resolve(Buffer.from(ev.data)), { once: true })
      device.addEventListener('close', () => resolve(null), { once: true })
    })
    device.send(new TextEncoder().encode('hello relay'))
    const buf = await got
    if (buf) { echoed = buf.toString('utf8'); device.close(); break }
    if (!closed1013) { device.close(); break }
    await new Promise((r) => setTimeout(r, 300))
  }
  assert.equal(echoed, 'HELLO RELAY')
  cases.push({ name: 'production host leg self-enrolls and echoes device bytes through the Worker', passed: true })

  console.log(JSON.stringify({ scope: 'production Cloudflare host leg vs relay Worker under local workerd; no account/deploy/spend', cases }, null, 2))
} finally {
  if (client) await client.close()
  await worker.stop()
}
