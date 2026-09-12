import { createHash, timingSafeEqual } from 'node:crypto'

// Authenticated rendezvous admission for the G0 relay.
//
// The relay is an untrusted byte rendezvous: it must NOT see inner mTLS keys and
// is never the security root (the inner TLS 1.3 mTLS is). This layer only decides
// *who may occupy a relay session slot* so a random attacker cannot squat a slot,
// brute a session, or be bridged to the wrong peer. It provides:
//   - ticket: single-use opaque join token, verified by SHA-256 (never stored raw)
//   - host/device binding: two distinct tokens per session, one per role
//   - replay protection: each role token is consumable exactly once
//   - expiry: monotonic + wall-clock TTL, so a stopped clock cannot extend life
//   - rate limit: a bounded global attempt budget per window blocks scanning
//   - capacity: a bounded number of concurrent pending sessions
//   - log redaction: tokens never appear in describe()/redactTicket() output
//
// A trusted party (the Mac host, over its own already-authenticated control
// channel) registers a session's token *hashes*; peers later present the raw
// tokens when joining. Registration authentication itself is out of scope here
// and MUST be provided by the caller's control channel in production.

const HASH = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ROLES = new Set(['host', 'device'])

export const DEFAULT_TTL = 120_000
export const DEFAULT_MAX_SESSIONS = 64
export const DEFAULT_RATE_WINDOW = 10_000
export const DEFAULT_MAX_ATTEMPTS = 20

export function ticketHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

// Redact a raw token for logs: only a short hash prefix, never the token bytes.
export function redactTicket(token) {
  if (typeof token !== 'string' || token.length === 0) return 'sha256:∅'
  return 'sha256:' + ticketHash(token).slice(0, 8)
}

function hashEqual(a, b) {
  if (!HASH.test(a) || !HASH.test(b)) return false
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export class AdmissionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'AdmissionError'
    this.code = code
  }
}

export class RelayAdmission {
  #sessions = new Map()
  #clock
  #monotonic
  #maxSessions
  #rateWindow
  #maxAttempts
  #attempts = []

  constructor({ clock, monotonic, maxSessions, rateWindowMs, maxAttempts } = {}) {
    this.#clock = clock ?? (() => Date.now())
    this.#monotonic = monotonic ?? (() => Number(process.hrtime.bigint() / 1_000_000n))
    this.#maxSessions = maxSessions ?? DEFAULT_MAX_SESSIONS
    this.#rateWindow = rateWindowMs ?? DEFAULT_RATE_WINDOW
    this.#maxAttempts = maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  }

  #prune() {
    const wall = this.#clock()
    const mono = this.#monotonic()
    for (const [id, session] of this.#sessions) {
      if (wall >= session.expiresWall || mono >= session.expiresMono) this.#sessions.delete(id)
    }
  }

  // Trusted control-channel call: publish the token hashes for one session.
  register({ sessionId, hostTicketSHA256, deviceTicketSHA256, ttlMs } = {}) {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new AdmissionError('invalid_session_id')
    if (!HASH.test(hostTicketSHA256 ?? '') || !HASH.test(deviceTicketSHA256 ?? '')) throw new AdmissionError('invalid_ticket_hash')
    if (hashEqual(hostTicketSHA256, deviceTicketSHA256)) throw new AdmissionError('roles_share_ticket')
    const ttl = ttlMs ?? DEFAULT_TTL
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > DEFAULT_TTL) throw new AdmissionError('invalid_ttl')
    this.#prune()
    if (this.#sessions.has(sessionId)) throw new AdmissionError('session_exists')
    if (this.#sessions.size >= this.#maxSessions) throw new AdmissionError('session_capacity_exceeded')
    this.#sessions.set(sessionId, {
      hostHash: hostTicketSHA256,
      deviceHash: deviceTicketSHA256,
      hostConsumed: false,
      deviceConsumed: false,
      expiresWall: this.#clock() + ttl,
      expiresMono: this.#monotonic() + ttl
    })
  }

  #chargeAttempt() {
    const now = this.#monotonic()
    const floor = now - this.#rateWindow
    while (this.#attempts.length > 0 && this.#attempts[0] <= floor) this.#attempts.shift()
    if (this.#attempts.length >= this.#maxAttempts) throw new AdmissionError('admission_rate_limited')
    this.#attempts.push(now)
  }

  // Peer join: present the raw token for a role; returns the bound sessionId and
  // whether both roles are now present. Throws AdmissionError on any failure.
  admit({ token, role } = {}) {
    if (!ROLES.has(role)) throw new AdmissionError('invalid_role')
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) throw new AdmissionError('invalid_ticket')
    this.#chargeAttempt()
    this.#prune()
    const presented = ticketHash(token)
    for (const [id, session] of this.#sessions) {
      const roleHash = role === 'host' ? session.hostHash : session.deviceHash
      const otherHash = role === 'host' ? session.deviceHash : session.hostHash
      if (hashEqual(presented, roleHash)) {
        if (role === 'host' ? session.hostConsumed : session.deviceConsumed) throw new AdmissionError('ticket_already_used')
        if (role === 'host') session.hostConsumed = true
        else session.deviceConsumed = true
        return { sessionId: id, bridgeReady: session.hostConsumed && session.deviceConsumed }
      }
      // A token valid for the *other* role must never admit under this role.
      if (hashEqual(presented, otherHash)) throw new AdmissionError('role_mismatch')
    }
    throw new AdmissionError('unknown_or_expired_ticket')
  }

  // Cancel a session (e.g. after both peers disconnect or on host revoke).
  release(sessionId) {
    this.#sessions.delete(sessionId)
  }

  // Log-safe summary: counts and non-secret session ids only. No token bytes.
  describe() {
    this.#prune()
    return {
      sessions: this.#sessions.size,
      admitted: [...this.#sessions.values()].filter(s => s.hostConsumed && s.deviceConsumed).length,
      ids: [...this.#sessions.keys()]
    }
  }
}
