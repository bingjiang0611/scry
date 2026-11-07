import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  HASH, SECRET, TTL, UUID, base, digest, fail, isTime, text, validatePairingState, validDeviceLabel,
  type DeviceGrant, type GrantTransport, type PairingDependencies, type PairingRecord, type PairingReceipt, type PairingState
} from './pairing-state'

// Re-exported so the persisted-shape names keep one owner (pairing-state) while
// callers keep importing them from the authority module they already use.
export type {
  DeviceGrant, GrantScope, GrantTransport, IssuedPairingCertificate, PairingDependencies,
  PairingPersistence, PairingReceipt, PairingRecord, PairingState, VerifiedPairingCSR
} from './pairing-state'
export { validatePairingState } from './pairing-state'

// This module has no IPC registration, network listener, Provider or file API.
// Only a trusted local UI/controller may call begin/confirmLocal/cancel/revoke.
// Remote prove/status must receive the peer key fingerprint from verified TLS
// private-key possession, never from a JSON actor/device field.
export class PairingAuthority {
  private data: PairingState
  private unavailable: 'pairing_storage_unavailable' | 'pairing_authority_closed' | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private readonly deadlines = new Map<string, number>()
  private readonly cancelled = new Set<string>()
  private readonly deniedDevices = new Set<string>()
  private readonly clock: () => number
  private readonly monotonic: () => number
  private readonly dependencies: PairingDependencies

  constructor(dependencies: PairingDependencies) {
    this.dependencies = dependencies
    if (!UUID.test(dependencies.hostId) || !HASH.test(dependencies.anchorSHA256)) fail('invalid_host_identity')
    this.clock = dependencies.clock ?? Date.now
    this.monotonic = dependencies.monotonic ?? (() => performance.now())
    const loaded = dependencies.store.load()
    this.data = loaded === undefined
      ? { version: 1, hostId: dependencies.hostId, anchorSHA256: dependencies.anchorSHA256, pairings: [], grants: [] }
      : validatePairingState(loaded)
    if (this.data.hostId !== dependencies.hostId || this.data.anchorSHA256 !== dependencies.anchorSHA256) fail('host_identity_changed')
    // Pending exchanges do not survive host restart. Completed transactions do,
    // so a lost receipt can be reconciled without creating another device.
    const pending = this.data.pairings.some(p => p.state === 'created' || p.state === 'awaiting_local_confirmation')
    if (pending) this.persist({ ...this.data, pairings: this.data.pairings.map(p =>
      p.state === 'created' || p.state === 'awaiting_local_confirmation' ? { ...base(p), state: 'expired' } : p) })
  }

  begin(): Promise<{ pairingId: string; secret: string; hostId: string; anchorSHA256: string; expiresAt: number }> {
    return this.serial(async () => {
      if (this.data.pairings.length >= 64 || this.data.grants.length >= 64) fail('pairing_capacity_exceeded')
      const now = this.now()
      const monotonic = this.monotonic()
      if (!Number.isFinite(monotonic) || monotonic < 0) fail('invalid_clock')
      const secret = randomBytes(32).toString('base64url')
      const pairingId = randomUUID()
      const pairing: PairingRecord = { pairingId, secretVerifier: digest(secret), createdAt: now, expiresAt: now + TTL, attempts: 0, state: 'created' }
      const pairings = this.data.pairings.map(p => p.state === 'created' || p.state === 'awaiting_local_confirmation'
        ? { ...base(p), state: 'cancelled' as const } : p)
      this.persist({ ...this.data, pairings: [...pairings, pairing] })
      this.deadlines.set(pairingId, monotonic + TTL)
      return { pairingId, secret, hostId: this.data.hostId, anchorSHA256: this.data.anchorSHA256, expiresAt: pairing.expiresAt }
    })
  }

