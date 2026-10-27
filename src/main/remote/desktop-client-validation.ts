import { createHash, X509Certificate as NodeCertificate } from 'node:crypto'
import { isRemoteProviderObservationTime, isRemoteSessionOutcome, type DesktopHostInvitation, type DesktopRemoteConnection, type DesktopRemoteContext, type DesktopRemoteIntent, type DesktopSshTarget, type RemoteProviderRef, type RemoteProjectRef, type RemoteSessionRef } from '../../shared/desktop-remote'
import { DESKTOP_ATTACHMENT_CHUNK_BYTES, DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, type DesktopAttachmentCapability } from './desktop-attachments'
import type { DeleteSessionResult } from '../../shared/provider'
import type { TraceEvent } from '../../shared/trace'
import type { LoadedSessionTurn } from '../../shared/session-history'
import type { DesktopDeviceIdentity, DesktopSshTunnel } from './desktop-transport'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const MAC_RUN_ID = /^(?:remote-)?run-[0-9a-z]{1,24}-[0-9a-z]{1,12}$/
export const HASH = /^[a-f0-9]{64}$/
export const B64URL = /^[A-Za-z0-9_-]+$/
export const MAX_RECEIPTS = 256
export const MAX_PAGES = 100
export const MAX_ITEMS = 10_000
export const STATE_FILE = 'desktop-client.state'

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

export interface EncryptedState {
  version: 1
  identity: DesktopDeviceIdentity
  connections: StoredConnection[]
  intents: DesktopRemoteIntent[]
}
export interface StoredConnection {
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
export interface ActiveConnection { tunnel: DesktopSshTunnel; serial: Promise<void>; attachments?: DesktopAttachmentCapability; traceDelta?: 1 }
export interface RunStatusCursor { cursor: number; scryRunId?: string; externalSessionId?: string }

export function fail(code: string): never { throw new Error(code) }
export function submitFailure(error: unknown): string {
  return (error instanceof Error ? error.message : 'submit_result_unknown').replace(/\0/g, '').slice(0, 512) || 'submit_result_unknown'
}
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function text(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') }
export function pathText(value: unknown, max = 16_384): value is string { return typeof value === 'string' && value.length <= max && !value.includes('\0') }
export function port(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535 }
export function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
export function validRunId(value: unknown): value is string { return typeof value === 'string' && (UUID.test(value) || MAC_RUN_ID.test(value)) }
export function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value) }
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function canonicalJson(value: unknown): string { const encoded = JSON.stringify(value); if (!encoded || Buffer.byteLength(encoded) > 1_310_720) fail('desktop_request_too_large'); return encoded }

export function validateSsh(value: unknown): DesktopSshTarget {
  if (!record(value) || !text(value.hostname, 253) || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(value.hostname) ||
      !text(value.username, 253) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.username) || !port(value.port)) fail('invalid_ssh')
  return { hostname: value.hostname, username: value.username, port: value.port }
}

export function validatePem(value: unknown, label: string): NodeCertificate {
  if (!text(value, 32_768) || !value.includes(`-----BEGIN ${label}-----`) || !value.includes(`-----END ${label}-----`)) fail('invalid_certificate')
  try { return new NodeCertificate(value) } catch { fail('invalid_certificate') }
}

export function parseInvitation(input: string): DesktopHostInvitation & { anchorSHA256: string } {
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

export function connectionId(hostId: string, anchorSHA256: string): string { return `${hostId}:${anchorSHA256}` }

export function validateIdentity(value: unknown): DesktopDeviceIdentity {
  if (!record(value) || !text(value.keyPEM, 32_768) || !text(value.csrPEM, 32_768) || !text(value.bootstrapCertPEM, 32_768) || !hash(value.publicKeySHA256)) fail('invalid_device_identity')
  const identity = value as Record<string, unknown>
  return { keyPEM: identity.keyPEM as string, csrPEM: identity.csrPEM as string, bootstrapCertPEM: identity.bootstrapCertPEM as string, publicKeySHA256: identity.publicKeySHA256 as string }
}

export function validateState(value: unknown): EncryptedState {
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
        (item.status !== 'recorded' && item.status !== 'unknown') || (item.runId !== undefined && !uuid(item.runId)) ||
        (item.failure !== undefined && !text(item.failure, 512))) fail('desktop_state_corrupt')
    if (item.origin !== undefined) {
      if (!record(item.origin) || !HASH.test(String(item.origin.phonePeerFingerprint)) || !uuid(item.origin.phoneIntentId) ||
          !HASH.test(String(item.origin.targetBinding)) || !HASH.test(String(item.origin.payloadHash))) fail('desktop_state_corrupt')
    }
    return structuredClone(item) as unknown as DesktopRemoteIntent
  })
  return { version: 1, identity, connections, intents }
}

