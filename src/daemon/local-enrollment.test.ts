import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PairingAuthority } from '../main/remote/pairing'
import type { IssuedPairingCertificate, PairingDependencies, PairingPersistence, PairingState } from '../main/remote/pairing'
import { localEnrollHandlers, openLocalEnrollmentStore } from './local-enrollment'

const LOCAL_KEY = 'a'.repeat(64)
const PHONE_KEY = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)

class MemoryStore implements PairingPersistence {
  value: PairingState | undefined
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void { this.value = structuredClone(state) }
}

function setup() {
  const time = { wall: 1_000_000 }
  let issued = 0
  // Every issuance mints a distinct certificate hash, like the real CA does.
  const issue = vi.fn(async ({ deviceId, publicKeySHA256 }: { deviceId: string; publicKeySHA256: string }): Promise<IssuedPairingCertificate> => {
    issued += 1
    const prefix = publicKeySHA256 === LOCAL_KEY ? '9' : '8'
    return {
      deviceId,
      certificatePEM: 'synthetic certificate, not cryptographic evidence',
      certificateSHA256: `${prefix.repeat(60)}${String(issued).padStart(4, '0')}`,
      publicKeySHA256,
      expiresAt: time.wall + 3_600_000
    }
  })
  const deps: PairingDependencies = {
    store: new MemoryStore(), hostId: randomUUID(), anchorSHA256: ANCHOR,
    clock: () => time.wall, monotonic: () => 0,
    verifyCSR: vi.fn(async (csrPEM: string) => {
      // The synthetic adapter reads the key from the CSR text so one authority can
      // serve both a phone and the App.
      const key = csrPEM.includes('phone') ? PHONE_KEY : LOCAL_KEY
      return { csrPEM, csrSHA256: 'd'.repeat(64), publicKeySHA256: key }
    }),
    issue
  }
  return { authority: new PairingAuthority(deps), deps, time, issue, certificate: (index: number, local = true) => `${(local ? '9' : '8').repeat(60)}${String(index).padStart(4, '0')}` }
}

const directories: string[] = []
function stateDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'scry-local-enrollment-'))
  directories.push(path)
  return path
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('local enrollment (L1: secret + unix socket + same uid is the proof)', () => {
  it('enrolls the App on the first attempt and binds the grant to the local scope', async () => {
    const directory = stateDirectory()
    const { authority } = setup()
    const store = openLocalEnrollmentStore(directory)
    store.ensure(false)
    const secret = JSON.parse(readFileSync(store.secretPath, 'utf8')).secret
    expect(statSync(store.secretPath).mode & 0o777).toBe(0o600)

    const grant = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => store.consume(secret))
    expect(grant.scope).toBe('local')
    expect(grant.source).toBe('local_socket')
    expect(grant.publicKeySHA256).toBe(LOCAL_KEY)
    // Issued in one transaction: no second human confirmation exists for local.
    expect(authority.authorizesCertificate(grant.certificateSHA256, 'local')).toBe(true)
    expect(store.present()).toBe(false)
  })

  it('refuses to reuse a secret that already produced a grant', async () => {
    const directory = stateDirectory()
    const { authority, issue } = setup()
    const store = openLocalEnrollmentStore(directory)
    store.ensure(false)
    const secret = JSON.parse(readFileSync(store.secretPath, 'utf8')).secret
    await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => store.consume(secret))
    const issued = issue.mock.calls.length
    await expect(authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App again' }, () => store.consume(secret)))
      .rejects.toThrow('local_enrollment_secret_invalid')
    expect(issue.mock.calls.length).toBe(issued)
  })

  it('does not burn the secret when the CSR is rejected', async () => {
    const directory = stateDirectory()
    const { authority, deps } = setup()
    const store = openLocalEnrollmentStore(directory)
    store.ensure(false)
    const secret = JSON.parse(readFileSync(store.secretPath, 'utf8')).secret
    // A rejected CSR must not consume the secret: verify before spending it.
    const broken = new PairingAuthority({ ...deps, verifyCSR: vi.fn(async () => { throw new Error('invalid_csr_signature') }) })
    await expect(broken.enrollLocal({ csrPEM: 'garbage', deviceLabel: 'Scry App' }, () => store.consume(secret)))
      .rejects.toThrow('invalid_csr_signature')
    expect(store.present()).toBe(true)
    const grant = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => store.consume(secret))
    expect(grant.scope).toBe('local')
  })

  it('answers a grant\'s scope from the verified grant, and only while it is active', async () => {
    const { authority } = setup()
    const local = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => true)
    const pair = await authority.begin()
    await authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR phone', deviceLabel: 'iPhone' }, PHONE_KEY)
    const phone = await authority.confirmLocal(pair.pairingId, PHONE_KEY)
    // Policy that differs by scope reads this, so the narrow accessor must never say
    // "local" for a device grant or the other way round.
    expect(authority.grantScope(local.certificateSHA256)).toBe('local')
    expect(authority.grantScope(phone.certificateSHA256)).toBe('remote')
    expect(authority.grantScope('f'.repeat(64))).toBeUndefined()
    expect(authority.grantScope('not-a-hash')).toBeUndefined()
    await authority.revoke(local.deviceId)
    expect(authority.grantScope(local.certificateSHA256)).toBeUndefined()
  })

  it('refuses a locally enrolled grant on any network transport', async () => {
    const { authority } = setup()
    const storeless = () => true
    const grant = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, storeless)
    expect(authority.authorizesCertificate(grant.certificateSHA256, 'local')).toBe(true)
    expect(authority.authorizesCertificate(grant.certificateSHA256, 'network')).toBe(false)
    // Internal callers (pairing bookkeeping, gateway internals) stay scope-agnostic.
    expect(authority.authorizesCertificate(grant.certificateSHA256)).toBe(true)
  })

  it('keeps phone grants working on the network and after revocation stops the local grant', async () => {
    const { authority } = setup()
    const pair = await authority.begin()
    await authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR phone', deviceLabel: 'iPhone' }, PHONE_KEY)
    const phone = await authority.confirmLocal(pair.pairingId, PHONE_KEY)
    expect(phone.scope).toBe('remote')
    expect(authority.authorizesCertificate(phone.certificateSHA256, 'network')).toBe(true)

    const local = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => true)
    await authority.revoke(local.deviceId)
    expect(authority.authorizesCertificate(local.certificateSHA256, 'local')).toBe(false)
    // Revocation is immediate and the App must not retry silently: a second request
    // fails exactly like a first one, with no automatic re-enrollment.
    expect(authority.inspectLocal().grants.filter((grant) => grant.scope === 'local' && grant.revokedAt === null)).toHaveLength(0)
  })

  it('replaces the previous local grant instead of stacking a second one', async () => {
    const { authority } = setup()
    const first = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => true)
    const second = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => true)
    expect(authority.authorizesCertificate(first.certificateSHA256, 'local')).toBe(false)
    expect(authority.authorizesCertificate(second.certificateSHA256, 'local')).toBe(true)
    expect(authority.inspectLocal().grants.filter((grant) => grant.scope === 'local' && grant.revokedAt === null)).toHaveLength(1)
  })

  it('answers the enrollment socket with the certificate envelope and no secret echo', async () => {
    const directory = stateDirectory()
    const { authority } = setup()
    const store = openLocalEnrollmentStore(directory)
    store.ensure(false)
    const secret = JSON.parse(readFileSync(store.secretPath, 'utf8')).secret
    const handler = localEnrollHandlers(store, { enrollLocal: (input, consume) => authority.enrollLocal(input, consume) }, ANCHOR)
    const reply = await handler({ version: 1, secret, csrPEM: 'CSR local', deviceLabel: 'Scry App' }) as Record<string, unknown>
    expect(reply).toMatchObject({ version: 1, caCertificatePEM: ANCHOR, certificateSHA256: '9'.repeat(60) + '0001' })
    expect(JSON.stringify(reply)).not.toContain(secret)
    await expect(handler({ version: 1, secret, csrPEM: 'CSR local', deviceLabel: 'Scry App' }))
      .rejects.toThrow('local_enrollment_secret_invalid')
    await expect(handler({ version: 2, secret, csrPEM: 'CSR local', deviceLabel: 'Scry App' }))
      .rejects.toThrow('invalid_local_enrollment_request')
  })
})

