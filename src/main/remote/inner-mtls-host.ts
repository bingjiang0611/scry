import { createServer, type TLSSocket, type Server } from 'node:tls'
import { constants, createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { HostController } from './host-controller'

// Production inner-mTLS host: the TLS 1.3 mutually-authenticated endpoint that a
// paired device reaches (through the outer WSS byte relay, which never sees
// inner keys). It is the transport in front of HostController. Every request is
// authorized by the fingerprint DERIVED FROM THE VERIFIED PEER CERTIFICATE
// (socket.getPeerCertificate().raw), never from anything in the request body -
// the same invariant proven by experiments/remote-g0/g1-smoke, now in src/main.
//
// One line-delimited JSON request/response per connection. This module does no
// authorization itself; it extracts the verified fingerprint and delegates to
// HostController, which fails closed for any non-authorized device.

export interface InnerMtlsHostOptions {
  controller: HostController
  // CA-signed serverAuth credential (HostIdentity.issueHostServer()).
  serverCertPEM: string
  serverKeyPEM: string
  // The pinned inner CA; only device certs chaining to it complete the handshake.
  caPEM: string
  // Bytes cap for a single framed request.
  maxFrameBytes?: number
}

// Remote prompts may carry a small, explicitly bounded image/text attachment.
// The relay still sees only inner-TLS ciphertext; 1.25 MiB is enough for the
// mobile attachment budget while preventing unbounded buffering.
const DEFAULT_MAX_FRAME = 1_310_720

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

export class InnerMtlsHost {
  #server: Server
  #maxFrame: number
  #connections = new Set<TLSSocket>()

  constructor(options: InnerMtlsHostOptions) {
    this.#maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_FRAME
    this.#server = createServer({
      key: options.serverKeyPEM,
      cert: options.serverCertPEM,
      ca: options.caPEM,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      secureOptions: constants.SSL_OP_NO_TICKET
    }, (socket) => this.#onConnection(socket as TLSSocket, options.controller))
    this.#server.on('tlsClientError', (err) => {
      // Rejected handshakes are not host errors. Optional diagnostics only.
      if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] tlsClientError: ${(err as Error)?.message}`)
    })
  }

  // Serve inner-mTLS over an already-established byte stream (e.g. one leg of the
  // outer WSS relay). The stream is handed to the same configured TLS server as
  // listen(), so it inherits the identical credentials, TLS 1.3 pinning,
  // requestCert/rejectUnauthorized policy and per-connection authorization.
  serve(stream: Duplex): void {
    this.#server.emit('connection', stream)
  }

  #onConnection(socket: TLSSocket, controller: HostController): void {
    // Fail closed on anything but a fresh, fully-verified TLS 1.3 session.
    if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] onConnection authorized=${socket.authorized} authErr=${socket.authorizationError} proto=${socket.getProtocol()} reused=${socket.isSessionReused()}`)
    if (!socket.authorized || socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) { socket.destroy(); return }
    const peer = socket.getPeerCertificate()
    const fingerprint = peer && peer.raw ? digest(peer.raw) : ''
    const certificateExpiresAt = Date.parse(peer.valid_to)
    if (!Number.isFinite(certificateExpiresAt)) { socket.destroy(); return }
    this.#connections.add(socket)
    socket.once('close', () => this.#connections.delete(socket))
    // This is an idle timeout, not a computation deadline. A history/archive
    // read may legitimately take longer than 30 seconds; the client can cancel
    // the TLS channel when its request is superseded. Disable the idle timer
    // while dispatching and arm it again only after a response is written.
    const armIdleTimeout = (): void => { socket.setTimeout(30_000, () => { socket.destroy() }) }
    armIdleTimeout()
    let buffer = Buffer.alloc(0)
    let busy = false
    let historyOnly = false
    socket.on('data', (bytes: Buffer) => {
      if (busy || Date.now() >= certificateExpiresAt || buffer.length + bytes.length > this.#maxFrame) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      // One outstanding request, never pipelined commands. Only this explicit
      // read lane can reuse TLS; every request still checks the device grant.
      if (end !== buffer.length - 1) { socket.destroy(); return }
      const frame = buffer.subarray(0, end)
      buffer = Buffer.alloc(0)
      let keepAlive = false
      try {
        const request = JSON.parse(frame.toString('utf8')) as { op?: string; keepAlive?: boolean }
        keepAlive = request.keepAlive === true && [
          'historyPreview', 'historyPage', 'historyVersion', 'historyTurnsPage', 'sessionsPage', 'directoriesPage',
          'projects', 'providers', 'commands'
        ].includes(request.op ?? '')
      } catch { /* dispatch reports malformed JSON */ }
      if (historyOnly && !keepAlive) { socket.end(JSON.stringify({ error: 'history_connection_read_only' }) + '\n'); return }
      historyOnly ||= keepAlive
      busy = true
      socket.setTimeout(0)
      void this.#dispatch(controller, fingerprint, frame)
        .then((res) => {
          busy = false
          const reply = JSON.stringify(res) + '\n'
          if (keepAlive) {
            socket.write(reply)
            armIdleTimeout()
          } else socket.end(reply)
        })
        .catch(() => socket.destroy())
    })
    socket.on('error', () => { /* peer reset; nothing to report */ })
  }

  async #dispatch(controller: HostController, fingerprint: string, line: Buffer): Promise<unknown> {
    let request: { op?: string; intentId?: string; detail?: string; cursor?: number; before?: number; limit?: number; snapshot?: string; runId?: string; providerId?: string; agentProfileId?: string; cwd?: string; path?: string; externalSessionId?: string; answerId?: string; response?: unknown; query?: unknown }
    try { request = JSON.parse(line.toString('utf8')) }
    catch { return { error: 'invalid_request' } }
    try {
      if (request.op === 'submit') {
        if (typeof request.intentId !== 'string') return { error: 'invalid_request' }
        return controller.submitIntent(fingerprint, { intentId: request.intentId, detail: request.detail })
      }
      if (request.op === 'poll') {
        if (!Number.isSafeInteger(request.cursor)) return { error: 'invalid_request' }
        return { poll: controller.poll(fingerprint, { cursor: request.cursor as number }) }
      }
      if (request.op === 'runState') {
        if (typeof request.runId !== 'string') return { error: 'invalid_request' }
        return { state: controller.runState(fingerprint, { runId: request.runId }) ?? null }
      }
      if (request.op === 'questions') {
        if (typeof request.runId !== 'string') return { error: 'invalid_request' }
        return { questions: controller.pendingQuestions(fingerprint, { runId: request.runId }) }
      }
      if (request.op === 'answerQuestion') {
        if (typeof request.runId !== 'string' || typeof request.answerId !== 'string' || !request.response || typeof request.response !== 'object') {
          return { error: 'invalid_request' }
        }
        return { answer: controller.answerQuestion(fingerprint, {
          runId: request.runId,
          answerId: request.answerId,
          response: request.response as Parameters<HostController['answerQuestion']>[1]['response']
        }) }
      }
      if (request.op === 'projects') {
        // Authorized by the verified peer cert inside the controller/gateway; a
        // revoked device gets device_not_authorized, never a stale list.
        return { projects: controller.listProjects(fingerprint) }
      }
      if (request.op === 'directories') {
        if (request.path !== undefined && typeof request.path !== 'string') return { error: 'invalid_request' }
        return { directories: controller.listDirectories(fingerprint, { ...(request.path !== undefined ? { path: request.path } : {}) }) }
      }
      if (request.op === 'directoriesPage') {
        if ((request.path !== undefined && typeof request.path !== 'string') ||
            (request.cursor !== undefined && !Number.isSafeInteger(request.cursor)) ||
            (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
            (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
        return { directoriesPage: controller.listDirectoriesPage(fingerprint, {
          ...(typeof request.path === 'string' ? { path: request.path } : {}),
          ...(typeof request.cursor === 'number' ? { cursor: request.cursor } : {}),
          ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
          ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
        }) }
      }
      if (request.op === 'providers') {
        // Same owner-device authorization; the run path still validates the
        // chosen providerId, so this is a display-only chooser snapshot.
        return { providers: controller.listProviders(fingerprint) }
      }
      if (request.op === 'commands') {
        if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string') return { error: 'invalid_request' }
        return { commands: await controller.listCommands(fingerprint, {
          providerId: request.providerId,
          cwd: request.cwd,
          ...(typeof request.agentProfileId === 'string' ? { agentProfileId: request.agentProfileId } : {})
        }) }
      }
      if (request.op === 'sessions') {
        // Same owner-device authorization; display-only catalog metadata.
        return { sessions: controller.listSessions(fingerprint) }
      }
      if (request.op === 'sessionsPage') {
        if ((request.cursor !== undefined && !Number.isSafeInteger(request.cursor)) ||
            (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
            (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
        return { sessionsPage: controller.listSessionsPage(fingerprint, {
          ...(typeof request.cursor === 'number' ? { cursor: request.cursor } : {}),
          ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
          ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
        }) }
      }
      if (request.op === 'workspace') {
        return { workspace: await controller.readWorkspace(fingerprint, request.query) }
      }
      if (request.op === 'historyPreview') {
        if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string' || typeof request.externalSessionId !== 'string') return { error: 'invalid_request' }
        return { historyPreview: await controller.readHistoryPreview(fingerprint, { providerId: request.providerId, cwd: request.cwd, externalSessionId: request.externalSessionId }) }
      }
      if (request.op === 'historyVersion') {
        if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string' || typeof request.externalSessionId !== 'string') return { error: 'invalid_request' }
        return { historyVersion: await controller.readHistoryVersion(fingerprint, { providerId: request.providerId, cwd: request.cwd, externalSessionId: request.externalSessionId }) }
      }
      if (request.op === 'historyTurnsPage') {
        if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string' || typeof request.externalSessionId !== 'string' ||
            (request.before !== undefined && !Number.isSafeInteger(request.before)) ||
            (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
            (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
        return { historyTurnsPage: await controller.readHistoryTurnsPage(fingerprint, {
          providerId: request.providerId, cwd: request.cwd, externalSessionId: request.externalSessionId,
          ...(typeof request.before === 'number' ? { before: request.before } : {}),
          ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
          ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
        }) }
      }
      if (request.op === 'history') {
        // Legacy bounded response retained for older clients.
        if (typeof request.providerId !== 'string' || typeof request.externalSessionId !== 'string') return { error: 'invalid_request' }
        return { history: await controller.readHistory(fingerprint, { providerId: request.providerId, cwd: typeof request.cwd === 'string' ? request.cwd : '', externalSessionId: request.externalSessionId }) }
      }
      if (request.op === 'historyPage') {
        if (typeof request.providerId !== 'string' || typeof request.externalSessionId !== 'string' ||
            (request.cursor !== undefined && !Number.isSafeInteger(request.cursor)) ||
            (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
            (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
        return { historyPage: await controller.readHistoryPage(fingerprint, {
          providerId: request.providerId,
          cwd: typeof request.cwd === 'string' ? request.cwd : '',
          externalSessionId: request.externalSessionId,
          ...(typeof request.cursor === 'number' ? { cursor: request.cursor } : {}),
          ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
          ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
        }) }
      }
      if (request.op === 'output') {
        // The assistant's real streamed output content for one run, after cursor.
        if (typeof request.runId !== 'string' || !Number.isSafeInteger(request.cursor)) return { error: 'invalid_request' }
        return { output: await controller.runOutput(fingerprint, { runId: request.runId, cursor: request.cursor as number }) }
      }
      return { error: 'unknown_op' }
    } catch (error) {
      // Authorization and ledger failures surface as truthful codes, never as
      // success. The message is bounded and non-secret.
      return { error: String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'error').slice(0, 64) }
    }
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, host, () => { this.#server.off('error', reject); resolve() })
    })
    const address = this.#server.address()
    if (!address || typeof address === 'string') throw new Error('inner_mtls_host_not_listening')
    return { port: address.port, host: address.address }
  }

  async close(): Promise<void> {
    for (const socket of this.#connections) socket.destroy()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }
}
