import test from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import { randomUUID, randomBytes } from 'node:crypto'
import WebSocket, { createWebSocketStream } from 'ws'
import { RelayAdmission, ticketHash, redactTicket, DEFAULT_TTL, DEFAULT_MAX_SESSIONS } from './relay-admission.mjs'
import { authenticatedRelay } from './authenticated-relay.mjs'
import { certificates } from './fixture.mjs'

const token = () => randomBytes(32).toString('base64url')
const rejects = (fn, code) => assert.throws(fn, error => error.code === code, code)

// A controllable clock so expiry and rate windows are deterministic.
function fakeClock(start = 1_000) {
  const state = { wall: start, mono: start }
  return {
    clock: () => state.wall,
    monotonic: () => state.mono,
    advance(ms) { state.wall += ms; state.mono += ms },
    advanceWallOnly(ms) { state.wall += ms },
    advanceMonoOnly(ms) { state.mono += ms }
  }
}

function newSession() {
  const host = token(); const device = token()
  return { sessionId: randomUUID(), host, device, hostTicketSHA256: ticketHash(host), deviceTicketSHA256: ticketHash(device) }
}

test('happy path: both roles admitted once, then bridgeReady', () => {
  const a = new RelayAdmission()
  const s = newSession()
  a.register(s)
  const h = a.admit({ token: s.host, role: 'host' })
  assert.equal(h.sessionId, s.sessionId)
  assert.equal(h.bridgeReady, false)
  const d = a.admit({ token: s.device, role: 'device' })
  assert.equal(d.sessionId, s.sessionId)
  assert.equal(d.bridgeReady, true)
})

test('replay: a consumed ticket is refused', () => {
  const a = new RelayAdmission()
  const s = newSession()
  a.register(s)
  a.admit({ token: s.device, role: 'device' })
  rejects(() => a.admit({ token: s.device, role: 'device' }), 'ticket_already_used')
})

test('role binding: a device ticket cannot be admitted as host', () => {
  const a = new RelayAdmission()
  const s = newSession()
  a.register(s)
  rejects(() => a.admit({ token: s.device, role: 'host' }), 'role_mismatch')
  rejects(() => a.admit({ token: s.host, role: 'device' }), 'role_mismatch')
})

test('unknown ticket is refused without matching any session', () => {
  const a = new RelayAdmission()
  a.register(newSession())
  rejects(() => a.admit({ token: token(), role: 'device' }), 'unknown_or_expired_ticket')
})

test('registration rejects malformed input and shared role tokens', () => {
  const a = new RelayAdmission()
  rejects(() => a.register({ sessionId: 'not-a-uuid', hostTicketSHA256: ticketHash(token()), deviceTicketSHA256: ticketHash(token()) }), 'invalid_session_id')
  rejects(() => a.register({ sessionId: randomUUID(), hostTicketSHA256: 'xyz', deviceTicketSHA256: ticketHash(token()) }), 'invalid_ticket_hash')
  const one = ticketHash(token())
  rejects(() => a.register({ sessionId: randomUUID(), hostTicketSHA256: one, deviceTicketSHA256: one }), 'roles_share_ticket')
  rejects(() => a.register({ sessionId: randomUUID(), hostTicketSHA256: ticketHash(token()), deviceTicketSHA256: ticketHash(token()), ttlMs: DEFAULT_TTL + 1 }), 'invalid_ttl')
})

test('expiry: wall-clock OR monotonic elapse invalidates the ticket', () => {
  for (const mode of ['advanceWallOnly', 'advanceMonoOnly']) {
    const c = fakeClock()
    const a = new RelayAdmission({ clock: c.clock, monotonic: c.monotonic })
    const s = newSession()
    a.register({ ...s, ttlMs: 60_000 })
    c[mode](60_001)
    rejects(() => a.admit({ token: s.host, role: 'host' }), 'unknown_or_expired_ticket')
  }
})

test('duplicate session id is refused', () => {
  const a = new RelayAdmission()
  const s = newSession()
  a.register(s)
  rejects(() => a.register(s), 'session_exists')
})

test('capacity: no more than the configured number of sessions', () => {
  const a = new RelayAdmission({ maxSessions: 2 })
  a.register(newSession())
  a.register(newSession())
  rejects(() => a.register(newSession()), 'session_capacity_exceeded')
})

