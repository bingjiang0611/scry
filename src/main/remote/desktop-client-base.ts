import { type DesktopHostRead, type DesktopPairingResult, type DesktopRemoteCatalog, type DesktopRemoteContext, type DesktopRemoteIntent } from '../../shared/desktop-remote'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { desktopTlsRequest, generateDesktopDeviceIdentity, openDesktopSshTunnel, type DesktopDeviceIdentity, type DesktopSshTunnel } from './desktop-transport'
import { DesktopLanes, laneForRequest, replayableRequest, type DesktopLaneConnector } from './desktop-lane'
import { framedRequest, protocolFailure } from './remote-protocol'
import { newAttachmentId, normalizeDesktopAttachment } from './desktop-attachments'
import { desktopImageReference, stageDesktopImage } from './stage-desktop-image'
import { context, fail, record, text, uuid, hash, validateState, validateIdentity, validatePairingResponse, validateCertificate, publicConnection, STATE_FILE, type EncryptedState, type StoredConnection, type ActiveConnection, type RunStatusCursor, type DesktopRemoteClientTransportDeps, } from './desktop-client-validation'
import type { DesktopCapabilities } from './desktop-client-capabilities'
import { isUnknownFailure, targetBinding } from './desktop-client-intent-rules'
import type { RemoteAttentionTracker } from './remote-attention'

function desktopSshRequestError(error: unknown, tunnel: DesktopSshTunnel | undefined, failureSequence: number): unknown {
  const failure = tunnel?.failure
  if (!(error instanceof Error) || !failure || failure.sequence <= failureSequence) return error
  const code = (error as NodeJS.ErrnoException).code
  if (error.message !== 'desktop_tls_request_eof' && code !== 'ECONNRESET' && code !== 'EPIPE') return error
  return new Error(`desktop_ssh_${failure.reason}`)
}

