import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateDesktopDeviceIdentity } from './remote/desktop-transport'
import { DesktopLanes, type DesktopLaneName } from './remote/desktop-lane'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'

// Every run-channel frame declares the protocol it speaks; the daemon refuses one that
// does not (`protocol_mismatch`), which is how an upgraded daemon rejects an old client
// instead of guessing. `daemonInfo` is answered before the strict path so the App can
// still learn the daemon's version and show the restart prompt.
function framedRequest(request: unknown): unknown {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request
  return { protocol: REMOTE_PROTOCOL_VERSION, ...(request as Record<string, unknown>) }
}

// The App's connection to its own daemon over `<stateDir>/local.sock`.
//
// This is the same inner-mTLS host and the same lane contract the phone uses, so
// there is one protocol to reason about. What differs is admission: the App has no
// human confirmation step, it presents the daemon's one-time 0600 secret from the
// same machine and receives a grant scoped to this socket only.
//
// Credentials live in one 0600 file encrypted by the caller's key. The private key
// never leaves this file, and the certificate is only ever sent on the local socket.

const STATE_FILE = 'daemon-client.json'
const MAX_ENROLL_REPLY_BYTES = 65_536
const ENROLL_TIMEOUT_MS = 10_000

export interface DaemonClientPaths {
  socketPath: string
  enrollSocketPath: string
  secretPath: string
  statePath: string
}

export function daemonClientPaths(daemonStateDirectory: string, userDataDir: string): DaemonClientPaths {
  return {
    socketPath: join(daemonStateDirectory, 'local.sock'),
    enrollSocketPath: join(daemonStateDirectory, 'enroll.sock'),
    secretPath: join(daemonStateDirectory, 'local-enrollment.json'),
    statePath: join(userDataDir, STATE_FILE)
  }
}

export interface StoredLocalGrant {
  version: 1
  deviceId: string
  keyPEM: string
  csrPEM: string
  certificatePEM: string
  caPEM: string
  publicKeySHA256: string
}

export interface DaemonClientOptions {
  paths: DaemonClientPaths
  appVersion: string
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
  // Injected so tests can drive the same code over a fixture socket.
  connectLocal?: (options: { path: string; caPEM: string; certPEM: string; keyPEM: string }) => Promise<LocalSocket>
  connectEnroll?: (path: string) => Promise<LocalSocket>
  generateKey?: () => Promise<{ keyPEM: string; csrPEM: string; publicKeySHA256: string }>
  lanes?: DesktopLanes
}

// The minimum both sockets need: one write, one newline-terminated reply, close.
export interface LocalSocket {
  exchange(payload: string, timeoutMs: number): Promise<string>
  close(): void
}

export type DaemonClientFailure =
  | 'daemon_not_running'
  | 'daemon_enrollment_unavailable'
  | 'daemon_version_mismatch'
  | 'daemon_device_not_authorized'
  | 'daemon_local_grant_corrupt'

export class DaemonClientError extends Error {
  readonly reason: DaemonClientFailure
  constructor(reason: DaemonClientFailure) { super(reason); this.reason = reason }
}

function oneShot(path: string, options: { caPEM?: string; certPEM?: string; keyPEM?: string } = {}): Promise<LocalSocket> {
  return new Promise((resolve, reject) => {
    let socket: Socket | TLSSocket
    const useTls = options.caPEM !== undefined
    try {
      socket = useTls
        ? tlsConnect({
          path, ca: options.caPEM, cert: options.certPEM, key: options.keyPEM,
          servername: 'scry-host', minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true
        })
        : netConnect(path)
    } catch (error) { reject(error); return }
    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      socket.removeAllListeners('error')
      socket.on('error', () => {})
      resolve({
        exchange: (payload, timeoutMs) => new Promise<string>((done, failed) => {
          let buffer = ''
          const timer = setTimeout(() => { socket.destroy(); failed(new Error('daemon_exchange_timeout')) }, timeoutMs)
          const settle = (error: Error | null, line?: string): void => {
            clearTimeout(timer)
            if (error) failed(error); else done(line as string)
          }
          socket.on('data', (bytes: Buffer) => {
            buffer += bytes.toString('utf8')
            if (buffer.length > MAX_ENROLL_REPLY_BYTES) { socket.destroy(); settle(new Error('daemon_reply_too_large')); return }
            const end = buffer.indexOf('\n')
            if (end >= 0) settle(null, buffer.slice(0, end))
          })
          socket.on('close', () => settle(new Error('daemon_connection_closed')))
          socket.write(payload)
        }),
        close: () => { socket.destroy() }
      })
    })
    socket.once('error', reject)
  })
}

