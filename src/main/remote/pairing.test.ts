import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PairingAuthority, validatePairingState } from './pairing'
import type { IssuedPairingCertificate, PairingDependencies, PairingPersistence, PairingState } from './pairing'
import { PairingFileStore } from './pairing-file'

const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
const CERT = 'd'.repeat(64)
class MemoryStore implements PairingPersistence {
  value: PairingState | undefined
  failure: 'before' | 'after' | undefined
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void {
    if (this.failure === 'before') throw new Error('injected_write_failure')
    this.value = structuredClone(state)
    if (this.failure === 'after') throw new Error('injected_receipt_lost')
  }
}
function setup(store: PairingPersistence = new MemoryStore()) {
  const time = { wall: 1_000_000, monotonic: 0 }
  const issue = vi.fn(async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({
    deviceId, certificatePEM: 'synthetic certificate, not cryptographic evidence', certificateSHA256: CERT,
    publicKeySHA256: KEY, expiresAt: time.wall + 3_600_000
  }))
  const dependencies: PairingDependencies = { store, hostId: randomUUID(), anchorSHA256: ANCHOR,
    clock: () => time.wall, monotonic: () => time.monotonic,
    verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })), issue }
  return { authority: new PairingAuthority(dependencies), dependencies, issue, time }
}
async function pending(authority: PairingAuthority) {
  const pairing = await authority.begin()
  const input = { pairingId: pairing.pairingId, secret: pairing.secret, csrPEM: 'synthetic CSR', deviceLabel: 'Test iPhone' }
  await authority.prove(input, KEY)
  return { pairing, input }
}
const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'scry-pairing-test-'))
  directories.push(path)
  return path
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('pairing authority (synthetic crypto adapter; no human or Provider execution)', () => {
  it('keeps only a secret verifier and cannot grant before proof + matching local confirmation', async () => {
    const store = new MemoryStore()
    const { authority, issue } = setup(store)
    const pair = await authority.begin()
    expect(JSON.stringify(store.value)).not.toContain(pair.secret)
    await expect(authority.confirmLocal(pair.pairingId, KEY)).rejects.toThrow('local_confirmation_mismatch')
    const input = { pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }
    await expect(authority.prove(input, 'f'.repeat(64))).rejects.toThrow('channel_key_mismatch')
    expect(await authority.prove(input, KEY)).toEqual({ state: 'awaiting_local_confirmation', pairingId: pair.pairingId, publicKeySHA256: KEY })
    await expect(authority.confirmLocal(pair.pairingId, 'e'.repeat(64))).rejects.toThrow('local_confirmation_mismatch')
    expect(issue).not.toHaveBeenCalled()
    expect(authority.authorizesCertificate(CERT)).toBe(false)
  })

  it('limits incorrect secrets without allowing a leaked secret to bypass local confirmation', async () => {
    const { authority, issue } = setup()
    const pair = await authority.begin()
    const input = { pairingId: pair.pairingId, secret: 'x'.repeat(43), csrPEM: 'CSR', deviceLabel: 'iPhone' }
    for (let attempt = 0; attempt < 5; attempt++) await expect(authority.prove(input, KEY)).rejects.toThrow('invalid_pairing_proof')
    await expect(authority.prove({ ...input, secret: pair.secret }, KEY)).rejects.toThrow('pairing_not_active')
    expect(authority.inspectLocal().pairings[0]).toMatchObject({ state: 'rejected', attempts: 5 })
    expect(issue).not.toHaveBeenCalled()
  })

  it('binds the approved candidate and cannot swap its CSR', async () => {
    const { authority, dependencies } = setup()
    const { input } = await pending(authority)
    dependencies.verifyCSR = async csrPEM => ({ csrPEM, csrSHA256: 'e'.repeat(64), publicKeySHA256: KEY })
    await expect(authority.prove({ ...input, csrPEM: 'replacement' }, KEY)).rejects.toThrow('pairing_candidate_changed')
    expect(authority.inspectLocal().pairings[0].state).toBe('awaiting_local_confirmation')
  })

  it('commits consumption and grant once; replay returns the same transaction even after exchange expiry', async () => {
    const { authority, issue, time } = setup()
    const { pairing, input } = await pending(authority)
    const [a, b] = await Promise.all([authority.confirmLocal(pairing.pairingId, KEY), authority.confirmLocal(pairing.pairingId, KEY)])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ source: 'local_confirmation', authority: 'owner-device' })
    expect(issue).toHaveBeenCalledTimes(1)
    time.wall += 130_000; time.monotonic += 130_000
    expect(await authority.prove(input, KEY)).toEqual({ state: 'paired', grant: a })
    expect(authority.inspectLocal().grants).toHaveLength(1)
    expect(authority.authorizesCertificate(CERT)).toBe(true)
    await expect(authority.status(pairing.pairingId, pairing.secret, 'e'.repeat(64))).rejects.toThrow('channel_key_mismatch')
  })

  it('expires an exchange despite wall-clock rollback; restart cannot revive a pending proof', async () => {
    const { authority, dependencies, time } = setup()
    const { pairing } = await pending(authority)
    time.wall -= 10_000; time.monotonic = 120_001
    await expect(authority.confirmLocal(pairing.pairingId, KEY)).rejects.toThrow('pairing_expired')
    authority.close()
    const restored = new PairingAuthority(dependencies)
    expect(restored.inspectLocal().pairings[0].state).toBe('expired')
    await expect(restored.status(pairing.pairingId, pairing.secret, KEY)).rejects.toThrow('pairing_not_active')
  })

  it('write failure returns no certificate and fences every subsequent authorization', async () => {
    const store = new MemoryStore()
    const { authority, issue } = setup(store)
    const { pairing } = await pending(authority)
    store.failure = 'before'
    await expect(authority.confirmLocal(pairing.pairingId, KEY)).rejects.toThrow('injected_write_failure')
    expect(store.value?.grants).toHaveLength(0)
    expect(authority.authorizesCertificate(CERT)).toBe(false)
    await expect(authority.confirmLocal(pairing.pairingId, KEY)).rejects.toThrow('pairing_storage_unavailable')
    expect(issue).toHaveBeenCalledTimes(1)
  })

  it('unknown commit receipt requires reopening observed state, never a second certificate issuance', async () => {
    const store = new MemoryStore()
    const { authority, dependencies, issue } = setup(store)
    const { pairing } = await pending(authority)
    store.failure = 'after'
    await expect(authority.confirmLocal(pairing.pairingId, KEY)).rejects.toThrow('injected_receipt_lost')
    expect(authority.authorizesCertificate(CERT)).toBe(false)
    authority.close()
    store.failure = undefined
    const restored = new PairingAuthority(dependencies)
    const receipt = await restored.status(pairing.pairingId, pairing.secret, KEY)
    expect(receipt.state).toBe('paired')
    expect(await restored.confirmLocal(pairing.pairingId, KEY)).toEqual(store.value?.grants[0])
    expect(issue).toHaveBeenCalledTimes(1)
  })

  it('cancellation while a signer is awaiting completion cannot issue a grant', async () => {
    const { authority, dependencies } = setup()
    const { pairing } = await pending(authority)
    let started!: () => void
    let finish!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const pendingSignature = new Promise<void>(resolve => { finish = resolve })
    const original = dependencies.issue
    dependencies.issue = async input => { started(); await pendingSignature; return original(input) }
    const confirmation = authority.confirmLocal(pairing.pairingId, KEY)
    await entered
    const cancellation = authority.cancel(pairing.pairingId)
    finish()
    await expect(confirmation).rejects.toThrow('pairing_not_active')
    await cancellation
    expect(authority.inspectLocal().grants).toHaveLength(0)
  })

  it('persists a peer label update across restart without reissuing a grant or rewriting unchanged labels', async () => {
    const store = new MemoryStore()
    const { authority, dependencies, issue } = setup(store)
    const { pairing } = await pending(authority)
    const grant = await authority.confirmLocal(pairing.pairingId, KEY)
    const commit = vi.spyOn(store, 'commit')
    await authority.updateDeviceLabel(CERT, 'iPhone 17 Pro')
    await authority.updateDeviceLabel(CERT, 'iPhone 17 Pro')
    expect(commit).toHaveBeenCalledTimes(1)
    const expected = { ...grant, deviceLabel: 'iPhone 17 Pro' }
    expect(authority.inspectLocal().grants).toEqual([expected])
    expect(issue).toHaveBeenCalledTimes(1)
    authority.close()
    const restored = new PairingAuthority(dependencies)
    expect(restored.inspectLocal().grants).toEqual([expected])
    expect(restored.authorizesCertificate(CERT)).toBe(true)
  })

  it('rejects ungranted and expired peers and fences authorization after a label persistence failure', async () => {
    const store = new MemoryStore()
    const { authority, dependencies, time } = setup(store)
    const { pairing } = await pending(authority)
    const grant = await authority.confirmLocal(pairing.pairingId, KEY)
    await expect(authority.updateDeviceLabel(KEY, 'spoof')).rejects.toThrow('device_not_authorized')
    expect(authority.inspectLocal().grants).toEqual([grant])
    store.failure = 'before'
    await expect(authority.updateDeviceLabel(CERT, 'iPhone 17 Pro')).rejects.toThrow('injected_write_failure')
    expect(authority.authorizesCertificate(CERT)).toBe(false)
    authority.close()
    store.failure = undefined
    const restored = new PairingAuthority(dependencies)
    expect(restored.inspectLocal().grants).toEqual([grant])
    time.wall = grant.expiresAt
    await expect(restored.updateDeviceLabel(CERT, 'spoof')).rejects.toThrow('device_not_authorized')
    expect(restored.inspectLocal().grants).toEqual([grant])
  })

  it('revocation rejects new calls immediately and persists across normal host restart', async () => {
    const { authority, dependencies } = setup()
    const { pairing } = await pending(authority)
    const grant = await authority.confirmLocal(pairing.pairingId, KEY)
    const revoked = authority.revoke(grant.deviceId)
    expect(authority.authorizesCertificate(CERT)).toBe(false)
    await revoked
    authority.close()
    const restored = new PairingAuthority(dependencies)
    expect(restored.authorizesCertificate(CERT)).toBe(false)
    expect(await restored.status(pairing.pairingId, pairing.secret, KEY)).toEqual({ state: 'revoked', deviceId: grant.deviceId })
    await expect(restored.confirmLocal(pairing.pairingId, KEY)).rejects.toThrow('device_revoked')
  })

  it('lets an expired device certificate re-pair with the same key', async () => {
    const { authority, dependencies, time } = setup()
    const first = await pending(authority)
    const firstGrant = await authority.confirmLocal(first.pairing.pairingId, KEY)
    time.wall += 3_600_001
    const second = await authority.begin()
    const input = { pairingId: second.pairingId, secret: second.secret, csrPEM: 'synthetic CSR', deviceLabel: 'Test iPhone' }
    expect(await authority.prove(input, KEY)).toEqual({ state: 'awaiting_local_confirmation', pairingId: second.pairingId, publicKeySHA256: KEY })
    dependencies.issue = vi.fn(async ({ deviceId }: { deviceId: string }) => ({
      deviceId, certificatePEM: 'renewed synthetic certificate', certificateSHA256: 'e'.repeat(64),
      publicKeySHA256: KEY, expiresAt: time.wall + 3_600_000
    }))
    const renewed = await authority.confirmLocal(second.pairingId, KEY)
    expect(renewed.deviceId).not.toBe(firstGrant.deviceId)
    const matching = authority.inspectLocal().grants.filter(g => g.publicKeySHA256 === KEY)
    expect(matching).toHaveLength(2)
    expect(matching.filter(g => g.revokedAt === null)).toHaveLength(1)
  })

  it('lets a revoked device re-pair after fresh operator confirmation', async () => {
    const { authority, dependencies, time } = setup()
    const first = await pending(authority)
    const grant = await authority.confirmLocal(first.pairing.pairingId, KEY)
    await authority.revoke(grant.deviceId)
    expect(authority.authorizesCertificate(CERT)).toBe(false)
    // A revoked device's key must not permanently ban it: a brand-new pairing
    // with the same key proves and reaches awaiting_local_confirmation again,
    // then a fresh operator confirmation issues a DISTINCT grant (real issuance
    // mints a new certificate, so certificateSHA256 differs from the revoked one).
    const NEWCERT = 'e'.repeat(64)
    dependencies.issue = vi.fn(async ({ deviceId }: { deviceId: string }) => ({
      deviceId, certificatePEM: 're-issued synthetic certificate', certificateSHA256: NEWCERT,
      publicKeySHA256: KEY, expiresAt: time.wall + 3_600_000
    }))
    const second = await authority.begin()
    const input = { pairingId: second.pairingId, secret: second.secret, csrPEM: 'synthetic CSR', deviceLabel: 'Test iPhone' }
    expect(await authority.prove(input, KEY)).toEqual({ state: 'awaiting_local_confirmation', pairingId: second.pairingId, publicKeySHA256: KEY })
    const regrant = await authority.confirmLocal(second.pairingId, KEY)
    expect(regrant.deviceId).not.toEqual(grant.deviceId)
    expect(authority.authorizesCertificate(NEWCERT)).toBe(true)
    expect(authority.authorizesCertificate(CERT)).toBe(false)
  })

  it('rejects changed host identity and nonlocal or inconsistent stored grant claims', async () => {
    const { authority, dependencies } = setup()
    const { pairing } = await pending(authority)
    await authority.confirmLocal(pairing.pairingId, KEY)
    expect(() => new PairingAuthority({ ...dependencies, anchorSHA256: 'e'.repeat(64) })).toThrow('host_identity_changed')
    const snapshot = authority.inspectLocal()
    expect(() => validatePairingState({ ...snapshot, grants: snapshot.grants.map(g => ({ ...g, source: 'cloud_account' })) })).toThrow('invalid_pairing_state')
    expect(() => validatePairingState({ ...snapshot, pairings: [] })).toThrow('invalid_pairing_state')
  })
})

