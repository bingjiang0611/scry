import type { DesktopWorkbenchRequest, DesktopWorkbenchResult } from '../../shared/desktop-workbench'
import { parseDesktopWorkbenchQuery } from './desktop-workbench'
import { validateDesktopWorkbenchResponse } from './desktop-workbench-response'
import { createHash, randomUUID, X509Certificate as NodeCertificate } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'
import { attachmentSha256, DESKTOP_ATTACHMENT_CHUNK_BYTES, DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, newAttachmentId, normalizeDesktopAttachment, type DesktopAttachmentCapability } from './desktop-attachments'
import type {
  DesktopDirectoryPage, DesktopHostInvitation, DesktopHostRead, DesktopPairingResult, DesktopRemoteAPI,
  DesktopRemoteCatalog, DesktopRemoteConnection, DesktopRemoteContext, DesktopRemoteHistory, DesktopRemoteIntent,
  DesktopRemoteRunStatus, DesktopRemoteSubmit, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, DesktopSshTarget, RemoteCommandCatalog, RemoteProviderRef, RemoteProjectRef, RemoteSessionRef
} from '../../shared/desktop-remote'
import { isAgentPermissionMode, isSupportedImageMimeType, type AgentInputAttachment, type AgentQuestionResponse } from '../../shared/runtime'
import type { DeleteSessionResult } from '../../shared/provider'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { LoadedSessionTurn } from '../../shared/session-history'
import type { WorkspaceFilePage, WorkspaceListResult } from '../../shared/workspace'
import {
  desktopTlsRequest, generateDesktopDeviceIdentity, openDesktopSshTunnel,
  type DesktopDeviceIdentity, type DesktopSshTunnel
} from './desktop-transport'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAC_RUN_ID = /^(?:remote-)?run-[0-9a-z]{1,24}-[0-9a-z]{1,12}$/
const HASH = /^[a-f0-9]{64}$/
const B64URL = /^[A-Za-z0-9_-]+$/
const MAX_RECEIPTS = 256
const MAX_PAGES = 100
const MAX_ITEMS = 10_000
const STATE_FILE = 'desktop-client.state'

export interface DesktopRemoteClientTransportDeps {
  generateIdentity?: () => Promise<DesktopDeviceIdentity>
  openTunnel?: (options: { username: string; hostname: string; port: number; pairPort: number; runPort: number }) => Promise<DesktopSshTunnel>
  tlsRequest?: (options: {
    path: string
    caPEM: string
    certPEM: string
    keyPEM: string
    request: unknown
    signal?: AbortSignal
    timeoutMs?: number
  }) => Promise<unknown>
}

interface EncryptedState {
  version: 1
  identity: DesktopDeviceIdentity
  connections: StoredConnection[]
  intents: DesktopRemoteIntent[]
}
interface StoredConnection {
  id: string
  label: string
  hostId: string
  anchorPEM: string
  anchorSHA256: string
  ssh: DesktopSshTarget
  pairPort: number
  runPort: number
  certificatePEM?: string
  certificateExpiresAt?: number
  // Existing paired hosts opt in; an explicit disconnect persists an opt-out.
  autoConnect?: boolean
  pending?: { pairingId: string; secret: string; expiresAt: number; publicKeySHA256: string }
}
interface ActiveConnection { tunnel: DesktopSshTunnel; serial: Promise<void>; attachments?: DesktopAttachmentCapability }
interface RunStatusCursor { cursor: number; scryRunId?: string; externalSessionId?: string }

function fail(code: string): never { throw new Error(code) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') }
function pathText(value: unknown, max = 16_384): value is string { return typeof value === 'string' && value.length <= max && !value.includes('\0') }
function port(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535 }
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
function validRunId(value: unknown): value is string { return typeof value === 'string' && (UUID.test(value) || MAC_RUN_ID.test(value)) }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value) }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function canonicalJson(value: unknown): string { const encoded = JSON.stringify(value); if (!encoded || Buffer.byteLength(encoded) > 1_310_720) fail('desktop_request_too_large'); return encoded }

function validateSsh(value: unknown): DesktopSshTarget {
  if (!record(value) || !text(value.hostname, 253) || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(value.hostname) ||
      !text(value.username, 253) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.username) || !port(value.port)) fail('invalid_ssh')
  return { hostname: value.hostname, username: value.username, port: value.port }
}

function validatePem(value: unknown, label: string): NodeCertificate {
  if (!text(value, 32_768) || !value.includes(`-----BEGIN ${label}-----`) || !value.includes(`-----END ${label}-----`)) fail('invalid_certificate')
  try { return new NodeCertificate(value) } catch { fail('invalid_certificate') }
}

function parseInvitation(input: string): DesktopHostInvitation & { anchorSHA256: string } {
  if (typeof input !== 'string' || !input.startsWith('scry-desktop1:')) fail('invalid_invitation')
  const encoded = input.slice('scry-desktop1:'.length)
  if (!encoded || encoded.length > 65_536 || !B64URL.test(encoded)) fail('invalid_invitation')
  let value: unknown
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { fail('invalid_invitation') }
  if (!record(value) || value.version !== 1 || !uuid(value.hostId) || !uuid(value.pairingId) ||
      !port(value.pairPort) || !port(value.runPort) || !text(value.secret, 512) || !B64URL.test(value.secret) ||
      !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now() || (value.expiresAt as number) > Date.now() + 7 * 86_400_000) fail('invalid_invitation')
  const invitation = value as Record<string, unknown>
  const anchor = validatePem(invitation.anchorPEM, 'CERTIFICATE')
  if (!anchor.ca || !anchor.verify(anchor.publicKey) || !hash(digest(anchor.raw))) fail('invalid_anchor')
  return { version: 1, hostId: invitation.hostId as string, anchorPEM: invitation.anchorPEM as string, pairPort: invitation.pairPort as number, runPort: invitation.runPort as number,
    pairingId: invitation.pairingId as string, secret: invitation.secret as string, expiresAt: invitation.expiresAt as number, anchorSHA256: digest(anchor.raw) }
}

function connectionId(hostId: string, anchorSHA256: string): string { return `${hostId}:${anchorSHA256}` }

function validateIdentity(value: unknown): DesktopDeviceIdentity {
  if (!record(value) || !text(value.keyPEM, 32_768) || !text(value.csrPEM, 32_768) || !text(value.bootstrapCertPEM, 32_768) || !hash(value.publicKeySHA256)) fail('invalid_device_identity')
  const identity = value as Record<string, unknown>
  return { keyPEM: identity.keyPEM as string, csrPEM: identity.csrPEM as string, bootstrapCertPEM: identity.bootstrapCertPEM as string, publicKeySHA256: identity.publicKeySHA256 as string }
}

function validateState(value: unknown): EncryptedState {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > MAX_ITEMS ||
      !Array.isArray(value.intents) || value.intents.length > MAX_RECEIPTS) fail('desktop_state_corrupt')
  const identity = validateIdentity(value.identity)
  const connections = value.connections.map((item): StoredConnection => {
    if (!record(item) || !text(item.id, 300) || !text(item.label, 200) || !uuid(item.hostId) || !text(item.anchorPEM, 32_768) || !hash(item.anchorSHA256) || !port(item.pairPort) || !port(item.runPort)) fail('desktop_state_corrupt')
    const anchor = validatePem(item.anchorPEM, 'CERTIFICATE')
    if (digest(anchor.raw) !== item.anchorSHA256 || !record(item.ssh)) fail('desktop_state_corrupt')
    const ssh = validateSsh(item.ssh)
    if (item.certificatePEM !== undefined) validatePem(item.certificatePEM, 'CERTIFICATE')
    if (item.certificateExpiresAt !== undefined && (!Number.isSafeInteger(item.certificateExpiresAt) || (item.certificateExpiresAt as number) <= 0)) fail('desktop_state_corrupt')
    if (item.autoConnect !== undefined && typeof item.autoConnect !== 'boolean') fail('desktop_state_corrupt')
    if (item.pending !== undefined) {
      const p = item.pending
      if (!record(p) || !uuid(p.pairingId) || !text(p.secret, 512) || !Number.isSafeInteger(p.expiresAt) || !hash(p.publicKeySHA256)) fail('desktop_state_corrupt')
    }
    return { id: item.id as string, label: item.label as string, hostId: item.hostId as string, anchorPEM: item.anchorPEM as string, anchorSHA256: item.anchorSHA256 as string,
      ...(item.autoConnect !== undefined ? { autoConnect: item.autoConnect as boolean } : {}),
      ssh, pairPort: item.pairPort as number, runPort: item.runPort as number, ...(item.certificatePEM ? { certificatePEM: item.certificatePEM as string } : {}), ...(item.certificateExpiresAt ? { certificateExpiresAt: item.certificateExpiresAt as number } : {}), ...(item.pending ? { pending: item.pending as StoredConnection['pending'] } : {}) }
  })
  const intents = value.intents.map((item): DesktopRemoteIntent => {
    if (!record(item) || !uuid(item.intentId) || !text(item.connectionId, 300) || !record(item.context) ||
        !text(item.context.cwd, 16_384) || !text(item.context.providerId, 256) || !Number.isSafeInteger(item.createdAt) ||
        (item.status !== 'recorded' && item.status !== 'unknown') || (item.runId !== undefined && !uuid(item.runId))) fail('desktop_state_corrupt')
    if (item.origin !== undefined) {
      if (!record(item.origin) || !HASH.test(String(item.origin.phonePeerFingerprint)) || !uuid(item.origin.phoneIntentId) ||
          !HASH.test(String(item.origin.targetBinding)) || !HASH.test(String(item.origin.payloadHash))) fail('desktop_state_corrupt')
    }
    return structuredClone(item) as unknown as DesktopRemoteIntent
  })
  return { version: 1, identity, connections, intents }
}