export abstract class DesktopRemoteClientBase {
  protected abstract intentStatus(connectionIdValue: string, intentId: string): Promise<DesktopRemoteIntent>
  protected readonly directory: string
  protected readonly encrypt: (value: string) => Buffer
  protected readonly decrypt: (value: Buffer) => string
  protected readonly transport: {
    generateIdentity: () => Promise<DesktopDeviceIdentity>
    openTunnel: (options: { username: string; hostname: string; port: number; pairPort: number; runPort: number }) => Promise<DesktopSshTunnel>
    tlsRequest: (options: { path: string; caPEM: string; certPEM: string; keyPEM: string; request: unknown; signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>
  }
  // Persistent lanes for the run channel. Pairing keeps its one-shot exchange:
  // pairing happens once, before any lane exists.
  protected readonly lanes: DesktopLanes
  protected readonly active = new Map<string, ActiveConnection>()
  protected readonly attention?: RemoteAttentionTracker
  protected readonly controllers = new Set<AbortController>()
  protected readonly requests = new Set<Promise<unknown>>()
  protected readonly locks = new Map<string, Promise<void>>()
  protected readonly runWatch = new Map<string, RunStatusCursor>()
  // Last fully paged catalog per connection with the host revision and the
  // capabilities it declared. Cleared on dispose: neither may outlive the
  // connection they were read on.
  protected readonly catalogCache = new Map<string, { revision: string; catalog: DesktopRemoteCatalog; capabilities: DesktopCapabilities }>()
  protected readonly answerIds = new Map<string, string>()
  protected readonly submitting = new Set<string>()
  protected lifecycle: Promise<void> = Promise.resolve()
  protected saveSerial: Promise<void> = Promise.resolve()
  protected statePromise: Promise<EncryptedState>
  protected restoration?: Promise<void>
  protected disposed = false

  constructor(options: { directory: string; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string; attention?: RemoteAttentionTracker } & DesktopRemoteClientTransportDeps, deps: DesktopRemoteClientTransportDeps = {}) {
    if (!text(options.directory, 4096)) fail('invalid_state_directory')
    const injected = { ...options, ...deps }
    this.directory = options.directory
    this.attention = options.attention
    this.encrypt = options.encrypt
    this.decrypt = options.decrypt
    this.transport = { generateIdentity: injected.generateIdentity ?? generateDesktopDeviceIdentity, openTunnel: injected.openTunnel ?? openDesktopSshTunnel, tlsRequest: injected.tlsRequest ?? (desktopTlsRequest as NonNullable<DesktopRemoteClientTransportDeps['tlsRequest']>) }
    this.lanes = new DesktopLanes(injected.openLane as DesktopLaneConnector | undefined)
    this.statePromise = this.load()
  }
  async dispose(): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.disposed) return
      this.disposed = true
      for (const controller of this.controllers) controller.abort()
      await Promise.allSettled([this.statePromise])
      await Promise.allSettled([...this.requests])
      this.lanes.closeAll()
      await Promise.allSettled([...this.active.values()].map((active) => active.tunnel.close()))
      this.active.clear(); this.runWatch.clear(); this.answerIds.clear(); this.catalogCache.clear()
    })
  }
  close(): Promise<void> { return this.dispose() }
  async setViewedSession(connectionIdValue: string, value: DesktopRemoteContext | null): Promise<void> {
    const state = await this.state()
    this.connection(state, connectionIdValue)
    this.attention?.viewed(connectionIdValue, value === null ? null : context(value))
  }

  protected async state(): Promise<EncryptedState> { this.assertLive(); return this.statePromise }
  protected async load(): Promise<EncryptedState> {
    try {
      const raw = await fs.readFile(join(this.directory, STATE_FILE))
      const decoded = this.decrypt(Buffer.from(raw))
      if (typeof decoded !== 'string') fail('desktop_state_corrupt')
      return validateState(JSON.parse(decoded))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const identity = await this.transport.generateIdentity()
      validateIdentity(identity)
      // Listing a fresh profile is read-only. Persist this identity with the first
      // pairing, before any network proof; a failed save must not publish a host.
      return { version: 1, identity, connections: [], intents: [] }
    }
  }
  protected async save(state: EncryptedState, connections?: StoredConnection[]): Promise<void> {
    const previous = this.saveSerial.catch(() => {})
    const next = previous.then(async () => {
      // Snapshot inside the queue, and publish a connection replacement before the
      // next save starts. A late receipt refresh must not restore an old address.
      const snapshot = structuredClone(validateState(connections ? { ...state, connections } : state))
      await this.writeState(snapshot)
      if (connections) state.connections = connections
    })
    this.saveSerial = next
    await next
  }
  protected async writeState(state: EncryptedState): Promise<void> {
    const encrypted = this.encrypt(JSON.stringify(state))
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > 4 * 1024 * 1024) fail('desktop_state_encryption_failed')
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); const temp = join(this.directory, `.${STATE_FILE}.${randomUUID()}.tmp`)
    try { await fs.writeFile(temp, encrypted, { mode: 0o600 }); await fs.rename(temp, join(this.directory, STATE_FILE)) } finally { await fs.rm(temp, { force: true }) }
  }
  protected assertLive(): void { if (this.disposed) fail('desktop_client_disposed') }
  protected connection(state: EncryptedState, id: string): StoredConnection { if (!text(id, 300)) fail('invalid_connection_id'); const item = state.connections.find((value) => value.id === id); return item ?? fail('unknown_connection') }
  protected async pairRequest(state: EncryptedState, item: StoredConnection, operation: 'pair.prove' | 'pair.status'): Promise<unknown> {
    const invitation = item.pending; if (!invitation) fail('pairing_not_pending')
    const tunnel = await this.transport.openTunnel({ ...item.ssh, pairPort: this.pairPort(item), runPort: this.runPort(item) })
    try {
      const requestId = randomUUID(); const request = operation === 'pair.prove'
        ? { protocolMajor: 1, requestId, operation, pairingId: invitation.pairingId, secret: invitation.secret, csrPEM: state.identity.csrPEM, deviceLabel: item.label }
        : { protocolMajor: 1, requestId, operation, pairingId: invitation.pairingId, secret: invitation.secret }
      const response = await this.request(tunnel.pairPath, item, request, { tunnel, classifySshFailure: true })
      return validatePairingResponse(response, requestId, invitation.pairingId)
    } finally { await tunnel.close() }
  }
  protected async consumePairingResponse(state: EncryptedState, item: StoredConnection, response: unknown): Promise<DesktopPairingResult> {
    const result = response as Record<string, unknown>
    if (result.kind === 'pair.pending') {
      if (!hash(result.publicKeySHA256) || result.publicKeySHA256 !== state.identity.publicKeySHA256) fail('pairing_key_mismatch')
      return { connection: publicConnection(item, false), publicKeySHA256: result.publicKeySHA256, state: 'pending' }
    }
    if (result.kind !== 'pair.granted') {
      delete item.pending
      await this.save(state)
      fail(String(result.code ?? result.kind))
    }
    const cert = validateCertificate(result.certificatePEM, item.anchorPEM, state.identity.publicKeySHA256)
    if (!uuid(result.deviceId) || result.scope !== 'g0_echo_only' || !hash(result.certificateSHA256) || result.certificateSHA256 !== cert.certificateSHA256 || result.expiresAt !== cert.expiresAt || result.expiresAt <= Date.now()) fail('invalid_device_grant')
    item.certificatePEM = cert.certificatePEM; item.certificateExpiresAt = cert.expiresAt; delete item.pending
    await this.save(state)
    return { connection: publicConnection(item, false), publicKeySHA256: state.identity.publicKeySHA256, state: 'paired' }
  }
  protected pairPort(item: StoredConnection): number { return item.pairPort }
  protected runPort(item: StoredConnection): number { return item.runPort }
  protected async requestForConnection(id: string, request: unknown, authorizePeer?: () => void): Promise<Record<string, unknown>> {
    const state = await this.state()
    const item = this.connection(state, id)
    const active = this.active.get(id)
    if (!active?.tunnel.alive) fail('desktop_not_connected')
    return await this.laneRequest(id, active.tunnel.runPath, item, state.identity, request, { authorizePeer })
  }

  // Every run-channel request goes through a persistent lane; there is no
  // one-shot fallback on the run channel.
  // `tunnel` + `classifySshFailure`: a transport error after the SSH forwarding reported a
  // failure is named by that failure (desktop_ssh_*), not as a bare EOF/reset.
  protected async laneRequest(id: string, runPath: string, item: StoredConnection, identity: EncryptedState['identity'], request: unknown,
    options: { authorizePeer?: () => void; tunnel?: DesktopSshTunnel; classifySshFailure?: boolean } = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    // Check after all awaited state work and immediately before dispatch.
    options.authorizePeer?.()
    this.controllers.add(controller)
    const failureSequence = options.classifySshFailure ? options.tunnel?.failure?.sequence ?? 0 : 0
    // Every run-channel request declares the version it speaks. The host refuses a
    // different one, so no request is ever partially understood.
    const payload = record(request) ? framedRequest(request) : request
    const promise = this.lanes.request(laneForRequest(payload), id, {
      endpoint: { path: runPath, caPEM: item.anchorPEM, certPEM: item.certificatePEM ?? identity.bootstrapCertPEM, keyPEM: identity.keyPEM },
      request: payload,
      replayable: replayableRequest(payload),
      signal: controller.signal
    })
    this.requests.add(promise)
    try {
      const response = await promise
      // A version disagreement names the end that is behind, so the UI can say
      // which one to upgrade instead of "protocol error".
      if (record(response) && response.error === 'protocol_mismatch') fail(protocolFailure(response.hostProtocol))
      if (record(response) && typeof response.error === 'string' && response.error.length > 0 && response.error.length <= 128) fail(`desktop_remote_${response.error}`)
      return response as Record<string, unknown>
    } catch (error) {
      throw desktopSshRequestError(error, options.classifySshFailure ? options.tunnel : undefined, failureSequence)
    } finally { this.requests.delete(promise); this.controllers.delete(controller) }
  }
  protected async desktop(id: string, query: DesktopHostRead): Promise<Record<string, unknown>> {
    const response = await this.requestForConnection(id, { op: 'desktop', query })
    if (!record(response) || !record(response.desktop) || !['info', 'workspaceChoices', 'validateWorkspaceBranch', 'history', 'history_chunk', 'trace', 'trace_delta', 'image_chunk'].includes(String(response.desktop.kind))) fail('invalid_desktop_response')
    return response.desktop
  }
  async catalogRequest<T>(id: string, request: unknown, key: string): Promise<T> { const response = await this.requestForConnection(id, request); if (!record(response) || !(key in response)) fail('invalid_catalog_response'); return response[key] as T }
  // Pairing only: one-shot request on the pair channel. The run channel uses the
  // persistent lanes above; there is no one-shot fallback there.
  protected async request(path: string, item: StoredConnection, request: unknown, options: { authorizePeer?: () => void; tunnel?: DesktopSshTunnel; classifySshFailure?: boolean } = {}): Promise<unknown> {
    const controller = new AbortController()
    const identity = (await this.state()).identity
    // Check after all awaited state/lock work and immediately before dispatch.
    options.authorizePeer?.()
    this.controllers.add(controller)
    const failureSequence = options.classifySshFailure ? options.tunnel?.failure?.sequence ?? 0 : 0
    const promise = this.transport.tlsRequest({ path, caPEM: item.anchorPEM, certPEM: item.certificatePEM ?? identity.bootstrapCertPEM, keyPEM: identity.keyPEM, request, signal: controller.signal })
    this.requests.add(promise)
    try {
      const response = await promise
      if (record(response) && typeof response.error === 'string' && response.error.length > 0 && response.error.length <= 128) fail(`desktop_remote_${response.error}`)
      return response
    } catch (error) {
      throw desktopSshRequestError(error, options.classifySshFailure ? options.tunnel : undefined, failureSequence)
    } finally { this.requests.delete(promise); this.controllers.delete(controller) }
  }
  protected async disconnectActive(connectionIdValue: string): Promise<void> {
    const active = this.active.get(connectionIdValue)
    this.lanes.closeConnection(connectionIdValue)
    if (!active) return
    this.active.delete(connectionIdValue)
    await active.tunnel.close()
  }
  async serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycle.catch(() => {})
    const queued = previous.then(operation)
    this.lifecycle = queued.then(() => undefined, () => undefined)
    return queued
  }
  protected async reconcileUnknown(state: EncryptedState, connectionIdValue: string): Promise<void> {
    for (const intent of state.intents.filter((item) => item.connectionId === connectionIdValue && item.status === 'unknown')) {
      try { await this.intentStatus(connectionIdValue, intent.intentId) } catch (error) {
        if (!isUnknownFailure(error)) throw error
      }
    }
  }
  async serializeWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve(); let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }); const queued = previous.then(() => gate); this.locks.set(id, queued)
    await previous
    try { return await operation() } finally { release(); if (this.locks.get(id) === queued) this.locks.delete(id) }
  }
  protected async write(id: string, request: unknown, authorizePeer?: () => void): Promise<unknown> {
    return this.serializeWrite(id, () => this.requestForConnection(id, request, authorizePeer))
  }
  protected authorizeMobileTarget(state: EncryptedState, target: { id: string; binding: string }, authorizePeer?: () => void): void {
    authorizePeer?.()
    const current = this.connection(state, target.id)
    if (current.pending || targetBinding(current) !== target.binding) fail('execution_target_binding_changed')
  }
  protected async uploadAttachments(connectionIdValue: string, intentId: string, attachments: ReturnType<typeof normalizeDesktopAttachment>[]): Promise<unknown[]> {
    const entries: unknown[] = []
    for (const [index, attachment] of attachments.entries()) {
      const reference = desktopImageReference(attachment, { attachmentId: newAttachmentId(), intentId, index, totalCount: attachments.length })
      try {
        await stageDesktopImage((request) => this.write(connectionIdValue, request), reference, attachment)
        entries.push(reference)
      } catch (error) {
        if (error instanceof Error && error.message === 'desktop_remote_unknown_op') fail('desktop_remote_attachments_unsupported')
        if (error instanceof Error && /desktop_remote_attachment_|attachment_/.test(error.message)) throw error
        fail('attachment_transfer_failed')
      }
    }
    return entries
  }

}