describe('private atomic pairing file', () => {
  it('persists and reloads one whole transaction, with private modes and an exclusive lease', async () => {
    const path = directory()
    const store = new PairingFileStore(path)
    const { authority, dependencies } = setup(store)
    try {
      expect(() => new PairingFileStore(path)).toThrow()
      const { pairing } = await pending(authority)
      await authority.confirmLocal(pairing.pairingId, KEY)
      expect(statSync(join(path, 'pairing-state.json')).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(path, 'pairing-state.json'), 'utf8')).not.toContain(pairing.secret)
      authority.close(); store.close()
      const reopened = new PairingFileStore(path)
      try {
        const restored = new PairingAuthority({ ...dependencies, store: reopened })
        expect(restored.authorizesCertificate(CERT)).toBe(true)
        expect(restored.inspectLocal().grants).toHaveLength(1)
        restored.close()
      } finally { reopened.close() }
    } finally { authority.close(); store.close() }
  })

  it('directory-fsync failure after real rename fences authority until explicit disk reconciliation', async () => {
    const store = new PairingFileStore(directory())
    const { authority, dependencies, issue } = setup(store)
    const { pairing } = await pending(authority)
    // Inject at the actual post-rename fsync boundary, not a fake successful IO.
    const sync = vi.spyOn(store as unknown as { syncDirectory(): void }, 'syncDirectory')
    try {
      sync.mockImplementationOnce(() => { throw new Error('directory_fsync_failed') })
      await expect(authority.confirmLocal(pairing.pairingId, KEY)).rejects.toThrow('directory_fsync_failed')
      expect(authority.authorizesCertificate(CERT)).toBe(false)
      authority.close()
      sync.mockRestore()
      const reconciled = new PairingAuthority(dependencies)
      expect((await reconciled.status(pairing.pairingId, pairing.secret, KEY)).state).toBe('paired')
      expect(issue).toHaveBeenCalledTimes(1)
      reconciled.close()
    } finally { sync.mockRestore(); authority.close(); store.close() }
  })

  it('cannot authorize with a closed file lease, even if the owner forgot to close the authority first', async () => {
    const store = new PairingFileStore(directory())
    const { authority } = setup(store)
    try {
      const { pairing } = await pending(authority)
      await authority.confirmLocal(pairing.pairingId, KEY)
      store.close()
      expect(authority.authorizesCertificate(CERT)).toBe(false)
      expect(() => authority.inspectLocal()).toThrow('pairing_storage_unavailable')
    } finally { authority.close(); store.close() }
  })

  it('refuses symlink data, corrupt snapshots and unknown stale locks instead of recovering a backup', () => {
    const path = directory()
    const store = new PairingFileStore(path)
    const target = join(path, 'not-a-state')
    writeFileSync(target, 'unrelated synthetic content', { mode: 0o600 })
    symlinkSync(target, join(path, 'pairing-state.json'))
    expect(() => store.load()).toThrow()
    rmSync(join(path, 'pairing-state.json'))
    writeFileSync(join(path, 'pairing-state.json'), JSON.stringify({ version: 1, payload: '{}', sha256: '0'.repeat(64) }), { mode: 0o600 })
    expect(() => store.load()).toThrow('invalid_pairing_file')
    store.close()
    writeFileSync(join(path, 'pairing-state.lock'), 'unknown previous owner', { mode: 0o600 })
    expect(() => new PairingFileStore(path)).toThrow()
    expect(readFileSync(join(path, 'pairing-state.lock'), 'utf8')).toBe('unknown previous owner')
  })
})
