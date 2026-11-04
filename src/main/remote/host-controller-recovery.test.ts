import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HostController, type HostControllerDependencies, type RemoteIntentRouting } from './host-controller'
import type { IssuedPairingCertificate, PairingDependencies, PairingPersistence, PairingState } from './pairing'
import type { LedgerEvent, LedgerStore } from './session-ledger'
import type { WorkspaceAuthorizer } from './remote-run-policy'

const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
const CERT = 'd'.repeat(64)
const AUTHORIZED = '/authorized/project'

class MemoryPairingStore implements PairingPersistence {
  value: PairingState | undefined
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void { this.value = structuredClone(state) }
}
class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[] = []
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return this.log.map((e) => ({ ...e })) }
  append(event: LedgerEvent): void { this.log.push({ ...event }) }
}

const workspace: WorkspaceAuthorizer = {
  authorize(cwd) { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd }
}

function pairingDeps(): PairingDependencies {
  const time = { wall: 1_000_000, monotonic: 0 }
  const issue = vi.fn(async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({
    deviceId, certificatePEM: 'synthetic certificate, not cryptographic evidence', certificateSHA256: CERT,
    publicKeySHA256: KEY, expiresAt: time.wall + 3_600_000
  }))
  return {
    store: new MemoryPairingStore(), hostId: randomUUID(), anchorSHA256: ANCHOR,
    clock: () => time.wall, monotonic: () => time.monotonic,
    verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })), issue
  }
}

type RunProvider = (input: { runId: string; routing: RemoteIntentRouting; progress(detail?: string): void }) => Promise<void>

async function grantedController(runProvider: RunProvider, listProjects?: () => { path: string; label: string }[],
  extra: Partial<HostControllerDependencies> = {}) {
  const controller = new HostController({
    pairing: pairingDeps(), ledgerStore: new MemoryLedgerStore(), workspace, runProvider,
    ...(listProjects ? { listProjects } : {}),
    ...extra
  })
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }, KEY)
  const grant = await controller.authority.confirmLocal(pair.pairingId, KEY)
  return { controller, deviceId: grant.deviceId }
}

const routing = (over: Partial<RemoteIntentRouting> = {}): string =>
  JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })

describe('HostController (composition root)', () => {
  it('never reaches the Provider when recovering a crash between fencing an intent and cancelling it', async () => {
    const ledgerStore = new MemoryLedgerStore()
    const runId = randomUUID()
    const intentId = randomUUID()
    // First half of explicit recovery was fsynced, but cancellation was not.
    // This reserved id has no routing payload, including after a host restart.
    ledgerStore.log = [{ seq: 1, at: 1, runId, intentId, kind: 'intent_recorded' }]
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider, undefined, { ledgerStore })
    controller.recover()
    await controller.idle()
    expect(controller.runState(CERT, { runId })).toBe('failed')
    expect(ledgerStore.log.at(-1)).toMatchObject({ kind: 'run_failed', runId, detail: 'invalid_target' })
    expect(runProvider).not.toHaveBeenCalled()
  })

  it('only grants an explicitly selected desktop directory to an authorized owner, without starting a run', async () => {
    const known = new Set([AUTHORIZED])
    const project = { path: '/new/project', label: 'project' }
    const list = vi.fn(() => ({ current: project, directories: [], cursor: 0, total: 0, hasMore: false, snapshot: 'a'.repeat(64) }))
    const select = vi.fn((path: string) => { known.add(path); return project })
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider, undefined, {
      workspace: { authorize: (path) => { if (!known.has(path)) throw new Error('not authorized'); return path } },
      desktopDirectories: { list, select },
      readDesktop: async () => ({ kind: 'info', protocol: 1, hostId: 'test', execution: 'canonical' })
    })
    expect(() => controller.desktopDirectory('0'.repeat(64), { action: 'select', path: project.path })).toThrow('device_not_authorized')
    expect(list).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(controller.desktopDirectory(CERT, { action: 'list', path: project.path }).action).toBe('list')
    expect(select).not.toHaveBeenCalled()
    expect(known.has(project.path)).toBe(false)
    await expect(controller.readDesktop(CERT, { kind: 'info' })).resolves.toMatchObject({ directorySelection: true })
    const denied = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ cwd: project.path, prompt: 'not yet authorized' }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: denied.runId })).toBe('failed')
    expect(runProvider).not.toHaveBeenCalled()
    expect(controller.desktopDirectory(CERT, { action: 'select', path: project.path })).toEqual({ action: 'select', project })
    expect(select).toHaveBeenCalledExactlyOnceWith(project.path)
    expect(runProvider).not.toHaveBeenCalled()
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ cwd: project.path, prompt: 'explicit send' }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(runProvider).toHaveBeenCalledTimes(1)
    await controller.authority.revoke(deviceId)
    expect(() => controller.desktopDirectory(CERT, { action: 'list' })).toThrow('device_not_authorized')
    expect(() => controller.desktopDirectory(CERT, { action: 'select', path: '/other' })).toThrow('device_not_authorized')
    expect(list).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledTimes(1)
  })

})
