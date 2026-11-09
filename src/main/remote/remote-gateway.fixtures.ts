import { vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PairingAuthority, type IssuedPairingCertificate, type PairingDependencies, type PairingPersistence, type PairingState } from './pairing'
import { SessionLedger, type LedgerEvent, type LedgerStore } from './session-ledger'
import { RemoteGateway, type RemoteDirectoryListing, type RemoteProviderRef } from './remote-gateway'
import type { RunOutputLog } from './run-output-log'

// Synthetic authority and in-memory stores for gateway tests that need a real
// PairingAuthority but no cryptography or disk.
const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
export const CERT = 'd'.repeat(64)

export class MemoryPairingStore implements PairingPersistence {
  value: PairingState | undefined
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void { this.value = structuredClone(state) }
}

export class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[] = []
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return this.log.map((e) => ({ ...e })) }
  append(event: LedgerEvent): void { this.log.push({ ...event }) }
}

// Build a real PairingAuthority with a synthetic (non-cryptographic) adapter and
// drive it to a granted owner device, so the gateway authorizes against the real
// authority rather than a stub.
export async function grantedAuthority() {
  const time = { wall: 1_000_000, monotonic: 0 }
  const issue = vi.fn(async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({
    deviceId, certificatePEM: 'synthetic certificate, not cryptographic evidence', certificateSHA256: CERT,
    publicKeySHA256: KEY, expiresAt: time.wall + 3_600_000
  }))
  const deps: PairingDependencies = {
    store: new MemoryPairingStore(), hostId: randomUUID(), anchorSHA256: ANCHOR,
    clock: () => time.wall, monotonic: () => time.monotonic,
    verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })), issue
  }
  const authority = new PairingAuthority(deps)
  const pair = await authority.begin()
  await authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }, KEY)
  const grant = await authority.confirmLocal(pair.pairingId, KEY)
  return { authority, deviceId: grant.deviceId }
}

export function gateway(
  authority: { authorizesCertificate(fp: string): boolean },
  projects?: { list(): { path: string; label: string }[] },
  output?: RunOutputLog,
  providers?: { list(): RemoteProviderRef[] },
  sessions?: { list(): { sessionId: string; externalSessionId?: string; providerId: string; cwd: string; label: string; ts: number; pinnedAt?: number }[]; revision?: () => string },
  directories?: { list(path?: string): RemoteDirectoryListing },
  commands?: { list(query: { providerId: string; cwd: string; agentProfileId?: string }): Promise<{ commands: { name: string; description: string; argumentHint?: string; source?: 'builtin' | 'skill' | 'mcp' | 'custom' }[]; reason?: string }> }
) {
  const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
  return { gw: new RemoteGateway({ authority, ledger, ...(projects ? { projects } : {}), ...(output ? { output } : {}), ...(providers ? { providers } : {}), ...(sessions ? { sessions } : {}), ...(directories ? { directories } : {}), ...(commands ? { commands } : {}) }), ledger }
}
