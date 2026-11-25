import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PairingAuthority, validatePairingState } from './pairing'
import type { DeviceGrant, IssuedPairingCertificate, PairingDependencies, PairingPersistence, PairingRecord, PairingState } from './pairing'
import { PairingFileStore } from './pairing-file'


const ANCHOR = 'c'.repeat(64)
const LOCAL_KEY = 'a'.repeat(64)
const PHONE_KEY = 'b'.repeat(64)
const TTL = 120_000
const T0 = 10_000_000
const hex = (prefix: string, index: number) => `${prefix.repeat(56)}${index.toString(16).padStart(8, '0')}`
const secretOf = (index: number) => `s${String(index).padStart(42, '0')}`
const verifier = (secret: string) => createHash('sha256').update(secret).digest('hex')

class MemoryStore implements PairingPersistence {
  value: PairingState | undefined
  failure = false
  commits = 0
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void {
    if (this.failure) throw new Error('injected_write_failure')
    this.commits += 1
    this.value = structuredClone(state)
  }
}

interface Seeded { grant: DeviceGrant; pairing: PairingRecord; secret: string }
// A grant and its `paired` record, as confirmLocal/enrollLocal would have written them.
function seedGrant(index: number, at: number, options: { scope?: 'local' | 'remote'; expiresAt?: number; revokedAt?: number | null } = {}): Seeded {
  const scope = options.scope ?? 'remote'
  const secret = secretOf(index)
  const pairingId = randomUUID()
  const deviceId = randomUUID()
  const grant: DeviceGrant = {
    certificatePEM: 'synthetic certificate, not cryptographic evidence', certificateSHA256: hex('e', index),
    publicKeySHA256: hex('f', index), deviceId, expiresAt: options.expiresAt ?? at + 3_600_000, pairingId,
    deviceLabel: `Phone ${index}`, authority: 'owner-device', source: scope === 'local' ? 'local_socket' : 'local_confirmation',
    scope, confirmedAt: at, revokedAt: options.revokedAt ?? null
  }
  const pairing: PairingRecord = { pairingId, secretVerifier: verifier(secret), createdAt: at, expiresAt: at + TTL, attempts: 0, state: 'paired', deviceId }
  return { grant, pairing, secret }
}
function seedFinished(index: number, at: number, state: 'cancelled' | 'expired' | 'rejected'): PairingRecord {
  return { pairingId: randomUUID(), secretVerifier: verifier(secretOf(index)), createdAt: at, expiresAt: at + TTL, attempts: state === 'rejected' ? 5 : 0, state }
}
function stateOf(hostId: string, grants: Seeded[], finished: PairingRecord[] = []): PairingState {
  return validatePairingState({ version: 1, hostId, anchorSHA256: ANCHOR, grants: grants.map(s => s.grant), pairings: [...grants.map(s => s.pairing), ...finished] })
}

