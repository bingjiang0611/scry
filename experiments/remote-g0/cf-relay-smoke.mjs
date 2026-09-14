// Local verification of the deployable Cloudflare relay Worker + Durable Object
// via wrangler's programmatic dev server (workerd). No Cloudflare account, no
// deploy, no spend. It drives the relay exactly as the real device + Mac host
// would (WebSocket both sides) and asserts the byte shuttle, first-frame token
// auth, run/pair pool separation, and no-leg rejection.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { unstable_dev } from 'wrangler'

const cfDir = fileURLToPath(new URL('cf-relay/', import.meta.url))
const TOKEN = 'local-dev-token'

function openWS(url) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  return ws
}
function nextBinary(ws) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => { cleanup(); resolve(Buffer.from(ev.data)) }
    const onClose = (ev) => { cleanup(); reject(new Error('closed ' + ev.code)) }
    const cleanup = () => { ws.removeEventListener('message', onMsg); ws.removeEventListener('close', onClose) }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('close', onClose)
  })
}
function nextClose(ws) {
  return new Promise((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code), { once: true }))
}

const worker = await unstable_dev(cfDir + 'src/worker.js', {
  config: cfDir + 'wrangler.toml',
  vars: { RELAY_TOKEN: 'local-dev-token' },
  experimental: { disableExperimentalWarning: true }
})
const base = `ws://127.0.0.1:${worker.port}`
const cases = []
try {
  // Warm one authenticated host leg (run), then a device is glued to it and the
  // relay raw-shuttles binary both ways.
  {
    const hostId = randomUUID()
    const host = openWS(`${base}/host?host=${hostId}&mode=run`)
    await once(host, 'open')
    host.send(JSON.stringify({ token: TOKEN }))
    await new Promise((r) => setTimeout(r, 150)) // let the DO register the leg
    const device = openWS(`${base}/?host=${hostId}&mode=run`)
    await once(device, 'open')
    const gotAtHost = nextBinary(host)
    device.send(new Uint8Array([1, 2, 3, 4]))
    assert.deepEqual(await gotAtHost, Buffer.from([1, 2, 3, 4]))
    const gotAtDevice = nextBinary(device)
    host.send(new Uint8Array([9, 8, 7]))
    assert.deepEqual(await gotAtDevice, Buffer.from([9, 8, 7]))
    host.close(); device.close()
    cases.push({ name: 'authenticated host leg <-> device raw byte shuttle both ways', passed: true })
  }

  // A wrong legacy token is rejected and the leg never registers.
  {
    const hostId = randomUUID()
    const host = openWS(`${base}/host?host=${hostId}&mode=run`)
    await once(host, 'open')
    host.send(JSON.stringify({ token: 'wrong' }))
    assert.equal(await nextClose(host), 1008)
    cases.push({ name: 'wrong token -> 1008, no warm leg', passed: true })
  }

  // An official client can atomically claim its random UUID room with a local
  // per-host token. That same token works after reconnect; a different token
  // cannot take over the claimed room.
  {
    const hostId = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const first = openWS(`${base}/host?host=${hostId}&mode=run`)
    await once(first, 'open')
    first.send(JSON.stringify({ token, enroll: true }))
    await new Promise((r) => setTimeout(r, 150))
    first.close()

    const attacker = openWS(`${base}/host?host=${hostId}&mode=run`)
    await once(attacker, 'open')
    attacker.send(JSON.stringify({ token: randomBytes(32).toString('base64url'), enroll: true }))
    assert.equal(await nextClose(attacker), 1008)

    const restored = openWS(`${base}/host?host=${hostId}&mode=run`)
    await once(restored, 'open')
    restored.send(JSON.stringify({ token, enroll: true }))
    await new Promise((r) => setTimeout(r, 150))
    const device = openWS(`${base}/?host=${hostId}&mode=run`)
    await once(device, 'open')
    const gotAtHost = nextBinary(restored)
    device.send(new Uint8Array([4, 2]))
    assert.deepEqual(await gotAtHost, Buffer.from([4, 2]))
    restored.close(); device.close()
    cases.push({ name: 'per-host room enrollment is stable and rejects takeover', passed: true })
  }

  // No warm leg -> device is rejected 1013 (not left hanging).
  {
    const hostId = randomUUID()
    const device = openWS(`${base}/?host=${hostId}&mode=run`)
    await once(device, 'open')
    assert.equal(await nextClose(device), 1013)
    cases.push({ name: 'no host leg -> device 1013', passed: true })
  }

  // Pool separation: only a PAIR leg is warm; a RUN device must not get it.
  {
    const hostId = randomUUID()
    const host = openWS(`${base}/host?host=${hostId}&mode=pair`)
    await once(host, 'open')
    host.send(JSON.stringify({ token: TOKEN }))
    await new Promise((r) => setTimeout(r, 150))
    const device = openWS(`${base}/?host=${hostId}&mode=run`)
    await once(device, 'open')
    assert.equal(await nextClose(device), 1013)
    host.close()
    cases.push({ name: 'run device never gets a pair leg (pool separation)', passed: true })
  }

  console.log(JSON.stringify({ scope: 'Cloudflare relay Worker + Durable Object under local workerd (wrangler dev); no account/deploy/spend', cases }, null, 2))
} finally {
  await worker.stop()
}