  prove(input: { pairingId: string; secret: string; csrPEM: string; deviceLabel: string }, tlsPeerPublicKeySHA256: string): Promise<PairingReceipt> {
    return this.serial(async () => {
      let pairing = this.authenticate(input.pairingId, input.secret)
      if (typeof tlsPeerPublicKeySHA256 !== 'string' || !HASH.test(tlsPeerPublicKeySHA256) || !text(input.csrPEM, 16_384) || !validDeviceLabel(input.deviceLabel)) fail('invalid_device_proof')
      const proof = await this.dependencies.verifyCSR(input.csrPEM)
      if (proof.publicKeySHA256 !== tlsPeerPublicKeySHA256 || !HASH.test(proof.csrSHA256)) fail('channel_key_mismatch')
      pairing = this.authenticate(input.pairingId, input.secret)
      if (pairing.state === 'paired') return this.receipt(pairing, tlsPeerPublicKeySHA256)
      this.active(pairing)
      if (pairing.state === 'awaiting_local_confirmation') {
        if (pairing.proof.csrSHA256 !== proof.csrSHA256 || pairing.proof.publicKeySHA256 !== proof.publicKeySHA256) fail('pairing_candidate_changed')
      } else {
        // Only an ACTIVE grant blocks a fresh pairing. A revoked device may
        // re-pair, since revocation means "removed, requires re-approval" and a
        // new pairing still needs the operator to re-scan and re-confirm; a
        // revoked grant's key must not permanently ban the device.
        const now = this.now()
        if (this.data.grants.some(g => g.publicKeySHA256 === proof.publicKeySHA256 && g.revokedAt === null && g.expiresAt > now)) fail('device_key_already_registered')
        pairing = { ...base(pairing), state: 'awaiting_local_confirmation', proof: { ...proof, deviceLabel: input.deviceLabel } }
        this.replace(pairing)
      }
      return { state: 'awaiting_local_confirmation', pairingId: pairing.pairingId, publicKeySHA256: proof.publicKeySHA256 }
    })
  }

  status(pairingId: string, secret: string, tlsPeerPublicKeySHA256: string): Promise<PairingReceipt> {
    return this.serial(async () => {
      const pairing = this.authenticate(pairingId, secret)
      if (pairing.state === 'paired') return this.receipt(pairing, tlsPeerPublicKeySHA256)
      this.active(pairing)
      if (pairing.state !== 'awaiting_local_confirmation' || pairing.proof.publicKeySHA256 !== tlsPeerPublicKeySHA256) fail('device_proof_required')
      return { state: 'awaiting_local_confirmation', pairingId, publicKeySHA256: tlsPeerPublicKeySHA256 }
    })
  }

  confirmLocal(pairingId: string, expectedPublicKeySHA256: string): Promise<DeviceGrant> {
    return this.serial(async () => {
      let pairing = this.find(pairingId)
      if (pairing.state === 'paired') {
        const receipt = this.receipt(pairing, expectedPublicKeySHA256)
        if (receipt.state !== 'paired') fail('device_revoked')
        return structuredClone(receipt.grant)
      }
      this.active(pairing)
      if (pairing.state !== 'awaiting_local_confirmation' || pairing.proof.publicKeySHA256 !== expectedPublicKeySHA256) fail('local_confirmation_mismatch')
      const proof = pairing.proof
      const deviceId = randomUUID()
      const certificate = await this.dependencies.issue({ ...proof, deviceId })
      pairing = this.find(pairingId)
      this.active(pairing)
      if (pairing.state !== 'awaiting_local_confirmation' || pairing.proof.csrSHA256 !== proof.csrSHA256) fail('pairing_candidate_changed')
      if (certificate.deviceId !== deviceId || certificate.publicKeySHA256 !== proof.publicKeySHA256 ||
          !HASH.test(certificate.certificateSHA256) || !text(certificate.certificatePEM, 16_384) ||
          !isTime(certificate.expiresAt) || certificate.expiresAt <= this.now()) fail('invalid_issued_identity')
      const confirmedAt = this.now()
      const grant: DeviceGrant = { ...certificate, pairingId, deviceLabel: proof.deviceLabel, authority: 'owner-device',
        source: 'local_confirmation', scope: 'remote', confirmedAt, revokedAt: null }
      // Retire an expired grant for this same key in the SAME transaction. State
      // validation intentionally forbids two unrevoked grants for one key; an
      // expired certificate must be renewable without weakening that invariant.
      const prior = this.data.grants.map(g =>
        g.publicKeySHA256 === proof.publicKeySHA256 && g.revokedAt === null && g.expiresAt <= confirmedAt
          ? { ...g, revokedAt: confirmedAt } : g)
      // One fsynced transaction creates the grant AND consumes the secret. The
      // certificate cannot leave this method on a failed/unknown commit.
      this.persist({ ...this.data, grants: [...prior, grant], pairings: this.data.pairings.map(p =>
        p.pairingId === pairingId ? { ...base(p), state: 'paired', deviceId } : p) })
      return structuredClone(grant)
    })
  }

