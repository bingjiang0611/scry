import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HostController, type HostControllerDependencies } from './host-controller'
import type { PairingDependencies, PairingPersistence, PairingState, IssuedPairingCertificate } from './pairing'
import type { LedgerEvent, LedgerStore } from './session-ledger'

const peer = 'd'.repeat(64)
const workspace = '/authorized/project'
class Store implements PairingPersistence {
  state?: PairingState
  assertAvailable(): void {}
  load(): unknown { return this.state }
  commit(state: PairingState): void { this.state = structuredClone(state) }
}
class Ledger implements LedgerStore {
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return [] }
  append(): void {}
}
function pairing(): PairingDependencies {
  const store = new Store()
  return {
    store, hostId: randomUUID(), anchorSHA256: 'c'.repeat(64), clock: () => 1_000_000, monotonic: () => 0,
    verifyCSR: async (csrPEM) => ({ csrPEM, csrSHA256: 'b'.repeat(64), publicKeySHA256: 'a'.repeat(64) }),
    issue: async ({ deviceId }): Promise<IssuedPairingCertificate> => ({ deviceId, certificatePEM: 'test', certificateSHA256: peer, publicKeySHA256: 'a'.repeat(64), expiresAt: 2_000_000 })
  }
}
async function controller(extra: Partial<HostControllerDependencies> = {}) {
  const defaults: HostControllerDependencies = { pairing: pairing(), ledgerStore: new Ledger(), workspace: { authorize: (cwd) => { if (cwd !== workspace) throw new Error('not authorized'); return cwd } }, runProvider: async () => {} }
  const value = new HostController({ ...defaults, ...extra })
  const pending = await value.authority.begin()
  await value.authority.prove({ pairingId: pending.pairingId, secret: pending.secret, csrPEM: 'csr', deviceLabel: 'test' }, 'a'.repeat(64))
  await value.authority.confirmLocal(pending.pairingId, 'a'.repeat(64))
  return value
}

describe('remote fork/delete capability contract', () => {
  it('advertises fork and delete independently and old hosts fail closed', async () => {
    const oldHost = await controller({ readDesktop: async () => ({ kind: 'info', protocol: 1, hostId: 'host', execution: 'canonical' }) })
    await expect(oldHost.readDesktop(peer, { kind: 'info' })).resolves.not.toMatchObject({ sessionFork: true, sessionDelete: true })
    const host = await controller({ readDesktop: async () => ({ kind: 'info', protocol: 1, hostId: 'host', execution: 'canonical' }), sessionFork: async () => ({ externalSessionId: 'forked' }), sessionDelete: async () => ({ ok: true, deleted: ['catalog'], retained: [], failed: [] }) })
    await expect(host.readDesktop(peer, { kind: 'info' })).resolves.toMatchObject({ sessionFork: true, sessionDelete: true })
    await expect(host.sessionFork(peer, { providerId: 'claude', cwd: workspace, sourceSessionId: 's', sourceRunId: 'r', sourceProviderTurnId: 't', sourceForkTurnId: 't' })).resolves.toEqual({ externalSessionId: 'forked' })
  })

  it('rechecks owner and cwd after an awaited destructive callback', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    let allowed = true
    const action = vi.fn(async (_request, authorize: () => void) => { await wait; authorize(); return { ok: true, deleted: [], retained: [], failed: [] } })
    const host = await controller({ sessionDelete: action, workspace: { authorize: (cwd) => { if (!allowed || cwd !== workspace) throw new Error('not authorized'); return cwd } } })
    const result = host.sessionDelete(peer, { providerId: 'claude', cwd: workspace, externalSessionId: 's', confirmed: true })
    allowed = false
    release()
    await expect(result).rejects.toThrow('not authorized')
  })
})