test('rate limit: bounded attempts per window, then refused', () => {
  const c = fakeClock()
  const a = new RelayAdmission({ clock: c.clock, monotonic: c.monotonic, maxAttempts: 3, rateWindowMs: 10_000 })
  a.register(newSession())
  for (let i = 0; i < 3; i++) rejects(() => a.admit({ token: token(), role: 'device' }), 'unknown_or_expired_ticket')
  rejects(() => a.admit({ token: token(), role: 'device' }), 'admission_rate_limited')
  c.advance(10_001) // window slides; budget restored
  rejects(() => a.admit({ token: token(), role: 'device' }), 'unknown_or_expired_ticket')
})

test('log redaction: raw tokens never appear in redactTicket/describe', () => {
  const a = new RelayAdmission()
  const s = newSession()
  a.register(s)
  a.admit({ token: s.host, role: 'host' })
  const red = redactTicket(s.host)
  assert.match(red, /^sha256:[0-9a-f]{8}$/)
  assert.ok(!red.includes(s.host))
  const described = JSON.stringify(a.describe())
  assert.ok(!described.includes(s.host))
  assert.ok(!described.includes(s.device))
  assert.ok(described.includes(s.sessionId)) // non-secret id may appear
})

// ---- Network integration: authenticated relay bridges only ticketed peers ----

function deviceEcho(port, outerCA, innerCA, cert, key, ticket, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://localhost:${port}/join`, {
      ca: outerCA, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', perMessageDeflate: false,
      headers: { 'x-scry-role': 'device', 'x-scry-ticket': ticket }, handshakeTimeout: 5_000
    })
    const fail = e => { try { ws.terminate() } catch {} ; reject(e) }
    ws.on('unexpected-response', (_req, res) => fail(new Error('http ' + res.statusCode)))
    ws.on('error', fail)
    ws.on('open', () => {
      const stream = createWebSocketStream(ws, { highWaterMark: 524_288 })
      stream.on('error', () => {})
      const sock = tls.connect({ socket: stream, ca: innerCA, key, cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', servername: 'scry-host.test' }, () => {
        sock.write(JSON.stringify({ protocolMajor: 1, requestId: randomUUID(), operation: 'probe.echo', payload }) + '\n')
      })
      let buf = ''
      sock.on('data', d => {
        buf += d.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl >= 0) { const line = buf.slice(0, nl); sock.end(); ws.close(); resolve(JSON.parse(line)) }
      })
      sock.on('error', fail)
    })
  })
}

test('authenticated relay: ticketed device completes real mTLS echo; wrong ticket is refused; replay is refused', async () => {
  const id = await certificates()
  try {
    const [outerCA, innerCA, cert, key] = await Promise.all([
      id.read('outer-ca.pem'), id.read('inner-ca.pem'), id.read('device.pem'), id.read('device.key')
    ])
    const s = newSession()
    const relay = await authenticatedRelay(id)
    try {
      relay.admission.register(s)
      await relay.connectHost(s.host)

      // Wrong ticket: refused at admission, no bridge, no inner request.
      await assert.rejects(deviceEcho(relay.port, outerCA, innerCA, cert, key, token(), 'nope'), /http 401/)
      assert.equal(relay.stats.rejected, 1)
      assert.equal(relay.stats.requests, 0)

      // Correct device ticket: full inner TLS 1.3 mTLS echo through the relay.
      const payload = 'scry-auth-relay-' + randomUUID()
      const response = await deviceEcho(relay.port, outerCA, innerCA, cert, key, s.device, payload)
      assert.equal(response.payload, payload)
      assert.equal(relay.stats.requests, 1)
      assert.deepEqual(relay.stats.innerTLS, [{ protocol: 'TLSv1.3', resumed: false }])
      assert.equal(relay.stats.plaintextObserved, false)

      // Replay of the now-consumed device ticket is refused.
      await assert.rejects(deviceEcho(relay.port, outerCA, innerCA, cert, key, s.device, 'again'), /http 401/)
      assert.equal(relay.stats.requests, 1)

      // Logs never leak raw tickets.
      const serialized = JSON.stringify(relay.log())
      assert.ok(!serialized.includes(s.device))
      assert.ok(!serialized.includes(s.host))
    } finally { await relay.cleanup() }
  } finally { await id.cleanup() }
})