export function publicConnection(item: StoredConnection, active: boolean): DesktopRemoteConnection {
  const state = active ? 'connected' : item.pending ? 'pairing' : 'disconnected'
  return { id: item.id, label: item.label, hostId: item.hostId, anchorSHA256: item.anchorSHA256, ssh: { ...item.ssh }, state,
    expiresAt: item.pending?.expiresAt ?? item.certificateExpiresAt ?? 0 }
}

export function validatePairingResponse(response: unknown, requestId: string, pairingId: string): Record<string, unknown> {
  if (!record(response) || response.protocolMajor !== 1 || response.requestId !== requestId ||
      !['pair.pending', 'pair.granted', 'pair.revoked', 'pair.denied'].includes(String(response.kind))) fail('desktop_protocol_mismatch')
  if (response.kind !== 'pair.denied' && response.pairingId !== pairingId) fail('desktop_protocol_mismatch')
  if (response.kind === 'pair.denied' && !text(response.code, 128)) fail('desktop_protocol_mismatch')
  return response
}

export function validateDeleteSessionResult(value: unknown): DeleteSessionResult {
  if (!record(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.deleted) || !Array.isArray(value.retained) || !Array.isArray(value.failed) ||
      value.deleted.some((item) => typeof item !== 'string') || value.retained.some((item) => typeof item !== 'string') ||
      value.failed.some((item) => !record(item) || !text(item.store, 256) || !text(item.error, 16_384)) ||
      (value.cancelled !== undefined && typeof value.cancelled !== 'boolean') || (value.reason !== undefined && !['invalid_request', 'active_session', 'user_cancelled', 'partial_failure'].includes(String(value.reason)))) fail('invalid_session_delete_response')
  return value as unknown as DeleteSessionResult
}

export function validateInfo(response: unknown, hostId: string): { providerDiscovery?: 2; directorySelection?: true; workbench?: 1; sessionActions?: true; sessionFork?: true; sessionDelete?: true; traceDelta?: 1; attachments?: DesktopAttachmentCapability } {
  if (!record(response) || !record(response.desktop) || response.desktop.kind !== 'info' || response.desktop.protocol !== 1 ||
      response.desktop.hostId !== hostId || response.desktop.execution !== 'canonical' ||
      (response.desktop.providerDiscovery !== undefined && response.desktop.providerDiscovery !== 2) ||
      (response.desktop.directorySelection !== undefined && response.desktop.directorySelection !== true) ||
      (response.desktop.workbench !== undefined && response.desktop.workbench !== 1) ||
      (response.desktop.sessionActions !== undefined && response.desktop.sessionActions !== true) ||
      (response.desktop.sessionFork !== undefined && response.desktop.sessionFork !== true) ||
      (response.desktop.sessionDelete !== undefined && response.desktop.sessionDelete !== true) ||
      (response.desktop.traceDelta !== undefined && response.desktop.traceDelta !== 1)) fail('desktop_capability_unavailable')
  const attachmentInfo = response.desktop.attachments
  if (attachmentInfo !== undefined && (!record(attachmentInfo) || attachmentInfo.transport !== 'chunked' || attachmentInfo.maxBytes !== DESKTOP_ATTACHMENT_MAX_BYTES || attachmentInfo.maxTotalBytes !== DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES || attachmentInfo.maxCount !== DESKTOP_ATTACHMENT_MAX_COUNT || attachmentInfo.chunkBytes !== DESKTOP_ATTACHMENT_CHUNK_BYTES)) fail('desktop_capability_unavailable')
  return {
    ...(response.desktop.providerDiscovery === 2 ? { providerDiscovery: 2 as const } : {}),
    ...(response.desktop.directorySelection === true ? { directorySelection: true as const } : {}),
    ...(response.desktop.workbench === 1 ? { workbench: 1 as const } : {}),
    ...(response.desktop.sessionActions === true ? { sessionActions: true as const } : {}),
    ...(response.desktop.sessionFork === true ? { sessionFork: true as const } : {}),
    ...(response.desktop.sessionDelete === true ? { sessionDelete: true as const } : {}),
    ...(response.desktop.traceDelta === 1 ? { traceDelta: 1 as const } : {}),
    ...(attachmentInfo ? { attachments: attachmentInfo as unknown as DesktopAttachmentCapability } : {})
  }
}

