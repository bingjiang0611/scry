import { createServer, type Server } from 'node:net'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { join } from 'node:path'

// Bootstrapping the App's own device grant. The App has no certificate yet, so it
// cannot use inner mTLS; enrollment runs over a second unix socket in the same 0700
// state directory. Trust is exactly three things, and nothing more:
//
//   1. the socket is 0600 inside a 0700 directory, so only this uid can connect;
//   2. the caller presents the enrollment secret, readable only from a 0600 file in
//      the daemon's state directory, so only this uid could have read it;
//   3. the caller signs the CSR with the private key it will later present in mTLS,
//      so the certificate it receives is bound to a key it actually holds.
//
// All three on one machine is the proof; there is no second human confirmation step.
// The secret is single-use and is not kept alive while a valid local grant exists.
export const LOCAL_ENROLLMENT_NAME = 'local-enrollment.json'
export const LOCAL_ENROLL_SOCKET_NAME = 'enroll.sock'
const MAX_SOCKET_PATH = 100
const MAX_REQUEST_BYTES = 20_480

export interface LocalEnrollmentStore {
  readonly secretPath: string
  /** Create a secret when no local grant is live, otherwise delete any stale one. */
  ensure(hasValidLocalGrant: boolean): void
  /** True exactly once per secret; deletes the file. */
  consume(secret: unknown): boolean
  present(): boolean
}

/**
 * The secret never expires by time: a daemon started at login may wait hours for the
 * App. It rotates on use, and on every daemon start while no local grant exists.
 * A missing or malformed file simply means "no enrollment is pending", which fails
 * closed for the caller; a file readable by anyone else is a hard error.
 */
export function openLocalEnrollmentStore(directory: string, options: { clock?: () => number } = {}): LocalEnrollmentStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const secretPath = join(directory, LOCAL_ENROLLMENT_NAME)
  const write = (): string => {
    const secret = randomBytes(32).toString('base64url')
    const temporary = `${secretPath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, secret, createdAt: (options.clock ?? Date.now)() }), { mode: 0o600 })
    renameSync(temporary, secretPath)
    chmodSync(secretPath, 0o600)
    return secret
  }
  const read = (): { secret: string } | null => {
    let raw: string
    try { raw = readFileSync(secretPath, 'utf8') } catch { return null }
    const mode = statSync(secretPath).mode & 0o777
    if (mode !== 0o600) throw new Error(`daemon_enrollment_secret_mode_${mode.toString(8)}`)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('daemon_enrollment_secret_corrupt') }
    const value = parsed as { version?: unknown; secret?: unknown }
    if (!value || value.version !== 1 || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) {
      throw new Error('daemon_enrollment_secret_corrupt')
    }
    return { secret: value.secret }
  }
  return {
    secretPath,
    ensure(hasValidLocalGrant) {
      if (hasValidLocalGrant) { rmSync(secretPath, { force: true }); return }
      write()
    },
    consume(secret) {
      if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return false
      let pending: { secret: string } | null
      try { pending = read() } catch { return false }
      if (!pending) return false
      const presented = Buffer.from(secret)
      const expected = Buffer.from(pending.secret)
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false
      // Consume before issuance so the same secret can never produce a second grant.
      rmSync(secretPath, { force: true })
      return true
    },
    present() {
      try { return read() !== null } catch { return false }
    }
  }
}

export interface LocalEnrollSocket {
  socketPath: string
  close(): Promise<void>
}

export interface LocalEnrollSocketOptions {
  directory: string
  /** Returns a certificate envelope, or throws a machine code already bounded. */
  enroll(request: unknown): Promise<unknown>
}

/**
 * One request per connection, one reply, then close. No framing beyond a single
 * newline-terminated JSON object: this socket exists only to bootstrap one grant.
 */
export async function openLocalEnrollSocket(options: LocalEnrollSocketOptions): Promise<LocalEnrollSocket> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  chmodSync(options.directory, 0o700)
  const socketPath = join(options.directory, LOCAL_ENROLL_SOCKET_NAME)
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new Error('daemon_socket_path_too_long')
  rmSync(socketPath, { force: true })
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let busy = false
    socket.setTimeout(10_000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', (bytes: Buffer) => {
      if (busy) { socket.destroy(); return }
      if (buffer.length + bytes.length > MAX_REQUEST_BYTES) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      if (end !== buffer.length - 1) { socket.destroy(); return }
      busy = true
      let parsed: unknown
      try { parsed = JSON.parse(buffer.subarray(0, end).toString('utf8')) } catch { parsed = undefined }
      void options.enroll(parsed)
        .then((reply) => { socket.end(`${JSON.stringify(reply)}\n`) })
        // Only the machine code leaves this socket: no paths, no stack, no CSR echo.
        .catch((error: unknown) => {
          const code = error instanceof Error && /^[a-z0-9_:]+$/.test(error.message) ? error.message : 'local_enrollment_failed'
          socket.end(`${JSON.stringify({ error: code })}\n`)
        })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
  chmodSync(socketPath, 0o600)
  const mode = statSync(socketPath).mode & 0o777
  if (mode !== 0o600) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error(`daemon_socket_mode_${mode.toString(8)}`)
  }
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(socketPath, { force: true })
    }
  }
}

export function localEnrollHandlers(store: LocalEnrollmentStore, authority: {
  enrollLocal(input: { csrPEM: string; deviceLabel: string }, consumeSecret: () => boolean): Promise<{
    certificatePEM: string
    certificateSHA256: string
    deviceId: string
    expiresAt: number
  }>
}, caCertificatePEM: string) {
  return async (request: unknown): Promise<unknown> => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid_local_enrollment_request')
    const input = request as { version?: unknown; secret?: unknown; csrPEM?: unknown; deviceLabel?: unknown }
    if (input.version !== 1 || typeof input.csrPEM !== 'string' || typeof input.deviceLabel !== 'string') {
      throw new Error('invalid_local_enrollment_request')
    }
    const grant = await authority.enrollLocal({ csrPEM: input.csrPEM, deviceLabel: input.deviceLabel },
      () => store.consume(input.secret))
    return {
      version: 1,
      certificatePEM: grant.certificatePEM,
      certificateSHA256: grant.certificateSHA256,
      caCertificatePEM,
      deviceId: grant.deviceId,
      expiresAt: grant.expiresAt
    }
  }
}
