import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairingAuthority, validatePairingState } from './pairing'
import type { IssuedPairingCertificate, PairingDependencies, PairingRecord, PairingState } from './pairing'
import { PairingFileStore } from './pairing-file'
import { pruneStalePairings } from './pairing-retention'

// W3 / P5-5a release 1: reader recognizes optional `approvedVia: 'app' | 'host_cli'`
// on `scope: 'remote'` grants and preserves it verbatim on round-trip without writing it.

const ANCHOR = 'c'.repeat(64)
const T0 = 20_000_000
const TTL = 120_000
const hex = (prefix: string, index: number) => `${prefix.repeat(56)}${index.toString(16).padStart(8, '0')}`
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function rawGrantAndPairing(
  index: number,
  options: {
    scope?: 'local' | 'remote' | 'omit'
    approvedVia?: unknown
    includeApprovedViaKey?: boolean
    revokedAt?: number | null
    expiresAt?: number
  } = {}
) {
  const pairingId = randomUUID()
  const deviceId = randomUUID()
  const scope = options.scope ?? 'remote'
  const grant: Record<string, unknown> = {
    certificatePEM: 'synthetic certificate, not cryptographic evidence',
    certificateSHA256: hex('e', index),
    publicKeySHA256: hex('f', index),
    deviceId,
    expiresAt: options.expiresAt ?? T0 + 3_600_000,
    pairingId,
    deviceLabel: `Device ${index}`,
    authority: 'owner-device',
    source: scope === 'local' ? 'local_socket' : 'local_confirmation',
    confirmedAt: T0 - 5_000 + index,
    revokedAt: options.revokedAt ?? null
  }
  if (scope !== 'omit') grant.scope = scope
  if (options.includeApprovedViaKey || options.approvedVia !== undefined) {
    grant.approvedVia = options.approvedVia
  }
  const pairing: PairingRecord = {
    pairingId,
    secretVerifier: digest(`s${String(index).padStart(42, '0')}`),
    createdAt: T0 - 5_000 + index,
    expiresAt: T0 - 5_000 + index + TTL,
    attempts: 0,
    state: 'paired',
    deviceId
  }
  return { grant, pairing }
}

function rawState(entries: Array<{ grant: Record<string, unknown>; pairing: PairingRecord }>, hostId = randomUUID()) {
  return {
    version: 1,
    hostId,
    anchorSHA256: ANCHOR,
    pairings: entries.map(entry => entry.pairing),
    grants: entries.map(entry => entry.grant)
  }
}