  cancel(pairingId: string): Promise<void> {
    const existing = this.data.pairings.find(p => p.pairingId === pairingId)
    if (!existing) return Promise.reject(new Error('unknown_pairing'))
    if (existing.state === 'paired') return Promise.reject(new Error('use_device_revocation'))
    this.cancelled.add(pairingId) // Cancels a signer awaiting crypto completion too.
    return this.serial(async () => {
      const pairing = this.find(pairingId)
      if (pairing.state === 'paired') fail('use_device_revocation')
      this.replace({ ...base(pairing), state: 'cancelled' })
    })
  }

  revoke(deviceId: string): Promise<void> {
    if (!this.data.grants.some(g => g.deviceId === deviceId)) return Promise.reject(new Error('unknown_device'))
    this.deniedDevices.add(deviceId) // New calls fail even while persistence is pending.
    return this.serial(async () => {
      const grant = this.data.grants.find(g => g.deviceId === deviceId)
      if (!grant) fail('unknown_device')
      if (grant.revokedAt !== null) return
      this.persist({ ...this.data, grants: this.data.grants.map(g => g.deviceId === deviceId ? { ...g, revokedAt: this.now() } : g) })
    })
  }

  // Self-reported display metadata, not hardware attestation or a new authorization.
  // Only the verified peer certificate may select the existing grant to update.
  updateDeviceLabel(certificateSHA256: string, deviceLabel: unknown): Promise<void> {
    return this.serial(async () => {
      const grant = this.data.grants.find(g => g.certificateSHA256 === certificateSHA256)
      if (!grant || !this.authorizesCertificate(certificateSHA256)) fail('device_not_authorized')
      if (!validDeviceLabel(deviceLabel)) fail('invalid_device_label')
      if (grant.deviceLabel === deviceLabel) return
      this.persist({ ...this.data, grants: this.data.grants.map(g => g.deviceId === grant.deviceId ? { ...g, deviceLabel } : g) })
    })
  }

  /**
   * Enroll the App itself. The proof is: the caller could read the 0600 enrollment
   * secret as this user AND could produce a CSR signed by the key it will present in
   * mTLS. Both sides are already on the same machine, so there is no second human
   * confirmation step - the daemon issues the grant inside this transaction.
   *
   * `consumeSecret` runs inside the serialized transaction and must return false on
   * reuse, so a burned secret cannot be turned into a second grant and a bad CSR
   * cannot burn the secret before it is validated.
   *
   * Only one local grant stays active: enrolling again revokes the previous one.
   */
  enrollLocal(input: { csrPEM: string; deviceLabel: string }, consumeSecret: () => boolean): Promise<DeviceGrant> {
    return this.serial(async () => {
      if (!text(input.csrPEM, 16_384) || !validDeviceLabel(input.deviceLabel)) fail('invalid_device_proof')
      const proof = await this.dependencies.verifyCSR(input.csrPEM)
      if (!HASH.test(proof.csrSHA256) || !HASH.test(proof.publicKeySHA256)) fail('invalid_device_proof')
      if (!consumeSecret()) fail('local_enrollment_secret_invalid')
      this.available()
      const now = this.now()
      if (this.data.pairings.length >= 64 || this.data.grants.length >= 64) fail('pairing_capacity_exceeded')
      const deviceId = randomUUID()
      const certificate = await this.dependencies.issue({ ...proof, deviceId })
      this.available()
      const confirmedAt = this.now()
      if (certificate.deviceId !== deviceId || certificate.publicKeySHA256 !== proof.publicKeySHA256 ||
          !HASH.test(certificate.certificateSHA256) || !text(certificate.certificatePEM, 16_384) ||
          !isTime(certificate.expiresAt) || certificate.expiresAt <= confirmedAt) fail('invalid_issued_identity')
      const pairingId = randomUUID()
      const grant: DeviceGrant = { ...certificate, pairingId, deviceLabel: input.deviceLabel, authority: 'owner-device',
        source: 'local_socket', scope: 'local', confirmedAt, revokedAt: null }
      // One local caller at a time: a new enrollment replaces the previous grant.
      const grants = this.data.grants.map(g =>
        g.scope === 'local' && g.revokedAt === null ? { ...g, revokedAt: confirmedAt } : g)
      const pairing: PairingRecord = { pairingId, secretVerifier: digest(`local-enrollment:${deviceId}`), createdAt: now,
        expiresAt: now + TTL, attempts: 0, state: 'paired', deviceId }
      this.persist({ ...this.data, grants: [...grants, grant], pairings: [...this.data.pairings, pairing] })
      return structuredClone(grant)
    })
  }

