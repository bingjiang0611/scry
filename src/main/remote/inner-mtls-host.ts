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
// Line-delimited JSON, one outstanding request at a time. A request without
// `keepAlive: true` is a one-shot exchange and the connection ends after its
// reply. A device may opt a connection into reuse: every following request must
// also opt in, and every reply then starts with `{"keepAlive":true,` so a client
// can tell a reusable lane from an older one-shot host without guessing. Reuse
// changes no authorization: each request re-derives nothing from the body and is
// re-authorized by HostController against the verified peer fingerprint.

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
    let buffer = Buffer.alloc(0)
    let busy = false
    let kept = false
    // Diagnostics only: name why the host tore a channel down, because the device
    // sees every host-side destroy as the same relay `peer_closed`.
    const abort = (reason: string): void => {
      if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] destroy reason=${reason} buffered=${buffer.length}`)
      socket.destroy()
    }
    // This is an idle timeout, not a computation deadline. A history/archive
    // read may legitimately take longer than 30 seconds; the client can cancel
    // the TLS channel when its request is superseded. Disable the idle timer
    // while dispatching and arm it again only after a response is written.
    // One listener for the connection's lifetime; re-arming only resets the timer.
    // Passing a callback per arm would stack a listener per keep-alive request.
    socket.on('timeout', () => abort('idle_timeout'))
    const armIdleTimeout = (): void => { socket.setTimeout(30_000) }
    armIdleTimeout()
    socket.on('data', (bytes: Buffer) => {
      if (busy) { abort('data_while_busy'); return }
      if (Date.now() >= certificateExpiresAt) { abort('certificate_expired'); return }
      if (buffer.length + bytes.length > this.#maxFrame) { abort(`frame_too_large:${buffer.length + bytes.length}`); return }
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf(10)
      if (end < 0) return
      // One outstanding request, never pipelined commands; every request still
      // checks the device grant inside HostController.
      if (end !== buffer.length - 1) { abort('pipelined_request'); return }
      const frame = buffer.subarray(0, end)
      buffer = Buffer.alloc(0)
      let keepAlive = false
      try {
        keepAlive = (JSON.parse(frame.toString('utf8')) as { keepAlive?: unknown }).keepAlive === true
      } catch { /* dispatch reports malformed JSON */ }
      if (kept && !keepAlive) { socket.end(JSON.stringify({ error: 'keep_alive_required' }) + '\n'); return }
      kept ||= keepAlive
      busy = true
      socket.setTimeout(0)
      void this.#dispatch(controller, fingerprint, frame)
        .then((res) => {
          busy = false
          if (keepAlive) {
            // keepAlive must be the first key: clients check this exact prefix.
            const reply = JSON.stringify({ keepAlive: true, ...(res as object) }) + '\n'
            socket.write(reply)
            armIdleTimeout()
          } else socket.end(JSON.stringify(res) + '\n')
        })
        .catch((error) => abort(`dispatch_threw:${String((error as Error)?.message ?? error).slice(0, 200)}`))
    })
    socket.on('error', (error) => {
      // Peer reset; nothing to report to the device.
      if (process.env.SCRY_INNER_MTLS_DEBUG) console.log(`[inner-mtls] socket error: ${error.message}`)
    })
    if (process.env.SCRY_INNER_MTLS_DEBUG) {
      socket.once('close', (hadError) => console.log(`[inner-mtls] close hadError=${hadError} busy=${busy} buffered=${buffer.length}`))
    }
  }

  async #dispatch(controller: HostController, fingerprint: string, line: Buffer): Promise<unknown> {
    let request: { op?: string; deviceLabel?: unknown; intentId?: string; detail?: string; cursor?: number; outputCursor?: number; waitMs?: number; before?: number; limit?: number; snapshot?: string; runId?: string; providerId?: string; agentProfileId?: string; cwd?: string; path?: string; externalSessionId?: string; answerId?: string; response?: unknown; query?: unknown; revision?: string; history?: unknown }
    try { request = JSON.parse(line.toString('utf8')) }
    catch { return { error: 'invalid_request' } }
    try {
      if (request.deviceLabel !== undefined) await controller.authority.updateDeviceLabel(fingerprint, request.deviceLabel)
      if (request.op === 'submit') {
        if (typeof request.intentId !== 'string') return { error: 'invalid_request' }
        return controller.submitIntent(fingerprint, { intentId: request.intentId, detail: request.detail })
      }
      if (request.op === 'intentStatus') {
        if (typeof request.intentId !== 'string') return { error: 'invalid_request' }
        return { intent: controller.intentStatus(fingerprint, { intentId: request.intentId }) }
      }
      if (request.op === 'poll') {
        if (!Number.isSafeInteger(request.cursor)) return { error: 'invalid_request' }
        return { poll: controller.poll(fingerprint, { cursor: request.cursor as number }) }
      }
      if (request.op === 'watch') {
        if (typeof request.runId !== 'string' || !Number.isSafeInteger(request.cursor) || !Number.isSafeInteger(request.outputCursor) ||
            !Number.isSafeInteger(request.waitMs)) return { error: 'invalid_request' }
        return { watch: await controller.watchRun(fingerprint, {
          runId: request.runId, cursor: request.cursor as number, outputCursor: request.outputCursor as number, waitMs: request.waitMs as number
        }) }
      }
      if (request.op === 'liveRuns') {
        if (!Number.isSafeInteger(request.waitMs) || (request.revision !== undefined &&
            (typeof request.revision !== 'string' || request.revision.length > 64))) return { error: 'invalid_request' }
        const history = parseLiveRunsHistory(request.history)
        if (history === false) return { error: 'invalid_request' }
        return { liveRuns: await controller.liveRuns(fingerprint, {
          waitMs: request.waitMs as number,
          ...(request.revision !== undefined ? { revision: request.revision } : {}),
          ...(history ? { history } : {})
        }) }
      }
      if (request.op === 'stop') {
        if (typeof request.runId !== 'string') return { error: 'invalid_request' }
        return { stop: controller.stopRun(fingerprint, { runId: request.runId }) }
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
      if (request.op === 'desktop') {
        return { desktop: await controller.readDesktop(fingerprint, request.query) }
      }
      if (request.op === 'desktopWorkbench') {
        return { workbench: await controller.desktopWorkbench(fingerprint, request.query) }
      }
      if (request.op === 'desktopDirectory') {
        return { directory: controller.desktopDirectory(fingerprint, request.query) }
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

// `history` joins one opened session's version to the liveRuns long-poll.
// Returns undefined when absent and false when malformed.
function parseLiveRunsHistory(value: unknown): { query: { providerId: string; cwd: string; externalSessionId: string }; known?: string } | undefined | false {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const h = value as Record<string, unknown>
  const text = (field: unknown, max: number): field is string => typeof field === 'string' && field.length > 0 && field.length <= max
  if (!text(h.providerId, 128) || !text(h.cwd, 4096) || !text(h.externalSessionId, 256)) return false
  if (h.known !== undefined && !text(h.known, 512)) return false
  return { query: { providerId: h.providerId, cwd: h.cwd, externalSessionId: h.externalSessionId }, ...(h.known !== undefined ? { known: h.known as string } : {}) }
}