describe('local enrollment secret lifecycle (L1: no time-based expiry, rotate on use and restart)', () => {
  it('creates a secret only while no local grant is live', () => {
    const directory = stateDirectory()
    const store = openLocalEnrollmentStore(directory)
    store.ensure(false)
    const first = readFileSync(store.secretPath, 'utf8')
    expect(store.present()).toBe(true)
    // A daemon restart with no grant rotates the secret instead of reusing it.
    store.ensure(false)
    expect(readFileSync(store.secretPath, 'utf8')).not.toBe(first)
    store.ensure(true)
    expect(store.present()).toBe(false)
    expect(existsSync(store.secretPath)).toBe(false)
  })

  it('does not expire a pending secret on its own', () => {
    const directory = stateDirectory()
    store: {
      const store = openLocalEnrollmentStore(directory, { clock: () => 0 })
      store.ensure(false)
      const secret = JSON.parse(readFileSync(store.secretPath, 'utf8'))
      expect(secret.createdAt).toBe(0)
      // A daemon started at login may wait hours; only use or restart rotates it.
      expect(store.consume(secret.secret)).toBe(true)
    }
  })

  it('fails closed on a malformed, missing or world-readable secret', () => {
    const directory = stateDirectory()
    const store = openLocalEnrollmentStore(directory)
    store.ensure(false)
    const secret = JSON.parse(readFileSync(store.secretPath, 'utf8')).secret
    expect(store.consume(undefined)).toBe(false)
    expect(store.consume('not-a-secret')).toBe(false)
    writeFileSync(store.secretPath, '{"version":1,"secret":"short"}', { mode: 0o600 })
    expect(store.consume(secret)).toBe(false)
    expect(store.present()).toBe(false)
    rmSync(store.secretPath, { force: true })
    expect(store.consume(secret)).toBe(false)
    store.ensure(false)
    const mode = statSync(store.secretPath).mode & 0o777
    expect(mode).toBe(0o600)
    store: {
      const wide = openLocalEnrollmentStore(directory)
      writeFileSync(wide.secretPath, readFileSync(wide.secretPath, 'utf8'), { mode: 0o644 })
      expect(() => wide.consume(secret)).not.toThrow()
      expect(wide.consume(secret)).toBe(false)
    }
  })
})
