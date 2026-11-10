// Credential-free probe of the phone's relay path, run from any machine (the
// Mac, or a laptop on the phone's network). For each sample it times
//   dns       name resolution
//   tcp       TCP connect to the resolved address
//   tls       outer TLS handshake (wss only)
//   upgrade   WebSocket 101 from the relay (edge -> Worker -> Durable Object)
//   close     the relay's verdict frame for a random, unused host room
// and records the Cloudflare colo from `cf-ray` and the close code:
//   4001 host_offline  current relay (heartbeat-aware)
//   1013 no_host_leg   relay deployed before the heartbeat change
// It never authenticates, never names a real host, so it consumes no Mac leg
// and carries no inner traffic. It connects directly (no HTTP(S)_PROXY), which
// is the path a phone without a proxy takes.
//
//   node experiments/remote-g0/relay-path-probe.mjs [wss://relay.example] [--samples=5]
import { lookup } from 'node:dns/promises'
import { connect as tcpConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const DEFAULT_RELAY = 'wss://scry-relay-pages.pages.dev'
const argv = process.argv.slice(2)
const origin = new URL(argv.find((arg) => !arg.startsWith('--')) ?? DEFAULT_RELAY)
const samples = Math.max(1, Math.min(50, Number((argv.find((arg) => arg.startsWith('--samples=')) ?? '--samples=5').split('=')[1]) || 5))
const timeoutMs = 15_000
if (!['ws:', 'wss:'].includes(origin.protocol)) throw new Error('relay must be ws:// or wss://')
const secure = origin.protocol === 'wss:'
const port = Number(origin.port || (secure ? 443 : 80))

const emit = (event, fields) => console.log(`RELAYPROBE ${JSON.stringify({ event, ...fields })}`)
const round = (value) => (value === undefined ? undefined : Math.round(value * 10) / 10)

function closeCode(buffer) {
  // Server frames are unmasked. Find the first close frame (opcode 0x8).
  let offset = 0
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f
    let length = buffer[offset + 1] & 0x7f
    let header = 2
    if (length === 126) { if (buffer.length - offset < 4) return undefined; length = buffer.readUInt16BE(offset + 2); header = 4 }
    // A 64-bit length never frames a close; say so instead of waiting for one.
    else if (length === 127) return { code: null, reason: 'unexpected_large_frame' }
    if (buffer.length - offset < header + length) return undefined
    if (opcode === 0x8) {
      const payload = buffer.subarray(offset + header, offset + header + length)
      return { code: payload.length >= 2 ? payload.readUInt16BE(0) : null, reason: payload.subarray(2).toString('utf8') }
    }
    offset += header + length
  }
  return undefined
}

async function sample(index) {
  const timing = {}
  const meta = {}
  const started = performance.now()
  const resolved = await lookup(origin.hostname)
  timing.dns = performance.now() - started
  const socket = await new Promise((resolve, reject) => {
    const raw = tcpConnect({ host: resolved.address, port }, () => resolve(raw))
    raw.once('error', reject)
    raw.setTimeout(timeoutMs, () => raw.destroy(new Error('tcp_timeout')))
  })
  timing.tcp = performance.now() - started
  let stream = socket
  if (secure) {
    stream = await new Promise((resolve, reject) => {
      const secured = tlsConnect({ socket, servername: origin.hostname, ALPNProtocols: ['http/1.1'] }, () => resolve(secured))
      secured.once('error', reject)
    })
    timing.tls = performance.now() - started
  }
  const room = randomUUID()
  stream.write([
    `GET /?host=${room}&mode=run HTTP/1.1`, `Host: ${origin.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', 'User-Agent: scry-relay-path-probe', '', ''
  ].join('\r\n'))
  return await new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    let headers
    const finish = (extra) => {
      clearTimeout(timer)
      stream.destroy()
      resolve({ sample: index, ...meta, ms: Object.fromEntries(Object.entries({ ...timing, total: performance.now() - started }).map(([key, value]) => [key, round(value)])), ...extra })
    }
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs)
    stream.on('error', (error) => finish({ error: error.message }))
    stream.on('close', () => finish({ error: headers ? 'closed_without_close_frame' : 'closed_before_upgrade' }))
    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!headers) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        headers = buffer.subarray(0, end).toString('latin1').split('\r\n')
        buffer = buffer.subarray(end + 4)
        timing.upgrade = performance.now() - started
        const status = Number(headers[0].split(' ')[1])
        const ray = headers.find((line) => line.toLowerCase().startsWith('cf-ray:'))?.split(':')[1]?.trim()
        const wait = headers.find((line) => line.toLowerCase().startsWith('x-scry-relay-wait-ms:'))?.split(':')[1]?.trim()
        meta.colo = ray?.split('-').pop()
        if (wait !== undefined) meta.relayWaitMs = Number(wait)
        if (status !== 101) { finish({ status, error: 'not_upgraded' }); return }
      }
      const close = closeCode(buffer)
      if (close) {
        timing.close = performance.now() - started
        // The relay holds an unknown room briefly before answering offline;
        // without that hold, upgrade time is the edge + Durable Object trip.
        if (meta.relayWaitMs !== undefined) timing.upgradeExcludingWait = timing.upgrade - meta.relayWaitMs
        finish({ close, relayGeneration: close.code === 4001 ? 'heartbeat-aware' : close.code === 1013 ? 'pre-heartbeat' : 'unknown' })
      }
    })
  })
}

emit('environment', { relay: origin.origin, samples, node: process.version })
const results = []
for (let index = 1; index <= samples; index++) {
  try {
    const result = await sample(index)
    results.push(result)
    emit('sample', result)
  } catch (error) {
    emit('sample', { sample: index, error: error.message })
  }
}
const ok = results.filter((result) => result.close)
const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
emit('summary', {
  ok: ok.length,
  failed: samples - ok.length,
  colos: [...new Set(ok.map((result) => result.colo).filter(Boolean))],
  relayGenerations: [...new Set(ok.map((result) => result.relayGeneration))],
  medianMs: Object.fromEntries(['dns', 'tcp', 'tls', 'upgrade', 'upgradeExcludingWait', 'close', 'total'].map((phase) => [phase, median(ok.map((result) => result.ms[phase]).filter((value) => value !== undefined))]))
})
process.exitCode = ok.length === samples ? 0 : 1