  /**
   * @param transport how the peer was authenticated. Omitting it means "the caller is
   * trusted code asking whether the grant is live at all" (pairing bookkeeping,
   * gateway internals). A network listener must pass 'network' so a locally-issued
   * grant cannot be replayed over TCP, the relay or SSH.
   */
  authorizesCertificate(certificateSHA256: string, transport?: GrantTransport): boolean {
    if (typeof certificateSHA256 !== 'string' || !HASH.test(certificateSHA256)) return false
    try { this.available() } catch { return false }
    const now = this.clock()
    return isTime(now) && this.data.grants.some(g => g.certificateSHA256 === certificateSHA256 && g.revokedAt === null &&
      !this.deniedDevices.has(g.deviceId) && g.expiresAt > now &&
      (transport !== 'network' || g.scope === 'remote'))
  }

  close(): void { this.unavailable ??= 'pairing_authority_closed' }

  inspectLocal(): PairingState {
    this.available()
    return structuredClone(this.data)
  }

  private available(): void {
    if (this.unavailable) fail(this.unavailable)
    try { this.dependencies.store.assertAvailable() }
    catch (error) { this.unavailable = 'pairing_storage_unavailable'; throw error }
  }
  private now(): number { const now = this.clock(); if (!isTime(now)) fail('invalid_clock'); return now }
  private find(id: string): PairingRecord { this.available(); return this.data.pairings.find(p => p.pairingId === id) ?? fail('unknown_pairing') }
  private active(pairing: PairingRecord): void {
    this.available()
    const deadline = this.deadlines.get(pairing.pairingId)
    const monotonic = this.monotonic()
    if (this.cancelled.has(pairing.pairingId) || (pairing.state !== 'created' && pairing.state !== 'awaiting_local_confirmation')) fail('pairing_not_active')
    if (deadline === undefined || !Number.isFinite(monotonic) || monotonic < 0 || monotonic >= deadline || this.now() >= pairing.expiresAt) fail('pairing_expired')
  }
  private authenticate(id: string, secret: string): PairingRecord {
    if (typeof id !== 'string' || !UUID.test(id) || typeof secret !== 'string' || !SECRET.test(secret)) fail('invalid_pairing_proof')
    const pairing = this.find(id)
    if (pairing.state !== 'paired') this.active(pairing)
    if (!timingSafeEqual(Buffer.from(pairing.secretVerifier, 'hex'), Buffer.from(digest(secret), 'hex'))) {
      if (pairing.state !== 'paired') {
        const attempts = pairing.attempts + 1
        this.replace(attempts >= 5 ? { ...base(pairing), attempts, state: 'rejected' } : { ...pairing, attempts })
      }
      fail('invalid_pairing_proof')
    }
    return pairing
  }
  private receipt(pairing: PairingRecord & { state: 'paired' }, peer: string): PairingReceipt {
    const grant = this.data.grants.find(g => g.deviceId === pairing.deviceId)
    if (!grant || grant.publicKeySHA256 !== peer) fail('channel_key_mismatch')
    return grant.revokedAt !== null || this.deniedDevices.has(grant.deviceId)
      ? { state: 'revoked', deviceId: grant.deviceId } : { state: 'paired', grant: structuredClone(grant) }
  }
  private replace(pairing: PairingRecord): void {
    this.persist({ ...this.data, pairings: this.data.pairings.map(p => p.pairingId === pairing.pairingId ? pairing : p) })
  }
  private persist(next: PairingState): void {
    this.available()
    try {
      const checked = validatePairingState(next)
      this.dependencies.store.commit(checked)
      this.data = structuredClone(checked)
    } catch (error) { this.unavailable = 'pairing_storage_unavailable'; throw error }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { this.available(); return operation() })
    this.tail = result.catch(() => {})
    return result
  }
}