function publicConnection(item: StoredConnection, active: boolean): DesktopRemoteConnection {
  const state = active ? 'connected' : item.pending ? 'pairing' : 'disconnected'
  return { id: item.id, label: item.label, hostId: item.hostId, anchorSHA256: item.anchorSHA256, ssh: { ...item.ssh }, state,
    expiresAt: item.pending?.expiresAt ?? item.certificateExpiresAt ?? 0 }
}

function validatePairingResponse(response: unknown, requestId: string, pairingId: string): Record<string, unknown> {
  if (!record(response) || response.protocolMajor !== 1 || response.requestId !== requestId ||
      !['pair.pending', 'pair.granted', 'pair.revoked', 'pair.denied'].includes(String(response.kind))) fail('desktop_protocol_mismatch')
  if (response.kind !== 'pair.denied' && response.pairingId !== pairingId) fail('desktop_protocol_mismatch')
  if (response.kind === 'pair.denied' && !text(response.code, 128)) fail('desktop_protocol_mismatch')
  return response
}

function validateDeleteSessionResult(value: unknown): DeleteSessionResult {
  if (!record(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.deleted) || !Array.isArray(value.retained) || !Array.isArray(value.failed) ||
      value.deleted.some((item) => typeof item !== 'string') || value.retained.some((item) => typeof item !== 'string') ||
      value.failed.some((item) => !record(item) || !text(item.store, 256) || !text(item.error, 16_384)) ||
      (value.cancelled !== undefined && typeof value.cancelled !== 'boolean') || (value.reason !== undefined && !['invalid_request', 'active_session', 'user_cancelled', 'partial_failure'].includes(String(value.reason)))) fail('invalid_session_delete_response')
  return value as unknown as DeleteSessionResult
}

function validateInfo(response: unknown, hostId: string): { directorySelection?: true; workbench?: 1; sessionActions?: true; sessionFork?: true; sessionDelete?: true; attachments?: DesktopAttachmentCapability } {
  if (!record(response) || !record(response.desktop) || response.desktop.kind !== 'info' || response.desktop.protocol !== 1 ||
      response.desktop.hostId !== hostId || response.desktop.execution !== 'canonical' ||
      (response.desktop.directorySelection !== undefined && response.desktop.directorySelection !== true) ||
      (response.desktop.workbench !== undefined && response.desktop.workbench !== 1) ||
      (response.desktop.sessionActions !== undefined && response.desktop.sessionActions !== true) ||
      (response.desktop.sessionFork !== undefined && response.desktop.sessionFork !== true) ||
      (response.desktop.sessionDelete !== undefined && response.desktop.sessionDelete !== true)) fail('desktop_capability_unavailable')
  const attachmentInfo = response.desktop.attachments
  if (attachmentInfo !== undefined && (!record(attachmentInfo) || attachmentInfo.transport !== 'chunked' || attachmentInfo.maxBytes !== DESKTOP_ATTACHMENT_MAX_BYTES || attachmentInfo.maxTotalBytes !== DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES || attachmentInfo.maxCount !== DESKTOP_ATTACHMENT_MAX_COUNT || attachmentInfo.chunkBytes !== DESKTOP_ATTACHMENT_CHUNK_BYTES)) fail('desktop_capability_unavailable')
  return {
    ...(response.desktop.directorySelection === true ? { directorySelection: true as const } : {}),
    ...(response.desktop.workbench === 1 ? { workbench: 1 as const } : {}),
    ...(response.desktop.sessionActions === true ? { sessionActions: true as const } : {}),
    ...(response.desktop.sessionFork === true ? { sessionFork: true as const } : {}),
    ...(response.desktop.sessionDelete === true ? { sessionDelete: true as const } : {}),
    ...(attachmentInfo ? { attachments: attachmentInfo as unknown as DesktopAttachmentCapability } : {})
  }
}

function context(value: unknown): DesktopRemoteContext {
  if (!record(value) || !text(value.cwd, 16_384) || !text(value.providerId, 256) ||
      (value.agentProfileId !== undefined && !text(value.agentProfileId, 256)) ||
      (value.externalSessionId !== undefined && !text(value.externalSessionId, 256))) fail('invalid_context')
  return { cwd: value.cwd, providerId: value.providerId, ...(value.agentProfileId ? { agentProfileId: value.agentProfileId } : {}), ...(value.externalSessionId ? { externalSessionId: value.externalSessionId } : {}) }
}

function validateCertificate(certificatePEM: unknown, anchorPEM: string, publicKeySHA256: string): { certificatePEM: string; certificateSHA256: string; expiresAt: number } {
  const cert = validatePem(certificatePEM, 'CERTIFICATE')
  const anchor = validatePem(anchorPEM, 'CERTIFICATE')
  const now = Date.now()
  let valid = false
  try { valid = cert.verify(anchor.publicKey) && cert.checkIssued(anchor) } catch { valid = false }
  if (!valid || cert.ca || !text(cert.serialNumber, 256) || Date.parse(cert.validFrom) > now + 60_000 || Date.parse(cert.validTo) <= now) fail('invalid_device_certificate')
  const keyHash = digest(cert.publicKey.export({ type: 'spki', format: 'der' }))
  if (keyHash !== publicKeySHA256) fail('device_certificate_key_mismatch')
  const usages = cert.keyUsage ?? []
  if (!usages.some((value) => /client authentication|1\.3\.6\.1\.5\.5\.7\.3\.2/i.test(value))) fail('invalid_device_certificate_eku')
  return { certificatePEM: certificatePEM as string, certificateSHA256: digest(cert.raw), expiresAt: Date.parse(cert.validTo) }
}

export class DesktopRemoteClient implements DesktopRemoteAPI {
  readonly #directory: string
  readonly #encrypt: (value: string) => Buffer
  readonly #decrypt: (value: Buffer) => string
  readonly #transport: {
    generateIdentity: () => Promise<DesktopDeviceIdentity>
    openTunnel: (options: { username: string; hostname: string; port: number; pairPort: number; runPort: number }) => Promise<DesktopSshTunnel>
    tlsRequest: (options: { path: string; caPEM: string; certPEM: string; keyPEM: string; request: unknown; signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>
  }
  readonly #active = new Map<string, ActiveConnection>()
  readonly #controllers = new Set<AbortController>()
  readonly #requests = new Set<Promise<unknown>>()
  readonly #locks = new Map<string, Promise<void>>()
  readonly #runWatch = new Map<string, RunStatusCursor>()
  readonly #answerIds = new Map<string, string>()
  readonly #submitting = new Set<string>()
  #lifecycle: Promise<void> = Promise.resolve()
  #saveSerial: Promise<void> = Promise.resolve()
  #statePromise: Promise<EncryptedState>
  #restoration?: Promise<void>
  #disposed = false

  constructor(options: { directory: string; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string } & DesktopRemoteClientTransportDeps, deps: DesktopRemoteClientTransportDeps = {}) {
    if (!text(options.directory, 4096)) fail('invalid_state_directory')
    const injected = { ...options, ...deps }
    this.#directory = options.directory
    this.#encrypt = options.encrypt
    this.#decrypt = options.decrypt
    this.#transport = { generateIdentity: injected.generateIdentity ?? generateDesktopDeviceIdentity, openTunnel: injected.openTunnel ?? openDesktopSshTunnel, tlsRequest: injected.tlsRequest ?? (desktopTlsRequest as NonNullable<DesktopRemoteClientTransportDeps['tlsRequest']>) }
    this.#statePromise = this.#load()
  }

  async list(): Promise<DesktopRemoteConnection[]> { const state = await this.#state(); return state.connections.map((item) => publicConnection(item, this.#active.get(item.id)?.tunnel.alive === true)) }

  async pair(input: { label: string; ssh: DesktopSshTarget; invitation: string }): Promise<DesktopPairingResult> {
    this.#assertLive()
    if (!text(input?.label, 200) || /[\u0000-\u001f]/.test(input.label)) fail('invalid_label')
    const ssh = validateSsh(input.ssh)
    const invitation = parseInvitation(input.invitation)
    const state = await this.#state()
    const identity = state.identity
    const id = connectionId(invitation.hostId, invitation.anchorSHA256)
    // A changed CA is an identity change, not a replacement. Require explicit forget first.
    const replaced = state.connections.find((existing) => existing.hostId === invitation.hostId)
    if (replaced && replaced.anchorSHA256 !== invitation.anchorSHA256) fail('host_anchor_changed_forget_required')
    const item: StoredConnection = replaced
      ? { ...replaced, label: input.label, ssh, pairPort: invitation.pairPort, runPort: invitation.runPort,
          pending: { pairingId: invitation.pairingId, secret: invitation.secret, expiresAt: invitation.expiresAt, publicKeySHA256: identity.publicKeySHA256 } }
      : { id, label: input.label, hostId: invitation.hostId, anchorPEM: invitation.anchorPEM, anchorSHA256: invitation.anchorSHA256, ssh,
          pairPort: invitation.pairPort, runPort: invitation.runPort, pending: { pairingId: invitation.pairingId, secret: invitation.secret, expiresAt: invitation.expiresAt, publicKeySHA256: identity.publicKeySHA256 } }
    const connections = [...state.connections.filter((existing) => existing.id !== id), item]
    await this.#save(state, connections)
    const response = await this.#pairRequest(state, item, 'pair.prove')
    return await this.#consumePairingResponse(state, item, response)
  }

  async finishPairing(connectionIdValue: string): Promise<DesktopPairingResult> {
    const state = await this.#state(); const item = this.#connection(state, connectionIdValue)
    if (!item.pending) fail('pairing_not_pending')
    // The persisted lease is only a UI hint after restart. The host remains the
    // authority and may return a durable grant after the invitation's expiry.
    const response = await this.#pairRequest(state, item, 'pair.status')
    return await this.#consumePairingResponse(state, item, response)
  }

  async updateSsh(connectionIdValue: string, value: DesktopSshTarget): Promise<void> {
    return this.#serializeLifecycle(async () => {
      const ssh = validateSsh(value)
      const state = await this.#state()
      const item = this.#connection(state, connectionIdValue)
      // An address is routing information, not a new host identity. Keep the pinned
      // CA, device certificate and receipts; reconnect remains an explicit action.
      await this.#disconnectActive(connectionIdValue)
      const connections = state.connections.map((connection) => connection.id === item.id ? { ...connection, ssh } : connection)
      await this.#save(state, connections)
    })
  }