export class DaemonClient {
  readonly #options: DaemonClientOptions
  readonly #lanes: DesktopLanes
  #grant: StoredLocalGrant | undefined
  #version: string | undefined

  constructor(options: DaemonClientOptions) {
    this.#options = options
    this.#lanes = options.lanes ?? new DesktopLanes()
  }

  /** Whether a stored grant exists, so a probe may use it instead of enrolling. */
  get hasGrant(): boolean { return this.#load() !== undefined }

  /** The daemon version this client verified, or undefined before connect(). */
  get version(): string | undefined { return this.#version }

  /**
   * Probe, enroll if needed, then confirm the version. Returns the daemon version so
   * a caller can refuse to continue with a daemon built from other sources.
   */
  async connect(): Promise<{ version: string; enrolled: boolean }> {
    const existing = this.#load()
    if (existing) {
      let version: string | undefined
      try { version = await this.#probe(existing) } catch (error) {
        // A revoked grant is the daemon's answer, not a transient failure: drop the
        // stale credential so the next attempt reports "no grant" instead of looping
        // on a certificate the daemon already refused.
        if (error instanceof DaemonClientError && error.reason === 'daemon_device_not_authorized') this.#clear()
        throw error
      }
      if (version === undefined) {
        // The daemon is not answering on this socket (not running, restarted without
        // our grant, or rebuilt). Never re-enroll silently.
        this.#clear()
        throw new DaemonClientError('daemon_device_not_authorized')
      }
      this.#requireVersion(version)
      this.#grant = existing
      this.#version = version
      return { version, enrolled: false }
    }
    const grant = await this.#enroll()
    const version = await this.#probe(grant)
    if (version === undefined) throw new DaemonClientError('daemon_device_not_authorized')
    this.#requireVersion(version)
    this.#save(grant)
    this.#grant = grant
    this.#version = version
    return { version, enrolled: true }
  }

  /**
   * The version the daemon answers with the stored grant, or `undefined` when it is
   * not there. Unlike `connect()`, absence does not discard the grant: a daemon that
   * was killed is restarted and re-adopted with the same credential, because its
   * enrollment secret is already spent.
   */
  async daemonInfo(): Promise<string | undefined> {
    const grant = this.#load()
    if (!grant) return undefined
    return await this.#probe(grant)
  }

  /** One request on a lane, exactly like the phone's run channel. */
  request(lane: DesktopLaneName, request: unknown, options: { replayable: boolean; signal?: AbortSignal } = { replayable: false }): Promise<unknown> {
    const grant = this.#grant
    if (!grant) return Promise.reject(new DaemonClientError('daemon_not_running'))
    return this.#lanes.request(lane, grant.deviceId, {
      endpoint: { path: this.#options.paths.socketPath, caPEM: grant.caPEM, certPEM: grant.certificatePEM, keyPEM: grant.keyPEM },
      request: framedRequest(request), replayable: options.replayable, ...(options.signal ? { signal: options.signal } : {})
    })
  }

  /** Closing the App's side leaves the daemon running for devices and runs. */
  close(): void { this.#lanes.closeAll() }

  async #probe(grant: StoredLocalGrant): Promise<string | undefined> {
    let socket: LocalSocket
    try {
      socket = await (this.#options.connectLocal ?? ((options) => oneShot(options.path, options)))({
        path: this.#options.paths.socketPath, caPEM: grant.caPEM, certPEM: grant.certificatePEM, keyPEM: grant.keyPEM
      })
    } catch { return undefined }
    try {
      const line = await socket.exchange(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, op: 'daemonInfo' })}\n`, ENROLL_TIMEOUT_MS)
      const reply = JSON.parse(line) as { op?: unknown; version?: unknown; error?: unknown }
      if (reply.error === 'device_not_authorized') throw new DaemonClientError('daemon_device_not_authorized')
      if (reply.op !== 'daemonInfo' || typeof reply.version !== 'string') return undefined
      return reply.version
    } catch (error) {
      if (error instanceof DaemonClientError) throw error
      return undefined
    } finally { socket.close() }
  }

  async #enroll(): Promise<StoredLocalGrant> {
    const secret = this.#readSecret()
    const key = await (this.#options.generateKey ?? generateDesktopDeviceIdentity)()
    let socket: LocalSocket
    try {
      socket = await (this.#options.connectEnroll ?? ((path) => oneShot(path)))(this.#options.paths.enrollSocketPath)
    } catch { throw new DaemonClientError('daemon_not_running') }
    let reply: { version?: unknown; certificatePEM?: unknown; caCertificatePEM?: unknown; deviceId?: unknown; daemonVersion?: unknown; error?: unknown }
    try {
      const line = await socket.exchange(`${JSON.stringify({ version: 1, secret, csrPEM: key.csrPEM, deviceLabel: `Scry App ${this.#options.appVersion}` })}\n`, ENROLL_TIMEOUT_MS)
      reply = JSON.parse(line) as typeof reply
    } catch { throw new DaemonClientError('daemon_enrollment_unavailable') } finally { socket.close() }
    if (reply.error !== undefined) throw new DaemonClientError('daemon_enrollment_unavailable')
    if (typeof reply.daemonVersion === 'string') this.#requireVersion(reply.daemonVersion)
    if (reply.version !== 1 || typeof reply.certificatePEM !== 'string' || typeof reply.caCertificatePEM !== 'string' || typeof reply.deviceId !== 'string') {
      throw new DaemonClientError('daemon_enrollment_unavailable')
    }
    return {
      version: 1, deviceId: reply.deviceId, keyPEM: key.keyPEM, csrPEM: key.csrPEM,
      certificatePEM: reply.certificatePEM, caPEM: reply.caCertificatePEM, publicKeySHA256: key.publicKeySHA256
    }
  }

  #requireVersion(remote: string): void {
    if (remote !== this.#options.appVersion) throw new DaemonClientError('daemon_version_mismatch')
  }

  #readSecret(): string {
    let raw: string
    try { raw = readFileSync(this.#options.paths.secretPath, 'utf8') } catch {
      // No secret means no pending enrollment: the daemon is starting, has a live
      // local grant, or was revoked. All three need the user, not a retry loop.
      throw new DaemonClientError('daemon_enrollment_unavailable')
    }
    const parsed = JSON.parse(raw) as { version?: unknown; secret?: unknown }
    if (parsed.version !== 1 || typeof parsed.secret !== 'string') throw new DaemonClientError('daemon_enrollment_unavailable')
    return parsed.secret
  }

  #load(): StoredLocalGrant | undefined {
    let raw: Buffer
    try { raw = readFileSync(this.#options.paths.statePath) } catch { return undefined }
    let value: Partial<StoredLocalGrant>
    try { value = JSON.parse(this.#options.decrypt(raw)) as Partial<StoredLocalGrant> } catch {
      throw new DaemonClientError('daemon_local_grant_corrupt')
    }
    if (value.version !== 1 || typeof value.keyPEM !== 'string' ||
        typeof value.csrPEM !== 'string' || typeof value.certificatePEM !== 'string' ||
        typeof value.caPEM !== 'string' || typeof value.deviceId !== 'string') {
      throw new DaemonClientError('daemon_local_grant_corrupt')
    }
    return value as StoredLocalGrant
  }

  #save(grant: StoredLocalGrant): void {
    const path = this.#options.paths.statePath
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, this.#options.encrypt(JSON.stringify(grant)), { mode: 0o600 })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  }

  #clear(): void {
    rmSync(this.#options.paths.statePath, { force: true })
  }
}