const directories: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-pairing-approved-via-'))
  directories.push(dir)
  return dir
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('grant approvedVia reader compatibility (P5-5a release 1)', () => {
  it('accepts optional approvedVia on remote grants and keeps omitted grants unchanged', () => {
    const appGrant = rawGrantAndPairing(1, { approvedVia: 'app' })
    const cliGrant = rawGrantAndPairing(2, { approvedVia: 'host_cli' })
    const legacyNoScope = rawGrantAndPairing(3, { scope: 'omit', approvedVia: 'host_cli' })
    const legacyNoField = rawGrantAndPairing(4)

    const validated = validatePairingState(rawState([appGrant, cliGrant, legacyNoScope, legacyNoField]))
    expect(validated.grants[0]).toMatchObject({ scope: 'remote', approvedVia: 'app' })
    expect(validated.grants[1]).toMatchObject({ scope: 'remote', approvedVia: 'host_cli' })
    expect(validated.grants[2]).toMatchObject({ scope: 'remote', approvedVia: 'host_cli' })
    expect(validated.grants[3].scope).toBe('remote')
    expect('approvedVia' in validated.grants[3]).toBe(false)
  })

  it('rejects invalid approvedVia values and any approvedVia on local grants', () => {
    for (const invalid of ['', 'cli', 'manual', 'APP', null, 123, true, {}]) {
      expect(() => validatePairingState(rawState([rawGrantAndPairing(1, { approvedVia: invalid })])))
        .toThrow('invalid_pairing_state')
    }
    expect(() => validatePairingState(rawState([rawGrantAndPairing(1, { approvedVia: undefined, includeApprovedViaKey: true })])))
      .toThrow('invalid_pairing_state')
    for (const value of ['app', 'host_cli', undefined] as const) {
      expect(() => validatePairingState(rawState([
        rawGrantAndPairing(1, { scope: 'local', approvedVia: value, includeApprovedViaKey: true })
      ]))).toThrow('invalid_pairing_state')
    }
  })

  it('round-trips approvedVia intact on disk without writing it onto new grants', async () => {
    const dir = tempDir()
    const hostId = randomUUID()
    const appEntry = rawGrantAndPairing(1, { approvedVia: 'app' })
    const cliEntry = rawGrantAndPairing(2, { approvedVia: 'host_cli' })
    const legacyEntry = rawGrantAndPairing(3)
    const initial = validatePairingState(rawState([appEntry, cliEntry, legacyEntry], hostId))

    const seed = new PairingFileStore(dir)
    seed.commit(initial)
    seed.close()

    const store = new PairingFileStore(dir)
    let issued = 0
    const time = { wall: T0, monotonic: 0 }
    const deps: PairingDependencies = {
      store,
      hostId,
      anchorSHA256: ANCHOR,
      clock: () => time.wall,
      monotonic: () => time.monotonic,
      verifyCSR: vi.fn(async (csrPEM: string) => ({
        csrPEM,
        csrSHA256: hex('b', 99),
        publicKeySHA256: csrPEM.includes('local') ? hex('a', 98) : hex('a', 99)
      })),
      issue: vi.fn(async ({ deviceId, publicKeySHA256 }): Promise<IssuedPairingCertificate> => {
        issued += 1
        return {
          deviceId,
          certificatePEM: 'synthetic certificate, not cryptographic evidence',
          certificateSHA256: hex('9', issued),
          publicKeySHA256,
          expiresAt: time.wall + 3_600_000
        }
      })
    }

    const authority = new PairingAuthority(deps)
    try {
      expect(authority.authorizesCertificate(hex('e', 1), 'network')).toBe(true)
      expect(authority.authorizesCertificate(hex('e', 2), 'network')).toBe(true)
      expect(authority.authorizesCertificate(hex('e', 3), 'network')).toBe(true)

      await authority.updateDeviceLabel(hex('e', 2), 'SSH Laptop')
      await authority.revoke(String(appEntry.grant.deviceId))
      const enrolled = await authority.enrollLocal({ csrPEM: 'CSR local', deviceLabel: 'Scry App' }, () => true)
      const begun = await authority.begin()
      await authority.prove({ pairingId: begun.pairingId, secret: begun.secret, csrPEM: 'CSR phone', deviceLabel: 'New Phone' }, hex('a', 99))
      const newlyConfirmed = await authority.confirmLocal(begun.pairingId, hex('a', 99))

      expect('approvedVia' in enrolled).toBe(false)
      expect('approvedVia' in newlyConfirmed).toBe(false)
    } finally {
      authority.close()
      store.close()
    }

    const envelope = JSON.parse(readFileSync(join(dir, 'pairing-state.json'), 'utf8')) as { payload: string }
    const persisted = JSON.parse(envelope.payload) as PairingState
    const validatedAgain = validatePairingState(persisted)

    expect(validatedAgain.grants.find(g => g.deviceId === appEntry.grant.deviceId)).toMatchObject({
      approvedVia: 'app'
    })
    expect(validatedAgain.grants.find(g => g.deviceId === cliEntry.grant.deviceId)).toMatchObject({
      deviceLabel: 'SSH Laptop',
      approvedVia: 'host_cli'
    })
    const persistedLegacy = validatedAgain.grants.find(g => g.deviceId === legacyEntry.grant.deviceId)!
    expect('approvedVia' in persistedLegacy).toBe(false)
    for (const grant of validatedAgain.grants.filter(g => g.deviceLabel === 'Scry App' || g.deviceLabel === 'New Phone')) {
      expect('approvedVia' in grant).toBe(false)
    }
  })

  it('prunes stale grants carrying approvedVia and preserves the field on retained grants', () => {
    const stale = Array.from({ length: 20 }, (_, i) =>
      rawGrantAndPairing(i, {
        approvedVia: i % 2 === 0 ? 'app' : 'host_cli',
        revokedAt: T0 - 100_000 + i
      })
    )
    const live = rawGrantAndPairing(99, { approvedVia: 'host_cli' })
    const original = validatePairingState(rawState([...stale, live]))

    const pruned = pruneStalePairings(original, T0)
    const revalidated = validatePairingState(pruned)

    expect(revalidated.grants).toHaveLength(17)
    expect(revalidated.grants.map(g => g.deviceId)).toEqual([
      ...stale.slice(4).map(s => s.grant.deviceId),
      live.grant.deviceId
    ])
    for (const grant of revalidated.grants) {
      expect(original.grants).toContainEqual(grant)
      expect(grant.approvedVia === 'app' || grant.approvedVia === 'host_cli').toBe(true)
    }
  })
})
