// Shape of the persisted pairing file plus its validation. Kept apart from the
// PairingAuthority state machine on purpose: this file only answers "is this document
// a valid pairing state?", which is exactly what a corrupted, hand-edited or
// downgraded file must fail, and it stays pure so it can be tested alone.
import { createHash } from 'node:crypto'

export interface VerifiedPairingCSR {
  csrPEM: string
  csrSHA256: string
  publicKeySHA256: string
}
export interface IssuedPairingCertificate {
  certificatePEM: string
  certificateSHA256: string
  publicKeySHA256: string
  deviceId: string
  expiresAt: number
}
export interface PairBase {
  pairingId: string
  secretVerifier: string
  createdAt: number
  expiresAt: number
  attempts: number
}
export type DeviceProof = VerifiedPairingCSR & { deviceLabel: string }
export type PairingRecord = PairBase & (
  | { state: 'created' }
  | { state: 'awaiting_local_confirmation'; proof: DeviceProof }
  | { state: 'paired'; deviceId: string }
  | { state: 'expired' | 'cancelled' | 'rejected' }
)
export interface DeviceGrant extends IssuedPairingCertificate {
  pairingId: string
  deviceLabel: string
  authority: 'owner-device'
  // 'local_socket' means the grant was issued over the daemon's unix socket after
  // the caller proved it could read the 0600 enrollment secret as this user. Such a
  // grant is only honored on that socket: the network host rejects it outright.
  source: 'local_confirmation' | 'local_socket'
  scope: GrantScope
  confirmedAt: number
  revokedAt: number | null
}
export type GrantScope = 'local' | 'remote'
// Which channel accepted the connection. `network` covers TCP listeners, the relay
// tunnel and SSH; `local` is the 0700/0600 unix socket inside the daemon state dir.
export type GrantTransport = 'local' | 'network'
export interface PairingState {
  version: 1
  hostId: string
  anchorSHA256: string
  pairings: PairingRecord[]
  grants: DeviceGrant[]
}
export interface PairingPersistence {
  assertAvailable(): void
  load(): unknown
  // Returning means the complete snapshot was durably committed. Never use a
  // backup fallback: it could restore a consumed secret or a revoked grant.
  commit(state: PairingState): void
}
export interface PairingDependencies {
  store: PairingPersistence
  hostId: string
  anchorSHA256: string
  verifyCSR(csrPEM: string): Promise<VerifiedPairingCSR>
  issue(input: VerifiedPairingCSR & { deviceId: string }): Promise<IssuedPairingCertificate>
  clock?: () => number
  monotonic?: () => number
}
export type PairingReceipt =
  | { state: 'awaiting_local_confirmation'; pairingId: string; publicKeySHA256: string }
  | { state: 'paired'; grant: DeviceGrant }
  | { state: 'revoked'; deviceId: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const HASH = /^[0-9a-f]{64}$/
export const SECRET = /^[A-Za-z0-9_-]{43}$/
export const TTL = 120_000
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function fail(code: string): never { throw new Error(code) }
export const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max
export const validDeviceLabel = (value: unknown): value is string => text(value, 320) && [...value].length <= 80 &&
  !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const keys = (value: Record<string, unknown>, expected: string[]) => {
  if (Object.keys(value).sort().join('\0') !== expected.sort().join('\0')) fail('invalid_pairing_state')
}

export function base(pairing: PairBase): PairBase {
  return { pairingId: pairing.pairingId, secretVerifier: pairing.secretVerifier, createdAt: pairing.createdAt, expiresAt: pairing.expiresAt, attempts: pairing.attempts }
}

export function validatePairingState(value: unknown): PairingState {
  if (!record(value)) return fail('invalid_pairing_state')
  keys(value, ['version', 'hostId', 'anchorSHA256', 'pairings', 'grants'])
  if (value.version !== 1 || typeof value.hostId !== 'string' || !UUID.test(value.hostId) || typeof value.anchorSHA256 !== 'string' || !HASH.test(value.anchorSHA256) ||
      !Array.isArray(value.pairings) || value.pairings.length > 64 || !Array.isArray(value.grants) || value.grants.length > 64) return fail('invalid_pairing_state')
  const grants: DeviceGrant[] = value.grants.map((raw: unknown) => {
    if (!record(raw)) return fail('invalid_pairing_state')
    // State written before scopes existed only ever held owner-confirmed phone
    // grants, so a missing scope means 'remote' rather than invalid.
    const g = raw.scope === undefined ? { ...raw, scope: 'remote' } : raw
    keys(g, ['certificatePEM', 'certificateSHA256', 'publicKeySHA256', 'deviceId', 'expiresAt', 'pairingId', 'deviceLabel', 'authority', 'source', 'scope', 'confirmedAt', 'revokedAt'])
    if (g.authority !== 'owner-device' || (g.source !== 'local_confirmation' && g.source !== 'local_socket') ||
        (g.scope !== 'local' && g.scope !== 'remote') || (g.scope === 'local') !== (g.source === 'local_socket') ||
        !text(g.certificatePEM, 16_384) || !validDeviceLabel(g.deviceLabel) ||
        typeof g.deviceId !== 'string' || !UUID.test(g.deviceId) || typeof g.pairingId !== 'string' || !UUID.test(g.pairingId) ||
        typeof g.certificateSHA256 !== 'string' || !HASH.test(g.certificateSHA256) || typeof g.publicKeySHA256 !== 'string' || !HASH.test(g.publicKeySHA256) ||
        !isTime(g.expiresAt) || !isTime(g.confirmedAt) || g.expiresAt <= g.confirmedAt || (g.revokedAt !== null && !isTime(g.revokedAt))) return fail('invalid_pairing_state')
    return { certificatePEM: g.certificatePEM, certificateSHA256: g.certificateSHA256, publicKeySHA256: g.publicKeySHA256, deviceId: g.deviceId,
      expiresAt: g.expiresAt, pairingId: g.pairingId, deviceLabel: g.deviceLabel, authority: g.authority, source: g.source, scope: g.scope, confirmedAt: g.confirmedAt, revokedAt: g.revokedAt }
  })
  const pairings: PairingRecord[] = value.pairings.map((p: unknown) => {
    if (!record(p)) return fail('invalid_pairing_state')
    const fields = ['pairingId', 'secretVerifier', 'createdAt', 'expiresAt', 'attempts', 'state']
    keys(p, [...fields, ...(p.state === 'paired' ? ['deviceId'] : p.state === 'awaiting_local_confirmation' ? ['proof'] : [])])
    if (typeof p.pairingId !== 'string' || !UUID.test(p.pairingId) || typeof p.secretVerifier !== 'string' || !HASH.test(p.secretVerifier) ||
        !isTime(p.createdAt) || !isTime(p.expiresAt) || p.expiresAt - p.createdAt !== TTL || !isTime(p.attempts) || p.attempts > 5) return fail('invalid_pairing_state')
    const common: PairBase = { pairingId: p.pairingId, secretVerifier: p.secretVerifier, createdAt: p.createdAt, expiresAt: p.expiresAt, attempts: p.attempts }
    if (p.state === 'created' || p.state === 'cancelled' || p.state === 'expired' || p.state === 'rejected') return { ...common, state: p.state }
    if (p.state === 'paired' && typeof p.deviceId === 'string' && grants.some(g => g.deviceId === p.deviceId && g.pairingId === p.pairingId)) return { ...common, state: 'paired', deviceId: p.deviceId }
    if (p.state === 'awaiting_local_confirmation' && record(p.proof)) {
      keys(p.proof, ['csrPEM', 'csrSHA256', 'publicKeySHA256', 'deviceLabel'])
      const proof = p.proof
      if (text(proof.csrPEM, 16_384) && validDeviceLabel(proof.deviceLabel) && typeof proof.csrSHA256 === 'string' && HASH.test(proof.csrSHA256) && typeof proof.publicKeySHA256 === 'string' && HASH.test(proof.publicKeySHA256)) {
        return { ...common, state: 'awaiting_local_confirmation', proof: { csrPEM: proof.csrPEM, csrSHA256: proof.csrSHA256, publicKeySHA256: proof.publicKeySHA256, deviceLabel: proof.deviceLabel } }
      }
    }
    return fail('invalid_pairing_state')
  })
  // publicKeySHA256 uniqueness applies only to ACTIVE grants: a revoked grant is
  // retained for audit history and may share a device key with a new active grant
  // issued after the same device re-pairs. deviceId and certificateSHA256 stay
  // globally unique (each issuance mints a distinct cert).
  const activeKeys = grants.filter(g => g.revokedAt === null).map(g => g.publicKeySHA256)
  if (new Set(pairings.map(p => p.pairingId)).size !== pairings.length || new Set(grants.map(g => g.deviceId)).size !== grants.length ||
      new Set(activeKeys).size !== activeKeys.length || new Set(grants.map(g => g.certificateSHA256)).size !== grants.length ||
      grants.some(g => !pairings.some(p => p.state === 'paired' && p.deviceId === g.deviceId && p.pairingId === g.pairingId))) fail('invalid_pairing_state')
  return { version: 1, hostId: value.hostId, anchorSHA256: value.anchorSHA256, pairings, grants }
}