function setup(store: PairingPersistence & { value?: PairingState } = new MemoryStore()) {
  const hostId = randomUUID()
  const time = { wall: T0 }
  let issued = 0
  const issue = vi.fn(async ({ deviceId, publicKeySHA256 }: { deviceId: string; publicKeySHA256: string }): Promise<IssuedPairingCertificate> => {
    issued += 1
    return { deviceId, certificatePEM: 'synthetic certificate', certificateSHA256: hex('9', issued), publicKeySHA256, expiresAt: time.wall + 3_600_000 }
  })
  const dependencies: PairingDependencies = { store, hostId, anchorSHA256: ANCHOR, clock: () => time.wall, monotonic: () => 0, issue,
    verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: 'd'.repeat(64), publicKeySHA256: csrPEM.includes('phone') ? PHONE_KEY : LOCAL_KEY })) }
  return { hostId, time, dependencies, open: () => new PairingAuthority(dependencies) }
}
const enroll = (authority: PairingAuthority) => authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => true)
const finishedOf = (state: PairingState) => state.pairings.filter(p => p.state === 'cancelled' || p.state === 'expired' || p.state === 'rejected')

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('pairing history cleanup (synthetic crypto adapter)', () => {
  it('frees a full table so a new invitation and the App\'s local re-enrollment succeed, in one commit each', async () => {
    const store = new MemoryStore()
    const { hostId, time, open } = setup(store)
    const local = seedGrant(0, T0 - 5_000, { scope: 'local' })
    const live = [1, 2].map(i => seedGrant(i, T0 - 5_000))
    // Live at start-up, expired by the time the operator invites another device.
    const lapsing = Array.from({ length: 61 }, (_, i) => seedGrant(10 + i, T0 - 5_000 + i, { expiresAt: T0 + 1_000 + i }))
    store.value = stateOf(hostId, [local, ...live, ...lapsing])
    expect(store.value.grants).toHaveLength(64)
    const authority = open()
    expect(store.commits).toBe(0)
    time.wall = T0 + 10_000

    const invitation = await authority.begin()
    expect(store.commits).toBe(1)
    const state = authority.inspectLocal()
    expect(state.grants).toHaveLength(3 + 16)
    expect(state.grants.filter(g => lapsing.some(s => s.grant.deviceId === g.deviceId)).map(g => g.deviceId))
      .toEqual(lapsing.slice(-16).map(s => s.grant.deviceId))
    expect(state.pairings.filter(p => p.state === 'paired')).toHaveLength(state.grants.length)
    for (const s of [local, ...live]) expect(state.grants).toContainEqual(s.grant)
    expect(authority.authorizesCertificate(local.grant.certificateSHA256, 'local')).toBe(true)
    for (const s of live) {
      expect(authority.authorizesCertificate(s.grant.certificateSHA256, 'network')).toBe(true)
      // Claims follow host state, not the long-expired invitation window.
      expect(await authority.status(s.grant.pairingId, s.secret, s.grant.publicKeySHA256)).toEqual({ state: 'paired', grant: s.grant })
    }
    for (const s of lapsing) expect(authority.authorizesCertificate(s.grant.certificateSHA256)).toBe(false)

    const proved = await authority.prove({ pairingId: invitation.pairingId, secret: invitation.secret, csrPEM: 'CSR phone', deviceLabel: 'New phone' }, PHONE_KEY)
    expect(proved.state).toBe('awaiting_local_confirmation')
    const phone = await authority.confirmLocal(invitation.pairingId, PHONE_KEY)
    expect(authority.authorizesCertificate(phone.certificateSHA256, 'network')).toBe(true)

    const enrolled = await enroll(authority)
    expect(authority.authorizesCertificate(enrolled.certificateSHA256, 'local')).toBe(true)
    expect(authority.authorizesCertificate(local.grant.certificateSHA256)).toBe(false)
    expect(validatePairingState(structuredClone(store.value))).toEqual(authority.inspectLocal())
  })

  it('keeps inviting and re-enrolling past 64 through the real operations, without touching a pending invitation', async () => {
    const { open } = setup()
    const authority = open()
    for (let i = 0; i < 80; i++) await authority.begin()
    expect(finishedOf(authority.inspectLocal()).length).toBeLessThanOrEqual(17)
    const pending = await authority.begin()
    for (let i = 0; i < 80; i++) await enroll(authority)
    const state = authority.inspectLocal()
    expect(state.grants.filter(g => g.revokedAt !== null).length).toBeLessThanOrEqual(17)
    expect(state.grants.filter(g => g.scope === 'local' && g.revokedAt === null)).toHaveLength(1)
    expect(state.pairings.find(p => p.pairingId === pending.pairingId)?.state).toBe('created')
    await authority.prove({ pairingId: pending.pairingId, secret: pending.secret, csrPEM: 'CSR phone', deviceLabel: 'Phone' }, PHONE_KEY)
    const grant = await authority.confirmLocal(pending.pairingId, PHONE_KEY)
    expect(await authority.status(pending.pairingId, pending.secret, PHONE_KEY)).toEqual({ state: 'paired', grant })
  })

  it('never resurrects a revoked or lapsed device: a removed record cannot be used to claim or authorize', async () => {
    const store = new MemoryStore()
    const { hostId, open } = setup(store)
    const revoked = Array.from({ length: 20 }, (_, i) => seedGrant(i, T0 - 900_000 + i, { revokedAt: T0 - 800_000 + i }))
    const lapsed = seedGrant(30, T0 - 990_000, { expiresAt: T0 - 980_000 })
    const live = seedGrant(31, T0 - 990_000)
    store.value = stateOf(hostId, [lapsed, ...revoked, live])
    const authority = open()
    expect(store.commits).toBe(1)
    const removed = [lapsed, ...revoked.slice(0, 4)]
    const kept = revoked.slice(4)
    const state = authority.inspectLocal()
    expect(state.grants.map(g => g.deviceId)).toEqual([...kept, live].map(s => s.grant.deviceId))
    for (const s of removed) {
      const { pairingId } = s.grant
      await expect(authority.status(pairingId, s.secret, s.grant.publicKeySHA256)).rejects.toThrow('unknown_pairing')
      await expect(authority.prove({ pairingId, secret: s.secret, csrPEM: 'CSR phone', deviceLabel: 'x' }, PHONE_KEY)).rejects.toThrow('unknown_pairing')
      await expect(authority.confirmLocal(pairingId, s.grant.publicKeySHA256)).rejects.toThrow('unknown_pairing')
      await expect(authority.revoke(s.grant.deviceId)).rejects.toThrow('unknown_device')
      expect(authority.authorizesCertificate(s.grant.certificateSHA256)).toBe(false)
    }
    for (const s of kept) {
      expect(await authority.status(s.grant.pairingId, s.secret, s.grant.publicKeySHA256)).toEqual({ state: 'revoked', deviceId: s.grant.deviceId })
      await expect(authority.confirmLocal(s.grant.pairingId, s.grant.publicKeySHA256)).rejects.toThrow('device_revoked')
      expect(authority.authorizesCertificate(s.grant.certificateSHA256)).toBe(false)
    }
    expect(state.grants.filter(g => g.revokedAt === null).map(g => g.deviceId)).toEqual([live.grant.deviceId])
    expect(await authority.status(live.grant.pairingId, live.secret, live.grant.publicKeySHA256)).toEqual({ state: 'paired', grant: live.grant })
  })

  it('cleans at start-up in the existing file format, keeps the newest 16 of each kind and the current local grant', async () => {
    const path = mkdtempSync(join(tmpdir(), 'scry-pairing-retention-'))
    directories.push(path)
    const seedStore = new PairingFileStore(path)
    const { hostId, dependencies } = setup(seedStore)
    // The App's current local grant has lapsed but is still the one it holds: kept.
    const local = seedGrant(0, T0 - 9_000_000, { scope: 'local', expiresAt: T0 - 5_000_000 })
    const revoked = Array.from({ length: 20 }, (_, i) => seedGrant(1 + i, T0 - 900_000 + i, { revokedAt: T0 - 100_000 - i }))
    const finished = Array.from({ length: 30 }, (_, i) => seedFinished(100 + i, T0 - 800_000 + i * 1_000, (['cancelled', 'expired', 'rejected'] as const)[i % 3]))
    const original = stateOf(hostId, [local, ...revoked], finished)
    seedStore.commit(original)
    seedStore.close()

    const reopened = new PairingFileStore(path)
    const commit = vi.spyOn(reopened, 'commit')
    const authority = new PairingAuthority({ ...dependencies, store: reopened })
    expect(commit).toHaveBeenCalledTimes(1)
    const state = authority.inspectLocal()
    expect(state.grants[0]).toEqual(local.grant)
    // Ranked by when each grant stopped working: revokedAt here, newest first in the seed.
    expect(state.grants.slice(1).map(g => g.deviceId)).toEqual(revoked.slice(0, 16).map(s => s.grant.deviceId))
    expect(finishedOf(state)).toEqual(finished.slice(-16))
    authority.close()
    reopened.close()

    // The saved file passes the current validator and contains only grant and
    // pairing entries from the original state.
    const reader = new PairingFileStore(path)
    try {
      const loaded = reader.load() as Record<string, unknown>
      expect(Object.keys(loaded).sort()).toEqual(Object.keys(original).sort())
      const checked = validatePairingState(loaded)
      expect(checked).toEqual(state)
      for (const g of checked.grants) expect(original.grants).toContainEqual(g)
      for (const p of checked.pairings) expect(original.pairings).toContainEqual(p)
      const again = vi.spyOn(reader, 'commit')
      new PairingAuthority({ ...dependencies, store: reader }).close()
      expect(again).not.toHaveBeenCalled()
    } finally { reader.close() }
  })

  it('a failed write keeps the previous state and fences the authority, never a partial cleanup', async () => {
    const store = new MemoryStore()
    const { hostId, time, open } = setup(store)
    const seeded = Array.from({ length: 64 }, (_, i) => seedGrant(i, T0 - 5_000 + i, i === 0 ? {} : { expiresAt: T0 + 1_000 }))
    store.value = stateOf(hostId, seeded)
    const authority = open()
    const before = structuredClone(store.value)
    time.wall = T0 + 10_000
    store.failure = true
    await expect(authority.begin()).rejects.toThrow('injected_write_failure')
    expect(store.value).toEqual(before)
    await expect(enroll(authority)).rejects.toThrow('pairing_storage_unavailable')
    expect(authority.authorizesCertificate(seeded[0].grant.certificateSHA256)).toBe(false)
  })
})