  restoreConnections(): Promise<void> {
    return this.#restoration ??= this.#restoreConnections()
  }

  async #restoreConnections(): Promise<void> {
    const state = await this.#state()
    // One attempt per saved host per launch, not a reconnect loop. Queue hosts
    // individually so a manual disconnect/forget/quit can run between attempts.
    for (const id of state.connections.map((item) => item.id)) {
      await this.#serializeLifecycle(async () => {
        if (this.#disposed) return
        const item = state.connections.find((connection) => connection.id === id)
        if (!item || item.autoConnect === false || item.pending || !item.certificatePEM ||
            !item.certificateExpiresAt || item.certificateExpiresAt <= Date.now() || this.#active.get(id)?.tunnel.alive) return
        try { await this.#connect(state, item) }
        catch (error) { console.warn('[scry] desktop connection restore failed:', id, error) }
      })
      if (this.#disposed) break
    }
  }

  async connect(connectionIdValue: string): Promise<void> {
    return this.#serializeLifecycle(async () => {
      const state = await this.#state()
      await this.#connect(state, this.#connection(state, connectionIdValue))
    })
  }

  async #connect(state: EncryptedState, item: StoredConnection): Promise<void> {
    if (item.pending) fail('pairing_in_progress')
    if (!item.certificatePEM || !item.certificateExpiresAt || item.certificateExpiresAt <= Date.now()) fail('device_certificate_expired')
    await this.#disconnectActive(item.id)
    const tunnel = await this.#transport.openTunnel({ ...item.ssh, pairPort: item.pairPort, runPort: item.runPort })
    try {
      const response = await this.#request(tunnel.runPath, item, { op: 'desktop', query: { kind: 'info' } })
      const capabilities = validateInfo(response, item.hostId)
      if (this.#disposed) fail('desktop_client_disposed')
      await this.#save(state, state.connections.map((connection) => connection.id === item.id ? { ...connection, autoConnect: true } : connection))
      this.#active.set(item.id, { tunnel, serial: Promise.resolve(), ...(capabilities.attachments ? { attachments: capabilities.attachments } : {}) })
      await this.#reconcileUnknown(state, item.id)
    } catch (error) { await tunnel.close(); throw error }
  }

  async disconnect(connectionIdValue: string): Promise<void> {
    return this.#serializeLifecycle(async () => {
      const state = await this.#state()
      const item = this.#connection(state, connectionIdValue)
      await this.#save(state, state.connections.map((connection) => connection.id === item.id ? { ...connection, autoConnect: false } : connection))
      await this.#disconnectActive(item.id)
    })
  }

  async forget(connectionIdValue: string): Promise<void> {
    return this.#serializeLifecycle(async () => {
      const state = await this.#state(); this.#connection(state, connectionIdValue)
      if (state.intents.some((item) => item.connectionId === connectionIdValue && item.status === 'unknown')) fail('unknown_receipts_pending')
      await this.#disconnectActive(connectionIdValue)
      state.connections = state.connections.filter((item) => item.id !== connectionIdValue)
      state.intents = state.intents.filter((item) => item.connectionId !== connectionIdValue)
      for (const key of [...this.#runWatch.keys()]) if (key.startsWith(`${connectionIdValue}:`)) this.#runWatch.delete(key)
      for (const key of [...this.#answerIds.keys()]) if (key.startsWith(`${connectionIdValue}:`)) this.#answerIds.delete(key)
      await this.#save(state)
    })
  }

  async catalog(connectionIdValue: string): Promise<DesktopRemoteCatalog> {
    const rawProjects = await this.#catalogRequest<unknown>(connectionIdValue, { op: 'projects' }, 'projects')
    const rawProviders = await this.#catalogRequest<unknown>(connectionIdValue, { op: 'providers' }, 'providers')
    if (!Array.isArray(rawProjects) || !Array.isArray(rawProviders) || rawProjects.length > MAX_ITEMS || rawProviders.length > MAX_ITEMS) fail('catalog_too_large')
    const sessions: RemoteSessionRef[] = []; let cursor = 0; let snapshot: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.#catalogRequest<Record<string, unknown>>(connectionIdValue, { op: 'sessionsPage', includeArchived: true, cursor, limit: 100, ...(snapshot ? { snapshot } : {}) }, 'sessionsPage')
      if (!Array.isArray(response.sessions) || !Number.isSafeInteger(response.cursor) || !Number.isSafeInteger(response.total) || typeof response.hasMore !== 'boolean' || !text(response.snapshot, 256)) fail('invalid_catalog_response')
      if (snapshot !== undefined && response.snapshot !== snapshot) fail('catalog_snapshot_changed')
      if (response.sessions.length > 100 || sessions.length + response.sessions.length > MAX_ITEMS) fail('catalog_too_large')
      sessions.push(...response.sessions.map((item) => this.#session(item)))
      if (!response.hasMore) break
      if ((response.cursor as number) <= cursor) fail('invalid_catalog_cursor')
      cursor = response.cursor as number; snapshot = response.snapshot as string
      if (page === MAX_PAGES - 1) fail('catalog_too_large')
    }
    const info = await this.#desktop(connectionIdValue, { kind: 'info' })
    const state = await this.#state()
    const item = this.#connection(state, connectionIdValue)
    const capabilities = validateInfo({ desktop: info }, item.hostId)
    return { projects: rawProjects.map((item) => this.#project(item)), providers: rawProviders.map((item) => this.#provider(item)), sessions, providerEvidence: 'host_snapshot', ...capabilities }
  }

  async commands(connectionIdValue: string, value: DesktopRemoteContext): Promise<RemoteCommandCatalog> {
    const query = context(value)
    const raw = await this.#catalogRequest<unknown>(connectionIdValue, { op: 'commands', providerId: query.providerId, cwd: query.cwd, ...(query.agentProfileId ? { agentProfileId: query.agentProfileId } : {}) }, 'commands')
    if (!record(raw) || !Array.isArray(raw.commands) || raw.commands.length > MAX_ITEMS || (raw.reason !== undefined && !text(raw.reason, 512))) fail('invalid_catalog_response')
    const commands = raw.commands.map((item): RemoteCommandCatalog['commands'][number] => {
      if (!record(item) || !text(item.name, 128) || !pathText(item.description, 512) ||
          (item.argumentHint !== undefined && !text(item.argumentHint, 256)) ||
          (item.source !== undefined && !['builtin', 'skill', 'mcp', 'custom'].includes(String(item.source)))) fail('invalid_catalog_response')
      return { name: item.name, description: item.description, ...(text(item.argumentHint, 256) ? { argumentHint: item.argumentHint } : {}), ...(item.source !== undefined ? { source: item.source as RemoteCommandCatalog['commands'][number]['source'] } : {}) }
    })
    return { commands, ...(text(raw.reason, 512) ? { reason: raw.reason } : {}) }
  }

  async sessionAction(connectionIdValue: string, value: DesktopRemoteContext, action: DesktopRemoteSessionAction): Promise<boolean> {
    const query = context(value)
    if (!query.externalSessionId || !record(action)) fail('invalid_session_action')
    if (action.kind === 'rename') {
      if (typeof action.title !== 'string' || action.title.length > 256) fail('invalid_session_action')
    } else if (action.kind === 'pin') {
      if (typeof action.pinned !== 'boolean') fail('invalid_session_action')
    } else if (action.kind === 'archive') {
      if (typeof action.archived !== 'boolean') fail('invalid_session_action')
    } else fail('invalid_session_action')
    const info = await this.#desktop(connectionIdValue, { kind: 'info' })
    const state = await this.#state()
    const item = this.#connection(state, connectionIdValue)
    const capabilities = validateInfo({ desktop: info }, item.hostId)
    if (capabilities.sessionActions !== true) fail('desktop_session_actions_unsupported')
    const response = await this.#write(connectionIdValue, { op: 'sessionAction', context: query, action })
    if (!record(response) || typeof response.sessionAction !== 'boolean') fail('invalid_session_action_response')
    return response.sessionAction
  }

  async forkSession(connectionIdValue: string, request: DesktopRemoteForkSessionRequest): Promise<{ externalSessionId: string }> {
    if (!record(request) || !text(request.providerId, 256) || !text(request.cwd, 16_384) ||
        (request.agentProfileId !== undefined && !text(request.agentProfileId, 256)) || !text(request.sourceSessionId, 256) || !text(request.sourceRunId, 256) ||
        !text(request.sourceProviderTurnId, 256) || !text(request.sourceForkTurnId, 256)) fail('invalid_session_fork')
    const info = await this.#desktop(connectionIdValue, { kind: 'info' })
    const state = await this.#state(); const item = this.#connection(state, connectionIdValue)
    if (validateInfo({ desktop: info }, item.hostId).sessionFork !== true) fail('desktop_session_fork_unsupported')
    let response: unknown
    try { response = await this.#write(connectionIdValue, { op: 'sessionFork', request }) }
    catch (error) { if (this.#isUnknown(error)) fail('desktop_session_operation_unknown'); throw error }
    if (!record(response) || !record(response.sessionFork) || !text(response.sessionFork.externalSessionId, 256)) fail('desktop_session_operation_unknown')
    return { externalSessionId: response.sessionFork.externalSessionId }
  }

  async deleteSession(connectionIdValue: string, request: DesktopRemoteDeleteSessionRequest): Promise<DeleteSessionResult> {
    if (!record(request) || !text(request.providerId, 256) || !text(request.cwd, 16_384) || !text(request.externalSessionId, 256) || request.confirmed !== true ||
        (request.agentProfileId !== undefined && !text(request.agentProfileId, 256))) fail('invalid_session_delete')
    const info = await this.#desktop(connectionIdValue, { kind: 'info' })
    const state = await this.#state(); const item = this.#connection(state, connectionIdValue)
    if (validateInfo({ desktop: info }, item.hostId).sessionDelete !== true) fail('desktop_session_delete_unsupported')
    let response: unknown
    try { response = await this.#write(connectionIdValue, { op: 'sessionDelete', request }) }
    catch (error) { if (this.#isUnknown(error)) fail('desktop_session_operation_unknown'); throw error }
    if (!record(response) || !record(response.sessionDelete)) fail('desktop_session_operation_unknown')
    try { return validateDeleteSessionResult(response.sessionDelete) }
    catch { return fail('desktop_session_operation_unknown') }
  }

  async directories(connectionIdValue: string, path?: string, cursor?: number, snapshot?: string): Promise<DesktopDirectoryPage> {
    if (path !== undefined && !text(path, 4096) || cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0) || snapshot !== undefined && !HASH.test(snapshot) || Number(cursor) > 0 && snapshot === undefined) fail('invalid_directory_request')
    const result = await this.#catalogRequest<unknown>(connectionIdValue, { op: 'desktopDirectory', query: { action: 'list', ...(path === undefined ? {} : { path }), ...(cursor === undefined ? {} : { cursor }), ...(snapshot === undefined ? {} : { snapshot }) } }, 'directory')
    if (!record(result)) fail('invalid_directory_response')
    const page = result.page
    if (result.action !== 'list' || !record(page) || !Array.isArray(page.directories) || page.directories.length > 100 || !Number.isSafeInteger(page.cursor) || !Number.isSafeInteger(page.total) || Number(page.cursor) < 0 || Number(page.total) < Number(page.cursor) || Number(page.total) > MAX_ITEMS || typeof page.hasMore !== 'boolean' || typeof page.snapshot !== 'string' || !HASH.test(page.snapshot)) fail('invalid_directory_response')
    if (page.hasMore !== (Number(page.cursor) < Number(page.total)) || Number(page.cursor) !== (cursor ?? 0) + page.directories.length || snapshot !== undefined && snapshot !== page.snapshot) fail('invalid_directory_response')
    return { current: this.#project(page.current), ...(page.parent === undefined ? {} : { parent: this.#project(page.parent) }), directories: page.directories.map(item => this.#project(item)), cursor: page.cursor as number, total: page.total as number, hasMore: page.hasMore, snapshot: page.snapshot }
  }

  async selectDirectory(connectionIdValue: string, path: string): Promise<RemoteProjectRef> {
    if (!text(path, 4096)) fail('invalid_directory_path')
    const result = await this.#catalogRequest<unknown>(connectionIdValue, { op: 'desktopDirectory', query: { action: 'select', path } }, 'directory')
    if (!record(result) || result.action !== 'select') fail('invalid_directory_response')
    return this.#project(result.project)
  }

  async history(connectionIdValue: string, value: DesktopRemoteContext, before?: number, snapshot?: string): Promise<DesktopRemoteHistory> {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0) || snapshot !== undefined && !text(snapshot, 256)) fail('invalid_history_cursor')
    const query: Extract<DesktopHostRead, { kind: 'history' }> = { kind: 'history', historyScope: 'session', context: context(value), byteChunks: true, images: true, ...(before === undefined ? {} : { before }), ...(snapshot === undefined ? {} : { snapshot }) }
    let result = await this.#desktop(connectionIdValue, query)
    if (result.kind === 'history_chunk') {
      const { id, totalBytes } = result
      if (!uuid(id) || !Number.isSafeInteger(totalBytes) || Number(totalBytes) <= 0 || Number(totalBytes) > DESKTOP_HISTORY_MAX_BYTES) fail('invalid_history_response')
      const bytes = Buffer.alloc(totalBytes as number)
      let offset = 0
      while (offset < bytes.length) {
        const length = Math.min(DESKTOP_HISTORY_CHUNK_BYTES, bytes.length - offset)
        if (result.kind !== 'history_chunk' || result.id !== id || result.totalBytes !== totalBytes || result.offset !== offset || typeof result.data !== 'string' || result.data.length !== 4 * Math.ceil(length / 3)) fail('invalid_history_response')
        const chunk = Buffer.from(result.data, 'base64')
        if (chunk.length !== length || chunk.toString('base64') !== result.data) fail('invalid_history_response')
        chunk.copy(bytes, offset)
        offset += length
        if (offset < bytes.length) result = await this.#desktop(connectionIdValue, { ...query, chunk: { id, offset } })
      }
      let decoded: unknown
      try { decoded = JSON.parse(bytes.toString('utf8')) } catch { fail('invalid_history_response') }
      if (!record(decoded)) fail('invalid_history_response')
      result = decoded
    }
    const raw = result.history
    if (result.kind !== 'history' || !record(raw) || !Array.isArray(raw.turns) || typeof raw.hasOlder !== 'boolean' || raw.source !== 'trace_archive' || !['available', 'unavailable'].includes(String(raw.status))) fail('invalid_history_response')
    if (raw.historyScope !== 'session') fail('history_scope_unverified')
    if (raw.turns.length > MAX_ITEMS) fail('history_too_large')
    const turns = raw.turns.map((item) => this.#turn(item))
    if (raw.imageCounts !== undefined) {
      if (!record(raw.imageCounts)) fail('invalid_history_response')
      let imageBytes = 0
      for (const turn of turns) {
        const count = turn.runId ? raw.imageCounts[turn.runId] : undefined
        if (count === undefined) continue
        turn.attachments = await this.#readImages(connectionIdValue, value, turn.runId!, count, turn.providerTurnId, 'session')
        imageBytes += turn.attachments.reduce((sum, image) => sum + (image.size ?? 0), 0)
        if (imageBytes > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES * 2) fail('history_images_too_large')
      }
    }
    return { historyScope: 'session', turns, hasOlder: raw.hasOlder, ...(Number.isSafeInteger(raw.before) ? { before: raw.before as number } : {}), ...(text(raw.snapshot, 256) ? { snapshot: raw.snapshot } : {}), source: 'trace_archive', status: raw.status as DesktopRemoteHistory['status'], ...(text(raw.reason, 512) ? { reason: raw.reason } : {}) }
  }

  async trace(connectionIdValue: string, value: DesktopRemoteContext, runId: string, knownAttachmentCount?: number): Promise<ActiveRun | null> {
    if (!validRunId(runId)) fail('invalid_run_id')
    if (knownAttachmentCount !== undefined && (!Number.isSafeInteger(knownAttachmentCount) || knownAttachmentCount < 0 || knownAttachmentCount > DESKTOP_ATTACHMENT_MAX_COUNT)) fail('invalid_request')
    const result = await this.#desktop(connectionIdValue, { kind: 'trace', context: context(value), runId, images: true })
    if (result.kind !== 'trace' || (result.run !== null && !record(result.run))) fail('invalid_trace_response')
    if (result.run === null) return null
    const run = result.run
    if (!text(run.runId, 128) || (typeof run.userText !== 'string' || run.userText.length > 128_000) || typeof run.done !== 'boolean' || !Array.isArray(run.items) || run.items.length > MAX_ITEMS) fail('invalid_trace_response')
    const attachments = result.imageCount !== undefined && (result.imageCount !== knownAttachmentCount || result.imageCount === 0)
      ? await this.#readImages(connectionIdValue, value, runId, result.imageCount) : undefined
    return { ...run, ...(attachments ? { attachments } : {}), runId: run.runId, userText: run.userText, done: run.done, items: run.items.map((item) => this.#traceEvent(item)) } as unknown as ActiveRun
  }

  async #readImages(id: string, value: DesktopRemoteContext, runId: string, count: unknown, providerTurnId?: string, historyScope?: 'session'): Promise<AgentInputAttachment[]> {
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > DESKTOP_ATTACHMENT_MAX_COUNT) fail('invalid_image_response')
    const images: AgentInputAttachment[] = []
    let total = 0
    for (let index = 0; index < Number(count); index++) {
      const query = { kind: 'image' as const, context: context(value), runId, index, ...(providerTurnId === undefined ? {} : { providerTurnId }), ...(historyScope ? { historyScope } : {}) }
      let response = await this.#desktop(id, query)
      const { id: imageId, totalBytes, name, mimeType } = response
      if (response.kind !== 'image_chunk' || !uuid(imageId) || !text(name, 160) || !isSupportedImageMimeType(String(mimeType)) || !Number.isSafeInteger(totalBytes) || Number(totalBytes) <= 0 || Number(totalBytes) > DESKTOP_ATTACHMENT_MAX_BYTES) fail('invalid_image_response')
      total += Number(totalBytes)
      if (total > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) fail('images_too_large')
      const bytes = Buffer.alloc(Number(totalBytes))
      let offset = 0
      while (offset < bytes.length) {
        const length = Math.min(DESKTOP_HISTORY_CHUNK_BYTES, bytes.length - offset)
        if (response.kind !== 'image_chunk' || (historyScope && response.historyScope !== historyScope) || response.id !== imageId || response.offset !== offset || response.totalBytes !== totalBytes || response.name !== name || response.mimeType !== mimeType || typeof response.data !== 'string' || response.data.length !== 4 * Math.ceil(length / 3)) fail('invalid_image_response')
        const chunk = Buffer.from(response.data, 'base64')
        if (chunk.length !== length || chunk.toString('base64') !== response.data) fail('invalid_image_response')
        chunk.copy(bytes, offset)
        offset += length
        if (offset < bytes.length) response = await this.#desktop(id, { ...query, chunk: { id: imageId, offset } })
      }
      images.push({ kind: 'image', name, mimeType: mimeType as AgentInputAttachment['mimeType'], dataBase64: bytes.toString('base64'), size: bytes.length })
    }
    return images
  }

  async intents(connectionIdValue: string): Promise<DesktopRemoteIntent[]> {
    const state = await this.#state(); this.#connection(state, connectionIdValue)
    return state.intents.filter((item) => item.connectionId === connectionIdValue).map((item) => structuredClone(item))
  }

  async executionTargets(): Promise<import('../../shared/desktop-remote').ExecutionTargetRef[]> {
    const state = await this.#state()
    const targets = state.connections.filter((item) => !item.pending).map((item) => ({
      id: item.id,
      binding: this.#targetBinding(item),
      hostId: item.hostId,
      label: item.label,
      state: this.#active.get(item.id)?.tunnel.alive === true ? 'connected' as const : 'disconnected' as const
    }))
    if (targets.length > 32) fail('execution_target_capacity_exceeded')
    return targets
  }

  async mobileRequest(target: { id: string; binding: string }, request: Record<string, unknown>, authorizePeer?: () => void): Promise<unknown> {
    const state = await this.#state()
    const item = this.#connection(state, target.id)
    if (item.pending || this.#targetBinding(item) !== target.binding) fail('execution_target_binding_changed')
    if (!this.#active.get(item.id)?.tunnel.alive) fail('desktop_not_connected')
    authorizePeer?.()
    const authorize = () => this.#authorizeMobileTarget(state, target, authorizePeer)
    return ['stop', 'answerQuestion', 'sessionAction'].includes(String(request.op))
      ? this.#write(item.id, request, authorize)
      : this.#requestForConnection(item.id, request, authorize)
  }

  async mobileSubmit(input: import('../../shared/desktop-remote').DesktopMobileTargetSubmit & { authorizePeer?: () => void }): Promise<unknown> {
    // Serialize registration as well as transmission. A concurrent duplicate
    // must not send the in-memory receipt before its first disk save finishes.
    return this.#serializeWrite(input.target.id, async () => {
      const state = await this.#state()
      const item = this.#connection(state, input.target.id)
      const authorize = () => this.#authorizeMobileTarget(state, input.target, input.authorizePeer)
      authorize()
      if (!HASH.test(input.phonePeerFingerprint) || !uuid(input.phoneIntentId) || !HASH.test(input.target.binding) || !HASH.test(input.payloadHash)) fail('invalid_submit')
      if (input.request.op !== 'submit' || typeof input.request.detail !== 'string') fail('invalid_submit')
      const existing = state.intents.find((receipt) => receipt.connectionId === item.id && receipt.origin?.phonePeerFingerprint === input.phonePeerFingerprint &&
        receipt.origin.phoneIntentId === input.phoneIntentId && receipt.origin.targetBinding === input.target.binding)
      if (existing?.origin?.payloadHash !== undefined && existing.origin.payloadHash !== input.payloadHash) fail('intent_payload_conflict')
      if (existing?.runId && existing.status === 'recorded') return { runId: existing.runId, status: 'duplicate' }
      if (!this.#active.get(item.id)?.tunnel.alive) {
        if (existing) return { error: 'target_delivery_unknown' }
        fail('desktop_not_connected')
      }
      if (!existing && state.intents.some((receipt) => receipt.connectionId === item.id && receipt.status === 'unknown')) fail('unknown_receipts_pending')
      if (!existing && state.intents.length >= MAX_RECEIPTS) fail('intent_receipt_capacity_exceeded')
      const intent: DesktopRemoteIntent = existing ?? {
        intentId: randomUUID(), connectionId: item.id, context: this.#contextFromDetail(input.request.detail), createdAt: Date.now(), status: 'unknown',
        origin: { phonePeerFingerprint: input.phonePeerFingerprint, phoneIntentId: input.phoneIntentId, targetBinding: input.target.binding, payloadHash: input.payloadHash }
      }
      if (!existing) { state.intents.push(intent); await this.#save(state) }
      let response: unknown
      try {
        response = await this.#requestForConnection(item.id, { ...input.request, intentId: intent.intentId }, authorize)
      } catch (error) {
        if (!existing && this.#isPreDispatchRejection(error)) {
          state.intents = state.intents.filter((receipt) => receipt.intentId !== intent.intentId)
          await this.#save(state)
          throw error
        }
        // A repeated delivery may have executed on the earlier attempt. Do not
        // turn another lost reply (or new rejection) into proof of nonexecution.
        return { error: 'target_delivery_unknown' }
      }
      if (!record(response) || !uuid(response.runId) || (response.status !== 'recorded' && response.status !== 'duplicate')) return { error: 'target_delivery_unknown' }
      intent.runId = response.runId
      intent.status = 'recorded'
      await this.#save(state)
      return response
    })
  }

  async mobileIntentStatus(input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string; authorizePeer?: () => void }): Promise<unknown> {
    const state = await this.#state()
    const item = this.#connection(state, input.target.id)
    if (item.pending || this.#targetBinding(item) !== input.target.binding) fail('execution_target_binding_changed')
    if (!HASH.test(input.phonePeerFingerprint) || !uuid(input.phoneIntentId)) fail('invalid_intent_id')
    const intent = state.intents.find((receipt) => receipt.connectionId === item.id && receipt.origin?.phonePeerFingerprint === input.phonePeerFingerprint && receipt.origin.phoneIntentId === input.phoneIntentId && receipt.origin.targetBinding === input.target.binding)
    if (!intent) fail('unknown_intent')
    const authorize = () => this.#authorizeMobileTarget(state, input.target, input.authorizePeer)
    let response: Record<string, unknown>
    try { response = await this.#requestForConnection(item.id, { op: 'intentStatus', intentId: intent.intentId }, authorize) }
    catch (error) { if (this.#isExplicitUnknownIntent(error)) throw error; fail('target_delivery_unknown') }
    if (record(response) && record(response.intent) && uuid(response.intent.runId)) {
      intent.runId = response.intent.runId; intent.status = 'recorded'; await this.#save(state)
    }
    return response
  }

  async submit(connectionIdValue: string, input: DesktopRemoteSubmit): Promise<DesktopRemoteIntent> {
    if (this.#submitting.has(connectionIdValue)) fail('submission_in_progress')
    this.#submitting.add(connectionIdValue)
    try { return await this.#submit(connectionIdValue, input) }
    finally { this.#submitting.delete(connectionIdValue) }
  }

  async #submit(connectionIdValue: string, input: DesktopRemoteSubmit): Promise<DesktopRemoteIntent> {
    const state = await this.#state(); const item = this.#connection(state, connectionIdValue); this.#assertSubmit(input)
    const attachments = (input.attachments ?? []).map(normalizeDesktopAttachment)
    if (attachments.length > DESKTOP_ATTACHMENT_MAX_COUNT || attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0) > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) fail('attachments_too_large')
    if (state.intents.some((receipt) => receipt.connectionId === connectionIdValue && receipt.status === 'unknown')) fail('unknown_receipts_pending')
    if (!this.#active.get(connectionIdValue)?.tunnel.alive) fail('desktop_not_connected')
    const intent: DesktopRemoteIntent = { intentId: randomUUID(), connectionId: item.id, context: structuredClone(input.context), createdAt: Date.now(), status: 'unknown' }
    // A recorded run remains a durable receipt until its terminal state is
    // observed. Never evict active or merely unverified receipts to make room.
    if (state.intents.length >= MAX_RECEIPTS) fail('intent_receipt_capacity_exceeded')
    let attachmentEntries: unknown[] = []
    if (attachments.length > 0) {
        const capability = this.#active.get(connectionIdValue)?.attachments
        if (capability) {
          attachmentEntries = await this.#uploadAttachments(connectionIdValue, intent.intentId, attachments)
        } else {
          if (attachments.some((attachment) => (attachment.size ?? 0) > 512 * 1024) || attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0) > 700 * 1024) fail('desktop_remote_attachments_unsupported')
          attachmentEntries = attachments
        }
    }
    // Uploads cannot execute work. A crash during upload must not leave an
    // unknown submit receipt that permanently blocks a safely unsent draft.
    if (state.intents.some((receipt) => receipt.connectionId === connectionIdValue && receipt.status === 'unknown')) fail('unknown_receipts_pending')
    if (state.intents.length >= MAX_RECEIPTS) fail('intent_receipt_capacity_exceeded')
    state.intents.push(intent)
    await this.#save(state) // Durable fence immediately before the actual submit.
    const detail = canonicalJson({ cwd: input.context.cwd, providerId: input.context.providerId, ...(input.context.agentProfileId ? { agentProfileId: input.context.agentProfileId } : {}), prompt: input.prompt,
      ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.modelProviderId ? { modelProviderId: input.modelProviderId } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}), ...(input.context.externalSessionId ? { resume: input.context.externalSessionId } : {}), ...(attachmentEntries.length > 0 ? { attachments: attachmentEntries } : {}) })
    let response: unknown
    try { response = await this.#write(connectionIdValue, { op: 'submit', intentId: intent.intentId, detail }) }
    catch (error) {
      if (!this.#isPreDispatchRejection(error)) { await this.#save(state); return structuredClone(intent) }
      state.intents = state.intents.filter((receipt) => receipt.intentId !== intent.intentId)
      await this.#save(state)
      throw error
    }
    if (!record(response) || !uuid(response.runId) || (response.status !== 'recorded' && response.status !== 'duplicate')) {
      // A malformed or untrusted acknowledgement is not proof that the host
      // rejected the write. Keep the stable intent id for reconciliation.
      await this.#save(state)
      return structuredClone(intent)
    }
    intent.runId = response.runId; intent.status = 'recorded'; await this.#save(state); return structuredClone(intent)
  }

  async intentStatus(connectionIdValue: string, intentId: string): Promise<DesktopRemoteIntent> {
    const state = await this.#state(); this.#connection(state, connectionIdValue)
    if (!uuid(intentId)) fail('invalid_intent_id')
    const local = state.intents.find((item) => item.connectionId === connectionIdValue && item.intentId === intentId)
    if (!local) fail('unknown_intent')
    let response: Record<string, unknown>
    try { response = await this.#requestForConnection(connectionIdValue, { op: 'intentStatus', intentId }) }
    catch (error) { if (this.#isExplicitUnknownIntent(error)) return structuredClone(local); throw error }
    if (!record(response.intent) || !uuid(response.intent.runId) || !['recorded', 'dispatched', 'settled', 'failed', 'cancelled'].includes(String(response.intent.state))) fail('invalid_intent_status_response')
    local.runId = response.intent.runId; local.status = 'recorded'; await this.#save(state); return structuredClone(local)
  }

  async runStatus(connectionIdValue: string, runIdValue: string): Promise<DesktopRemoteRunStatus> {
    if (!validRunId(runIdValue)) fail('invalid_run_id')
    const key = `${connectionIdValue}:${runIdValue}`
    const watch = this.#runWatch.get(key) ?? { cursor: 0 }
    // Desktop content comes from canonical trace reads, not the shadow output
    // spool. Its overflow or I/O failure must not block authoritative lifecycle.
    // Read state before events so a terminal snapshot cannot retire the receipt
    // before we have read its preceding bound/session markers.
    const stateResponse = await this.#requestForConnection(connectionIdValue, { op: 'runState', runId: runIdValue })
    if (!record(stateResponse) || (stateResponse.state !== null && !['recorded', 'dispatched', 'settled', 'failed', 'cancelled'].includes(String(stateResponse.state)))) fail('invalid_run_status_response')
    const authoritativeState = stateResponse.state === null ? null : String(stateResponse.state)
    let observedState: DesktopRemoteRunStatus['state'] = 'unknown'
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.#requestForConnection(connectionIdValue, { op: 'poll', cursor: watch.cursor })
      if (!record(response) || !record(response.poll) || !Array.isArray(response.poll.events) ||
          !Number.isSafeInteger(response.poll.cursor) || (response.poll.reset !== undefined && !record(response.poll.reset))) fail('invalid_run_status_response')
      const poll = response.poll as { events: unknown[]; cursor: number }
      watch.cursor = poll.cursor
      for (const event of poll.events) {
        if (!record(event) || event.runId !== runIdValue || !text(event.kind, 64)) continue
        if (event.kind === 'intent_recorded') observedState = 'recorded'
        else if (event.kind === 'run_dispatched') observedState = 'dispatched'
        else if (event.kind === 'run_settled') observedState = 'settled'
        else if (event.kind === 'run_failed' || event.kind === 'run_cancelled') observedState = 'failed'
        if (event.kind !== 'run_progress' || typeof event.detail !== 'string') continue
        try {
          const marker = JSON.parse(event.detail) as Record<string, unknown>
          if (marker.event === 'bound' && validRunId(marker.scryRunId)) watch.scryRunId = marker.scryRunId
          if (marker.event === 'session' && text(marker.externalSessionId, 256)) watch.externalSessionId = marker.externalSessionId
        } catch { /* opaque progress is not evidence */ }
      }
      if (poll.events.length === 0 || poll.events.length < 256) break
    }
    this.#runWatch.set(key, watch)
    const state: DesktopRemoteRunStatus['state'] = authoritativeState === null ? observedState : authoritativeState === 'cancelled' ? 'failed' : authoritativeState as DesktopRemoteRunStatus['state']
    if (state === 'settled' || state === 'failed' || watch.externalSessionId) {
      const stateData = await this.#state()
      const intent = stateData.intents.find((item) => item.connectionId === connectionIdValue && item.runId === runIdValue)
      if (intent && (state === 'settled' || state === 'failed')) {
        stateData.intents = stateData.intents.filter((item) => item.intentId !== intent.intentId)
        await this.#save(stateData)
      } else if (intent && !intent.context.externalSessionId && watch.externalSessionId) {
        // Keep the host-confirmed session binding across navigation and restart.
        // This changes no submitted prompt and never replays the original intent.
        intent.context.externalSessionId = watch.externalSessionId
        await this.#save(stateData)
      }
    }
    return { state, ...(watch.scryRunId ? { scryRunId: watch.scryRunId } : {}), ...(watch.externalSessionId ? { externalSessionId: watch.externalSessionId } : {}) }
  }

  async stop(connectionIdValue: string, runId: string): Promise<void> { if (!validRunId(runId)) fail('invalid_run_id'); const response = await this.#write(connectionIdValue, { op: 'stop', runId }); if (!record(response) || !record(response.stop) || (response.stop.status !== 'requested' && response.stop.status !== 'already_requested')) fail('stop_not_confirmed') }
  async answer(connectionIdValue: string, runId: string, responseValue: AgentQuestionResponse): Promise<void> {
    if (!validRunId(runId) || !record(responseValue)) fail('invalid_answer')
    const questionId = (responseValue as Record<string, unknown>).questionId
    if (!text(questionId, 256)) fail('invalid_answer')
    const answerKey = `${connectionIdValue}:${runId}:${questionId}`
    const answerId = this.#answerIds.get(answerKey) ?? randomUUID()
    this.#answerIds.set(answerKey, answerId)
    // The renderer keeps the canonical Scry question identity, while the host
    // broker is keyed by the ledger run UUID. The wire response follows the
    // broker's ledger identity without changing the displayed trace identity.
    const wireResponse = { ...responseValue, runId } as AgentQuestionResponse
    const response = await this.#write(connectionIdValue, { op: 'answerQuestion', runId, answerId, response: wireResponse })
    if (!record(response) || !record(response.answer) || response.answer.status !== 'answered') fail('answer_not_confirmed')
  }

  async workbench<Request extends DesktopWorkbenchRequest>(connectionIdValue: string, request: Request): Promise<DesktopWorkbenchResult<Request>> {
    const query = parseDesktopWorkbenchQuery(request)
    const wire = { op: 'desktopWorkbench', query }
    const read = ['workspaceList', 'workspaceRead', 'workspaceReadKnown', 'workspaceReadPage', 'workspaceReadPageKnown', 'terminalActive', 'terminalEvents', 'terminalRecordingList', 'terminalRecordingRead', 'read', 'diff', 'operations', 'pullRequests', 'pullRequest', 'loadCommitDraft', 'loadDraft'].includes(query.method)
    // Writes are serialized and never automatically retried, including PTY input.
    const response = read ? await this.#requestForConnection(connectionIdValue, wire) : await this.#write(connectionIdValue, wire)
    if (!record(response) || !Object.hasOwn(response, 'workbench')) fail('invalid_desktop_workbench_response')
    validateDesktopWorkbenchResponse(request, response.workbench)
    return response.workbench as DesktopWorkbenchResult<Request>
  }

  async files(connectionIdValue: string, value: DesktopRemoteContext, path: string, cursor?: string): Promise<WorkspaceListResult> {
    if (!pathText(path, 16_384) || (cursor !== undefined && !pathText(cursor, 4096))) fail('invalid_path')
    const response = await this.#requestForConnection(connectionIdValue, { op: 'workspace', query: { action: 'list', cwd: context(value).cwd, path, ...(cursor === undefined ? {} : { cursor }) } })
    if (!record(response) || !record(response.workspace) || response.workspace.action !== 'list' || !record(response.workspace.listing)) fail('invalid_workspace_response')
    const listing = response.workspace.listing
    if (!Array.isArray(listing.entries) || listing.entries.length > MAX_ITEMS || typeof listing.truncated !== 'boolean' || (listing.nextCursor !== undefined && !text(listing.nextCursor, 4096))) fail('invalid_workspace_response')
    for (const entry of listing.entries) if (!record(entry) || !text(entry.name, 512) || !text(entry.path, 16_384) || (entry.kind !== 'file' && entry.kind !== 'directory') || !Number.isFinite(entry.mtimeMs) || (entry.size !== undefined && !Number.isSafeInteger(entry.size))) fail('invalid_workspace_response')
    return { entries: listing.entries as unknown as WorkspaceListResult['entries'], truncated: listing.truncated, ...(listing.nextCursor ? { nextCursor: listing.nextCursor } : {}) }
  }

  async file(connectionIdValue: string, value: DesktopRemoteContext, path: string, offset?: number, snapshot?: string): Promise<WorkspaceFilePage> {
    if (!pathText(path, 16_384) || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) || (snapshot !== undefined && !text(snapshot, 4096))) fail('invalid_path')
    const response = await this.#requestForConnection(connectionIdValue, { op: 'workspace', query: { action: 'file', cwd: context(value).cwd, path, ...(offset === undefined ? {} : { offset }), ...(snapshot ? { snapshot } : {}) } })
    if (!record(response) || !record(response.workspace) || response.workspace.action !== 'file' || !record(response.workspace.file)) fail('invalid_workspace_response')
    const file = response.workspace.file
    if (!text(file.name, 512) || !text(file.path, 16_384) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 512 * 1024 || !Number.isSafeInteger(file.offset) || !Number.isSafeInteger(file.nextOffset) || !Number.isSafeInteger(file.totalBytes) || typeof file.hasMore !== 'boolean' || !text(file.snapshot, 256) || !text(file.language, 128)) fail('invalid_workspace_response')
    return { name: file.name as string, path: file.path as string, content: file.content as string, offset: file.offset as number, nextOffset: file.nextOffset as number, totalBytes: file.totalBytes as number, hasMore: file.hasMore as boolean, snapshot: file.snapshot as string, language: file.language as string }
  }

  async dispose(): Promise<void> {
    return this.#serializeLifecycle(async () => {
      if (this.#disposed) return
      this.#disposed = true
      for (const controller of this.#controllers) controller.abort()
      await Promise.allSettled([this.#statePromise])
      await Promise.allSettled([...this.#requests])
      await Promise.allSettled([...this.#active.values()].map((active) => active.tunnel.close()))
      this.#active.clear(); this.#runWatch.clear(); this.#answerIds.clear()
    })
  }
  close(): Promise<void> { return this.dispose() }

  async #state(): Promise<EncryptedState> { this.#assertLive(); return this.#statePromise }
  async #load(): Promise<EncryptedState> {
    try {
      const raw = await fs.readFile(join(this.#directory, STATE_FILE))
      const decoded = this.#decrypt(Buffer.from(raw))
      if (typeof decoded !== 'string') fail('desktop_state_corrupt')
      return validateState(JSON.parse(decoded))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const identity = await this.#transport.generateIdentity()
      validateIdentity(identity)
      // Listing a fresh profile is read-only. Persist this identity with the first
      // pairing, before any network proof; a failed save must not publish a host.
      return { version: 1, identity, connections: [], intents: [] }
    }
  }
  async #save(state: EncryptedState, connections?: StoredConnection[]): Promise<void> {
    const previous = this.#saveSerial.catch(() => {})
    const next = previous.then(async () => {
      // Snapshot inside the queue, and publish a connection replacement before the
      // next save starts. A late receipt refresh must not restore an old address.
      const snapshot = structuredClone(validateState(connections ? { ...state, connections } : state))
      await this.#writeState(snapshot)
      if (connections) state.connections = connections
    })
    this.#saveSerial = next
    await next
  }
  async #writeState(state: EncryptedState): Promise<void> {
    const encrypted = this.#encrypt(JSON.stringify(state))
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > 4 * 1024 * 1024) fail('desktop_state_encryption_failed')
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 }); const temp = join(this.#directory, `.${STATE_FILE}.${randomUUID()}.tmp`)
    try { await fs.writeFile(temp, encrypted, { mode: 0o600 }); await fs.rename(temp, join(this.#directory, STATE_FILE)) } finally { await fs.rm(temp, { force: true }) }
  }
  #assertLive(): void { if (this.#disposed) fail('desktop_client_disposed') }
  #connection(state: EncryptedState, id: string): StoredConnection { if (!text(id, 300)) fail('invalid_connection_id'); const item = state.connections.find((value) => value.id === id); return item ?? fail('unknown_connection') }
  async #pairRequest(state: EncryptedState, item: StoredConnection, operation: 'pair.prove' | 'pair.status'): Promise<unknown> {
    const invitation = item.pending; if (!invitation) fail('pairing_not_pending')
    const tunnel = await this.#transport.openTunnel({ ...item.ssh, pairPort: this.#pairPort(item), runPort: this.#runPort(item) })
    try {
      const requestId = randomUUID(); const request = operation === 'pair.prove'
        ? { protocolMajor: 1, requestId, operation, pairingId: invitation.pairingId, secret: invitation.secret, csrPEM: state.identity.csrPEM, deviceLabel: item.label }
        : { protocolMajor: 1, requestId, operation, pairingId: invitation.pairingId, secret: invitation.secret }
      const response = await this.#request(tunnel.pairPath, item, request)
      return validatePairingResponse(response, requestId, invitation.pairingId)
    } finally { await tunnel.close() }
  }
  async #consumePairingResponse(state: EncryptedState, item: StoredConnection, response: unknown): Promise<DesktopPairingResult> {
    const result = response as Record<string, unknown>
    if (result.kind === 'pair.pending') {
      if (!hash(result.publicKeySHA256) || result.publicKeySHA256 !== state.identity.publicKeySHA256) fail('pairing_key_mismatch')
      return { connection: publicConnection(item, false), publicKeySHA256: result.publicKeySHA256, state: 'pending' }
    }
    if (result.kind !== 'pair.granted') {
      delete item.pending
      await this.#save(state)
      fail(String(result.code ?? result.kind))
    }
    const cert = validateCertificate(result.certificatePEM, item.anchorPEM, state.identity.publicKeySHA256)
    if (!uuid(result.deviceId) || result.scope !== 'g0_echo_only' || !hash(result.certificateSHA256) || result.certificateSHA256 !== cert.certificateSHA256 || result.expiresAt !== cert.expiresAt || result.expiresAt <= Date.now()) fail('invalid_device_grant')
    item.certificatePEM = cert.certificatePEM; item.certificateExpiresAt = cert.expiresAt; delete item.pending
    await this.#save(state)
    return { connection: publicConnection(item, false), publicKeySHA256: state.identity.publicKeySHA256, state: 'paired' }
  }
  #pairPort(item: StoredConnection): number { return item.pairPort }
  #runPort(item: StoredConnection): number { return item.runPort }
  async #requestForConnection(id: string, request: unknown, authorizePeer?: () => void): Promise<Record<string, unknown>> { const state = await this.#state(); const item = this.#connection(state, id); const active = this.#active.get(id); if (!active?.tunnel.alive) fail('desktop_not_connected'); return await this.#request(active.tunnel.runPath, item, request, authorizePeer) as Record<string, unknown> }
  async #desktop(id: string, query: DesktopHostRead): Promise<Record<string, unknown>> {
    const response = await this.#requestForConnection(id, { op: 'desktop', query })
    if (!record(response) || !record(response.desktop) || !['info', 'history', 'history_chunk', 'trace', 'image_chunk'].includes(String(response.desktop.kind))) fail('invalid_desktop_response')
    return response.desktop
  }
  async #catalogRequest<T>(id: string, request: unknown, key: string): Promise<T> { const response = await this.#requestForConnection(id, request); if (!record(response) || !(key in response)) fail('invalid_catalog_response'); return response[key] as T }
  async #request(path: string, item: StoredConnection, request: unknown, authorizePeer?: () => void): Promise<unknown> {
    const controller = new AbortController()
    const identity = (await this.#state()).identity
    // Check after all awaited state/lock work and immediately before dispatch.
    authorizePeer?.()
    this.#controllers.add(controller)
    const promise = this.#transport.tlsRequest({ path, caPEM: item.anchorPEM, certPEM: item.certificatePEM ?? identity.bootstrapCertPEM, keyPEM: identity.keyPEM, request, signal: controller.signal })
    this.#requests.add(promise)
    try {
      const response = await promise
      if (record(response) && typeof response.error === 'string' && response.error.length > 0 && response.error.length <= 128) fail(`desktop_remote_${response.error}`)
      return response
    } finally { this.#requests.delete(promise); this.#controllers.delete(controller) }
  }
  async #disconnectActive(connectionIdValue: string): Promise<void> {
    const active = this.#active.get(connectionIdValue)
    if (!active) return
    this.#active.delete(connectionIdValue)
    await active.tunnel.close()
  }
  async #serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycle.catch(() => {})
    const queued = previous.then(operation)
    this.#lifecycle = queued.then(() => undefined, () => undefined)
    return queued
  }
  async #reconcileUnknown(state: EncryptedState, connectionIdValue: string): Promise<void> {
    for (const intent of state.intents.filter((item) => item.connectionId === connectionIdValue && item.status === 'unknown')) {
      try { await this.intentStatus(connectionIdValue, intent.intentId) } catch (error) {
        if (!this.#isUnknown(error)) throw error
      }
    }
  }
  async #serializeWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve(); let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }); const queued = previous.then(() => gate); this.#locks.set(id, queued)
    await previous
    try { return await operation() } finally { release(); if (this.#locks.get(id) === queued) this.#locks.delete(id) }
  }
  async #write(id: string, request: unknown, authorizePeer?: () => void): Promise<unknown> {
    return this.#serializeWrite(id, () => this.#requestForConnection(id, request, authorizePeer))
  }
  #authorizeMobileTarget(state: EncryptedState, target: { id: string; binding: string }, authorizePeer?: () => void): void {
    authorizePeer?.()
    const current = this.#connection(state, target.id)
    if (current.pending || this.#targetBinding(current) !== target.binding) fail('execution_target_binding_changed')
  }
  #isUnknown(error: unknown): boolean {
    if (!(error instanceof Error)) return true
    return !/^(?:invalid_|desktop_protocol|desktop_capability|desktop_remote_|stop_not_confirmed|answer_not_confirmed|device_not_authorized|pairing_|device_certificate|unknown_|desktop_not_connected|desktop_client)/i.test(error.message)
  }
  #isPreDispatchRejection(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /^(?:desktop_remote_(?:device_not_authorized|invalid_request|invalid_intent_id|intent_payload_conflict|unknown_op|ledger_capacity_exceeded|attachments_unsupported)|attachment_transfer_failed|attachments_too_large|attachment_invalid|attachment_path_forbidden|desktop_not_connected|desktop_client_disposed|device_not_authorized|execution_target_binding_changed|unknown_connection)$/i.test(error.message)
  }
  #isExplicitUnknownIntent(error: unknown): boolean { return error instanceof Error && /desktop_remote_unknown_intent$/i.test(error.message) }
  async #uploadAttachments(connectionIdValue: string, intentId: string, attachments: ReturnType<typeof normalizeDesktopAttachment>[]): Promise<unknown[]> {
    const entries: unknown[] = []
    for (const [index, attachment] of attachments.entries()) {
      const attachmentId = newAttachmentId()
      const metadata = { attachmentId, intentId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size ?? 0, sha256: attachmentSha256(attachment), index, totalCount: attachments.length }
      try {
        const started = await this.#write(connectionIdValue, { op: 'attachmentStart', ...metadata })
        if (!record(started) || started.status !== 'ready') fail('attachment_transfer_failed')
        const bytes = Buffer.from(attachment.dataBase64, 'base64')
        for (let offset = 0; offset < bytes.length; offset += DESKTOP_ATTACHMENT_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + DESKTOP_ATTACHMENT_CHUNK_BYTES))
          const uploaded = await this.#write(connectionIdValue, { op: 'attachmentChunk', attachmentId, offset, dataBase64: chunk.toString('base64') })
          if (!record(uploaded) || uploaded.offset !== offset + chunk.length) fail('attachment_transfer_failed')
        }
        const response = await this.#write(connectionIdValue, { op: 'attachmentCommit', attachmentId })
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
  #assertSubmit(input: DesktopRemoteSubmit): void {
    if (!record(input) || typeof input.prompt !== 'string' || input.prompt.length > 128_000 || input.prompt.includes('\0')) fail('invalid_submit')
    if (input.prompt.length === 0 && (!Array.isArray(input.attachments) || input.attachments.length === 0)) fail('invalid_submit')
    context(input.context)
    for (const key of ['modelId', 'modelProviderId', 'effort'] as const) if (input[key] !== undefined && !text(input[key], 256)) fail('invalid_submit')
    if (input.permissionMode !== undefined && !isAgentPermissionMode(input.permissionMode)) fail('invalid_submit')
    if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > DESKTOP_ATTACHMENT_MAX_COUNT)) fail('invalid_submit')
  }
  #targetBinding(item: StoredConnection): string {
    if (!item.certificatePEM) return createHash('sha256').update(`${item.hostId}\0${item.anchorSHA256}\0missing`).digest('hex')
    let certificate: NodeCertificate
    try { certificate = new NodeCertificate(item.certificatePEM) } catch { fail('execution_target_binding_changed') }
    return createHash('sha256').update(`${item.hostId}\0${item.anchorSHA256}\0${digest(certificate.raw)}`).digest('hex')
  }
  #contextFromDetail(detail: string): DesktopRemoteContext {
    if (detail.length > 1_310_720) fail('invalid_submit')
    let value: unknown
    try { value = JSON.parse(detail) } catch { fail('invalid_submit') }
    if (!record(value) || !text(value.cwd, 16_384) || !text(value.providerId, 256)) fail('invalid_submit')
    return { cwd: value.cwd, providerId: value.providerId,
      ...(text(value.agentProfileId, 256) ? { agentProfileId: value.agentProfileId } : {}),
      ...(text(value.resume, 256) ? { externalSessionId: value.resume } : {}) }
  }
  #traceEvent(value: unknown): TraceEvent { if (!record(value) || !text(value.id, 256) || !text(value.ts, 128) || !text(value.runId, 128) || !text(value.kind, 128) || !text(value.stage, 256)) fail('invalid_trace_response'); return value as unknown as TraceEvent }
  #turn(value: unknown): LoadedSessionTurn {
    if (!record(value) || (typeof value.userText !== 'string' || value.userText.length > 128_000) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) fail('invalid_history_response')
    if (value.runId !== undefined && !text(value.runId, 128) || value.providerTurnId !== undefined && !text(value.providerTurnId, 256) ||
        value.forkTurnId !== undefined && !text(value.forkTurnId, 256) || value.attachments !== undefined && !Array.isArray(value.attachments) ||
        value.done !== undefined && typeof value.done !== 'boolean' || value.error !== undefined && !pathText(value.error, 128_000) ||
        value.errorHint !== undefined && !pathText(value.errorHint, 128_000)) fail('invalid_history_response')
    return {
      userText: value.userText,
      items: value.items.map((item) => this.#traceEvent(item)),
      ...(text(value.runId, 128) ? { runId: value.runId } : {}),
      ...(text(value.providerTurnId, 256) ? { providerTurnId: value.providerTurnId } : {}),
      ...(text(value.forkTurnId, 256) ? { forkTurnId: value.forkTurnId } : {}),
      ...(Array.isArray(value.attachments) ? { attachments: value.attachments as LoadedSessionTurn['attachments'] } : {}),
      ...(typeof value.done === 'boolean' ? { done: value.done } : {}),
      ...(value.error !== undefined ? { error: value.error as string } : {}),
      ...(value.errorHint !== undefined ? { errorHint: value.errorHint as string } : {})
    }
  }
  #project(value: unknown): RemoteProjectRef { if (!record(value) || !text(value.path, 16_384) || !text(value.label, 512)) fail('invalid_catalog_response'); return { path: value.path as string, label: value.label as string } }
  #provider(value: unknown): RemoteProviderRef { if (!record(value) || !text(value.id, 256) || !text(value.label, 512) || typeof value.available !== 'boolean') fail('invalid_catalog_response'); return value as unknown as RemoteProviderRef }
  #session(value: unknown): RemoteSessionRef {
    if (!record(value) || !text(value.sessionId, 256) || !text(value.providerId, 256) || !text(value.cwd, 16_384) || !text(value.label, 512) || !Number.isSafeInteger(value.ts) ||
        (value.externalSessionId !== undefined && !text(value.externalSessionId, 256)) ||
        (value.agentProfileId !== undefined && !text(value.agentProfileId, 256)) ||
        (value.pinnedAt !== undefined && (!Number.isSafeInteger(value.pinnedAt) || Number(value.pinnedAt) <= 0)) ||
        (value.archivedAt !== undefined && (!Number.isSafeInteger(value.archivedAt) || Number(value.archivedAt) <= 0)) ||
        (value.isActive !== undefined && typeof value.isActive !== 'boolean')) fail('invalid_catalog_response')
    return value as unknown as RemoteSessionRef
  }
}

export { parseInvitation as parseDesktopInvitation }
