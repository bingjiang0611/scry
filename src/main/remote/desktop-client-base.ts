import { isAgentPermissionMode } from '../../shared/runtime'
import type { DesktopHostRead, DesktopPairingResult, DesktopRemoteContext, DesktopRemoteIntent, DesktopRemoteSubmit } from '../../shared/desktop-remote'
import { createHash, randomUUID, X509Certificate as NodeCertificate } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { desktopTlsRequest, generateDesktopDeviceIdentity, openDesktopSshTunnel, type DesktopDeviceIdentity, type DesktopSshTunnel } from './desktop-transport'
import { DESKTOP_ATTACHMENT_CHUNK_BYTES, DESKTOP_ATTACHMENT_MAX_COUNT, attachmentSha256, newAttachmentId, normalizeDesktopAttachment } from './desktop-attachments'
import { context, fail, record, text, uuid, hash, digest, validateState, validateIdentity, validatePairingResponse, validateCertificate, publicConnection, STATE_FILE, type EncryptedState, type StoredConnection, type ActiveConnection, type RunStatusCursor, type DesktopRemoteClientTransportDeps } from './desktop-client-validation'

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
  protected readonly active = new Map<string, ActiveConnection>()
  protected readonly controllers = new Set<AbortController>()
  protected readonly requests = new Set<Promise<unknown>>()
  protected readonly locks = new Map<string, Promise<void>>()
  protected readonly runWatch = new Map<string, RunStatusCursor>()
  protected readonly answerIds = new Map<string, string>()
  protected readonly submitting = new Set<string>()
  protected lifecycle: Promise<void> = Promise.resolve()
  protected saveSerial: Promise<void> = Promise.resolve()
  protected statePromise: Promise<EncryptedState>
  protected restoration?: Promise<void>
  protected disposed = false

  constructor(options: { directory: string; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string } & DesktopRemoteClientTransportDeps, deps: DesktopRemoteClientTransportDeps = {}) {
    if (!text(options.directory, 4096)) fail('invalid_state_directory')
    const injected = { ...options, ...deps }
    this.directory = options.directory
    this.encrypt = options.encrypt
    this.decrypt = options.decrypt
    this.transport = { generateIdentity: injected.generateIdentity ?? generateDesktopDeviceIdentity, openTunnel: injected.openTunnel ?? openDesktopSshTunnel, tlsRequest: injected.tlsRequest ?? (desktopTlsRequest as NonNullable<DesktopRemoteClientTransportDeps['tlsRequest']>) }
    this.statePromise = this.load()
  }
  async dispose(): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.disposed) return
      this.disposed = true
      for (const controller of this.controllers) controller.abort()
      await Promise.allSettled([this.statePromise])
      await Promise.allSettled([...this.requests])
      await Promise.allSettled([...this.active.values()].map((active) => active.tunnel.close()))
      this.active.clear(); this.runWatch.clear(); this.answerIds.clear()
    })
  }
  close(): Promise<void> { return this.dispose() }

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
      const response = await this.request(tunnel.pairPath, item, request)
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
  protected async requestForConnection(id: string, request: unknown, authorizePeer?: () => void): Promise<Record<string, unknown>> { const state = await this.state(); const item = this.connection(state, id); const active = this.active.get(id); if (!active?.tunnel.alive) fail('desktop_not_connected'); return await this.request(active.tunnel.runPath, item, request, authorizePeer) as Record<string, unknown> }
  protected async desktop(id: string, query: DesktopHostRead): Promise<Record<string, unknown>> {
    const response = await this.requestForConnection(id, { op: 'desktop', query })
    if (!record(response) || !record(response.desktop) || !['info', 'history', 'history_chunk', 'trace', 'trace_delta', 'image_chunk'].includes(String(response.desktop.kind))) fail('invalid_desktop_response')
    return response.desktop
  }
  async catalogRequest<T>(id: string, request: unknown, key: string): Promise<T> { const response = await this.requestForConnection(id, request); if (!record(response) || !(key in response)) fail('invalid_catalog_response'); return response[key] as T }
  protected async request(path: string, item: StoredConnection, request: unknown, authorizePeer?: () => void): Promise<unknown> {
    const controller = new AbortController()
    const identity = (await this.state()).identity
    // Check after all awaited state/lock work and immediately before dispatch.
    authorizePeer?.()
    this.controllers.add(controller)
    const promise = this.transport.tlsRequest({ path, caPEM: item.anchorPEM, certPEM: item.certificatePEM ?? identity.bootstrapCertPEM, keyPEM: identity.keyPEM, request, signal: controller.signal })
    this.requests.add(promise)
    try {
      const response = await promise
      if (record(response) && typeof response.error === 'string' && response.error.length > 0 && response.error.length <= 128) fail(`desktop_remote_${response.error}`)
      return response
    } finally { this.requests.delete(promise); this.controllers.delete(controller) }
  }
  protected async disconnectActive(connectionIdValue: string): Promise<void> {
    const active = this.active.get(connectionIdValue)
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
        if (!this.isUnknown(error)) throw error
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
    if (current.pending || this.targetBinding(current) !== target.binding) fail('execution_target_binding_changed')
  }
  protected isUnknown(error: unknown): boolean {
    if (!(error instanceof Error)) return true
    return !/^(?:invalid_|desktop_protocol|desktop_capability|desktop_remote_|stop_not_confirmed|answer_not_confirmed|device_not_authorized|pairing_|device_certificate|unknown_|desktop_not_connected|desktop_client)/i.test(error.message)
  }
  protected isPreDispatchRejection(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /^(?:desktop_remote_(?:device_not_authorized|invalid_request|invalid_intent_id|intent_payload_conflict|unknown_op|ledger_capacity_exceeded|attachments_unsupported)|attachment_transfer_failed|attachments_too_large|attachment_invalid|attachment_path_forbidden|desktop_not_connected|desktop_client_disposed|device_not_authorized|execution_target_binding_changed|unknown_connection)$/i.test(error.message)
  }
  protected isExplicitUnknownIntent(error: unknown): boolean { return error instanceof Error && /desktop_remote_unknown_intent$/i.test(error.message) }
  protected async uploadAttachments(connectionIdValue: string, intentId: string, attachments: ReturnType<typeof normalizeDesktopAttachment>[]): Promise<unknown[]> {
    const entries: unknown[] = []
    for (const [index, attachment] of attachments.entries()) {
      const attachmentId = newAttachmentId()
      const metadata = { attachmentId, intentId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size ?? 0, sha256: attachmentSha256(attachment), index, totalCount: attachments.length }
      try {
        const started = await this.write(connectionIdValue, { op: 'attachmentStart', ...metadata })
        if (!record(started) || started.status !== 'ready') fail('attachment_transfer_failed')
        const bytes = Buffer.from(attachment.dataBase64, 'base64')
        for (let offset = 0; offset < bytes.length; offset += DESKTOP_ATTACHMENT_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + DESKTOP_ATTACHMENT_CHUNK_BYTES))
          const uploaded = await this.write(connectionIdValue, { op: 'attachmentChunk', attachmentId, offset, dataBase64: chunk.toString('base64') })
          if (!record(uploaded) || uploaded.offset !== offset + chunk.length) fail('attachment_transfer_failed')
        }
        const response = await this.write(connectionIdValue, { op: 'attachmentCommit', attachmentId })
        if (!record(response) || !record(response.attachment) || Object.entries(metadata).some(([key, value]) => (response.attachment as Record<string, unknown>)[key] !== value)) fail('attachment_transfer_failed')
        entries.push({ kind: 'image', dataBase64: '', ...metadata })
      } catch (error) {
        if (error instanceof Error && error.message === 'desktop_remote_unknown_op') fail('desktop_remote_attachments_unsupported')
        if (error instanceof Error && /desktop_remote_attachment_|attachment_/.test(error.message)) throw error
        fail('attachment_transfer_failed')
      }
    }
    return entries
  }
  protected assertSubmit(input: DesktopRemoteSubmit): void {
    if (!record(input) || typeof input.prompt !== 'string' || input.prompt.length > 128_000 || input.prompt.includes('\0')) fail('invalid_submit')
    if (input.prompt.length === 0 && (!Array.isArray(input.attachments) || input.attachments.length === 0)) fail('invalid_submit')
    context(input.context)
    for (const key of ['modelId', 'modelProviderId', 'effort'] as const) if (input[key] !== undefined && !text(input[key], 256)) fail('invalid_submit')
    if (input.permissionMode !== undefined && !isAgentPermissionMode(input.permissionMode)) fail('invalid_submit')
    if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > DESKTOP_ATTACHMENT_MAX_COUNT)) fail('invalid_submit')
  }
  protected targetBinding(item: StoredConnection): string {
    if (!item.certificatePEM) return createHash('sha256').update(`${item.hostId}\0${item.anchorSHA256}\0missing`).digest('hex')
    let certificate: NodeCertificate
    try { certificate = new NodeCertificate(item.certificatePEM) } catch { fail('execution_target_binding_changed') }
    return createHash('sha256').update(`${item.hostId}\0${item.anchorSHA256}\0${digest(certificate.raw)}`).digest('hex')
  }
  protected contextFromDetail(detail: string): DesktopRemoteContext {
    if (detail.length > 1_310_720) fail('invalid_submit')
    let value: unknown
    try { value = JSON.parse(detail) } catch { fail('invalid_submit') }
    if (!record(value) || !text(value.cwd, 16_384) || !text(value.providerId, 256)) fail('invalid_submit')
    return { cwd: value.cwd, providerId: value.providerId,
      ...(text(value.agentProfileId, 256) ? { agentProfileId: value.agentProfileId } : {}),
      ...(text(value.resume, 256) ? { externalSessionId: value.resume } : {}) }
  }
}
