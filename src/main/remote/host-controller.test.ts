import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HostController, type RemoteIntentRouting } from './host-controller'
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

async function grantedController(runProvider: RunProvider, listProjects?: () => { path: string; label: string }[]) {
  const controller = new HostController({
    pairing: pairingDeps(), ledgerStore: new MemoryLedgerStore(), workspace, runProvider,
    ...(listProjects ? { listProjects } : {})
  })
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }, KEY)
  const grant = await controller.authority.confirmLocal(pair.pairingId, KEY)
  return { controller, deviceId: grant.deviceId }
}

const routing = (over: Partial<RemoteIntentRouting> = {}): string =>
  JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })

describe('HostController (composition root)', () => {
  it('runs a routed intent end-to-end through the real modules and reflects settlement', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting; progress(d?: string): void }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)

    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'ship it' }) })
    expect(submit.status).toBe('recorded')
    await controller.idle()

    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude', prompt: 'ship it' }])
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('settled')
    const feed = controller.poll(CERT, { cursor: 0 })
    expect(feed.events.map((e) => e.kind)).toEqual(['intent_recorded', 'run_dispatched', 'run_settled'])
  })

  it('accepts bounded explicit run controls and rejects invalid permission modes', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({
      prompt: 'go', modelId: 'gpt-5.4', effort: 'high', permissionMode: 'full_access'
    }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(seen[0]).toMatchObject({ modelId: 'gpt-5.4', effort: 'high', permissionMode: 'full_access' })

    const rejected = controller.submitIntent(CERT, { intentId: randomUUID(), detail: JSON.stringify({
      cwd: AUTHORIZED, providerId: 'claude', prompt: 'go', permissionMode: 'invented'
    }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: rejected.runId })).toBe('failed')
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('accepts bounded encrypted image/text attachments and rejects malformed payloads before Provider execution', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)
    const image = { kind: 'image' as const, name: 'screen.jpg', mimeType: 'image/jpeg', dataBase64: '/9j/', size: 3 }
    const text = { kind: 'text' as const, name: 'error.log', mimeType: 'text/plain', dataBase64: 'Ym9vbQ==', size: 4 }
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'inspect', attachments: [image, text] }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(seen[0].attachments).toEqual([image, text])

    const malformed = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ attachments: [{ ...image, size: 99 }] }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: malformed.runId })).toBe('failed')
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('records the intent but fails the run for an unauthorized workspace (never reaching the provider)', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider)
    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ cwd: '/tmp/smuggled' }) })
    await controller.idle()
    expect(runProvider).not.toHaveBeenCalled()
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('failed')
    const failed = controller.poll(CERT, { cursor: 0 }).events.find((e) => e.kind === 'run_failed')
    expect(failed?.detail).toContain('workspace_not_authorized')
  })

  it('fails the run truthfully when the provider throws', async () => {
    const runProvider = vi.fn(async () => { throw new Error('provider exploded') })
    const { controller } = await grantedController(runProvider)
    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })
    await controller.idle()
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('failed')
  })

  it('is idempotent on intentId: a retry does not re-run the provider', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider)
    const intentId = randomUUID()
    const first = controller.submitIntent(CERT, { intentId, detail: routing() })
    await controller.idle()
    const retry = controller.submitIntent(CERT, { intentId, detail: routing() })
    await controller.idle()
    expect(retry).toEqual({ runId: first.runId, status: 'duplicate' })
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('exposes host-authorized projects only to the granted device (delegates to the gateway)', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider, () => [{ path: AUTHORIZED, label: 'project' }])
    expect(controller.listProjects(CERT)).toEqual([{ path: AUTHORIZED, label: 'project' }])
    expect(() => controller.listProjects('f'.repeat(64))).toThrowError(/device_not_authorized/)
    await controller.authority.revoke(deviceId)
    expect(() => controller.listProjects(CERT)).toThrowError(/device_not_authorized/)
  })

  it('returns an honest empty project list when no source is injected', async () => {
    const { controller } = await grantedController(vi.fn(async () => {}))
    expect(controller.listProjects(CERT)).toEqual([])
  })

  it('denies a stranger certificate and a revoked device', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider)
    expect(() => controller.submitIntent('f'.repeat(64), { intentId: randomUUID(), detail: routing() })).toThrowError(/device_not_authorized/)
    await controller.authority.revoke(deviceId)
    expect(() => controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })).toThrowError(/device_not_authorized/)
    expect(runProvider).not.toHaveBeenCalled()
  })
})