export function context(value: unknown): DesktopRemoteContext {
  if (!record(value) || !text(value.cwd, 16_384) || !text(value.providerId, 256) ||
      (value.agentProfileId !== undefined && !text(value.agentProfileId, 256)) ||
      (value.externalSessionId !== undefined && !text(value.externalSessionId, 256))) fail('invalid_context')
  return { cwd: value.cwd, providerId: value.providerId, ...(value.agentProfileId ? { agentProfileId: value.agentProfileId } : {}), ...(value.externalSessionId ? { externalSessionId: value.externalSessionId } : {}) }
}

export function validateCertificate(certificatePEM: unknown, anchorPEM: string, publicKeySHA256: string): { certificatePEM: string; certificateSHA256: string; expiresAt: number } {
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

export function validateTraceEvent(value: unknown): TraceEvent { if (!record(value) || !text(value.id, 256) || !text(value.ts, 128) || !text(value.runId, 128) || !text(value.kind, 128) || !text(value.stage, 256)) fail('invalid_trace_response'); return value as unknown as TraceEvent }
export function validateTurn(value: unknown): LoadedSessionTurn {
  if (!record(value) || (typeof value.userText !== 'string' || value.userText.length > 128_000) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) fail('invalid_history_response')
  if (value.runId !== undefined && !text(value.runId, 128) || value.providerTurnId !== undefined && !text(value.providerTurnId, 256) ||
      value.forkTurnId !== undefined && !text(value.forkTurnId, 256) || value.attachments !== undefined && !Array.isArray(value.attachments) ||
      value.done !== undefined && typeof value.done !== 'boolean' || value.error !== undefined && !pathText(value.error, 128_000) ||
      value.errorHint !== undefined && !pathText(value.errorHint, 128_000)) fail('invalid_history_response')
  return { userText: value.userText, items: value.items.map((item) => validateTraceEvent(item)),
    ...(text(value.runId, 128) ? { runId: value.runId } : {}), ...(text(value.providerTurnId, 256) ? { providerTurnId: value.providerTurnId } : {}),
    ...(text(value.forkTurnId, 256) ? { forkTurnId: value.forkTurnId } : {}), ...(Array.isArray(value.attachments) ? { attachments: value.attachments as LoadedSessionTurn['attachments'] } : {}),
    ...(typeof value.done === 'boolean' ? { done: value.done } : {}), ...(value.error !== undefined ? { error: value.error as string } : {}), ...(value.errorHint !== undefined ? { errorHint: value.errorHint as string } : {}) }
}
export function validateProject(value: unknown): RemoteProjectRef { if (!record(value) || !text(value.path, 16_384) || !text(value.label, 512)) fail('invalid_catalog_response'); return { path: value.path as string, label: value.label as string } }
export function validateProvider(value: unknown): RemoteProviderRef {
  if (!record(value) || !text(value.id, 256) || !text(value.label, 512) || typeof value.available !== 'boolean' || (value.observedAt !== undefined && !isRemoteProviderObservationTime(value.observedAt)) ||
      (value.metadataRevision !== undefined && (typeof value.metadataRevision !== 'number' || !Number.isSafeInteger(value.metadataRevision) || value.metadataRevision < 0))) fail('invalid_catalog_response')
  return value as unknown as RemoteProviderRef
}
export function validateSession(value: unknown): RemoteSessionRef {
  if (!record(value) || !text(value.sessionId, 256) || !text(value.providerId, 256) || !text(value.cwd, 16_384) || !text(value.label, 512) || !Number.isSafeInteger(value.ts) ||
      (value.externalSessionId !== undefined && !text(value.externalSessionId, 256)) || (value.agentProfileId !== undefined && !text(value.agentProfileId, 256)) ||
      (value.pinnedAt !== undefined && (!Number.isSafeInteger(value.pinnedAt) || Number(value.pinnedAt) <= 0)) || (value.archivedAt !== undefined && (!Number.isSafeInteger(value.archivedAt) || Number(value.archivedAt) <= 0)) ||
      (value.isActive !== undefined && typeof value.isActive !== 'boolean') || (value.pendingQuestions !== undefined && (!Number.isSafeInteger(value.pendingQuestions) || Number(value.pendingQuestions) < 0)) ||
      (value.lastRunId !== undefined && !text(value.lastRunId, 128)) || (value.lastRunOutcome !== undefined && !isRemoteSessionOutcome(value.lastRunOutcome))) fail('invalid_catalog_response')
  return value as unknown as RemoteSessionRef
}
