import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PairingAuthority, type IssuedPairingCertificate, type PairingDependencies, type PairingPersistence, type PairingState } from './pairing'
import { SessionLedger, type LedgerEvent, type LedgerStore } from './session-ledger'
import { RemoteGateway, RemoteGatewayError } from './remote-gateway'
import { RunOutputLog } from './run-output-log'

const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
const CERT = 'd'.repeat(64)

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

// Build a real PairingAuthority with a synthetic (non-cryptographic) adapter and
// drive it to a granted owner device, so the gateway authorizes against the real
// authority rather than a stub.
async function grantedAuthority() {
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

function gateway(
  authority: { authorizesCertificate(fp: string): boolean },
  projects?: { list(): { path: string; label: string }[] },
  output?: RunOutputLog,
  providers?: { list(): { id: string; label: string; available: boolean }[] },
  sessions?: { list(): { sessionId: string; externalSessionId?: string; providerId: string; cwd: string; label: string; ts: number }[] }
) {
  const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
  return { gw: new RemoteGateway({ authority, ledger, ...(projects ? { projects } : {}), ...(output ? { output } : {}), ...(providers ? { providers } : {}), ...(sessions ? { sessions } : {}) }), ledger }
}

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); throw new Error('expected throw ' + code) }
  catch (error) {
    expect(error).toBeInstanceOf(RemoteGatewayError)
    expect((error as RemoteGatewayError).code).toBe(code)
  }
}

describe('RemoteGateway', () => {
  it('denies every operation to an unauthorized certificate and never mutates the ledger', async () => {
    const { authority } = await grantedAuthority()
    const { gw, ledger } = gateway(authority)
    const stranger = 'f'.repeat(64)
    expectCode(() => gw.submitIntent(stranger, { intentId: randomUUID() }), 'device_not_authorized')
    expectCode(() => gw.poll(stranger, { cursor: 0 }), 'device_not_authorized')
    expectCode(() => gw.runState(stranger, { runId: randomUUID() }), 'device_not_authorized')
    expectCode(() => gw.pollOutput(stranger, { runId: randomUUID(), cursor: 0 }), 'device_not_authorized')
    expectCode(() => gw.submitIntent('not-a-hash', { intentId: randomUUID() }), 'device_not_authorized')
    expect(ledger.describe().events).toBe(0)
  })

  it('serves streamed output content only to an authorized device, honest-empty otherwise', async () => {
    const { authority, deviceId } = await grantedAuthority()
    const runId = randomUUID()
    const src = new RunOutputLog()
    src.append(runId, { kind: 'output', text: 'Hello from the agent' })
    src.append(runId, { kind: 'tool', text: 'Edit /w/file.ts' })
    const { gw } = gateway(authority, undefined, src)

    const page = gw.pollOutput(CERT, { runId, cursor: 0 })
    expect(page.chunks.map((c) => c.kind)).toEqual(['output', 'tool'])
    expect(page.chunks[0].text).toBe('Hello from the agent')
    // Strictly-after-cursor paging.
    const after = gw.pollOutput(CERT, { runId, cursor: page.chunks[0].seq })
    expect(after.chunks.map((c) => c.kind)).toEqual(['tool'])
    // Unknown run => honest empty page at the same cursor, never fabricated.
    expect(gw.pollOutput(CERT, { runId: randomUUID(), cursor: 0 })).toEqual({ chunks: [], cursor: 0 })
    // Revoked device loses output access like every other op.
    await authority.revoke(deviceId)
    expectCode(() => gw.pollOutput(CERT, { runId, cursor: 0 }), 'device_not_authorized')
  })

  it('returns an honest empty output page when no output source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    expect(gw.pollOutput(CERT, { runId: randomUUID(), cursor: 0 })).toEqual({ chunks: [], cursor: 0 })
  })

  it('lets an authorized owner device submit a durable intent and poll it', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    const intentId = randomUUID()
    const result = gw.submitIntent(CERT, { intentId, detail: 'ship it' })
    expect(result.status).toBe('recorded')
    const feed = gw.poll(CERT, { cursor: 0 })
    expect(feed.events).toHaveLength(1)
    expect(feed.events[0].kind).toBe('intent_recorded')
    expect(feed.events[0].runId).toBe(result.runId)
    expect(gw.runState(CERT, { runId: result.runId })).toBe('recorded') // recorded is NOT executed
  })

  it('assigns the runId host-side and is idempotent on intentId', async () => {
    const { authority } = await grantedAuthority()
    const { gw, ledger } = gateway(authority)
    const intentId = randomUUID()
    const first = gw.submitIntent(CERT, { intentId })
    const retry = gw.submitIntent(CERT, { intentId })
    expect(retry.status).toBe('duplicate')
    expect(retry.runId).toBe(first.runId)
    expect(ledger.describe().events).toBe(1)
  })

  it('reflects host-driven lifecycle to the device through poll (device cannot drive it)', async () => {
    const { authority } = await grantedAuthority()
    const { gw, ledger } = gateway(authority)
    const submit = gw.submitIntent(CERT, { intentId: randomUUID() })
    // The trusted host executor drives the ledger directly; the device only reads.
    ledger.markDispatched(submit.runId)
    ledger.markSettled(submit.runId)
    const kinds = gw.poll(CERT, { cursor: 0 }).events.map((e) => e.kind)
    expect(kinds).toEqual(['intent_recorded', 'run_dispatched', 'run_settled'])
    expect(gw.runState(CERT, { runId: submit.runId })).toBe('settled')
  })

  it('lists host-authorized projects only for an authorized device, deduped and bounded', async () => {
    const { authority } = await grantedAuthority()
    const list = vi.fn(() => [
      { path: '/Projects/storefront', label: 'storefront' },
      { path: '/Projects/storefront', label: 'storefront' }, // duplicate path dropped
      { path: '/Work/scry', label: 'scry' },
      { path: '', label: 'empty-path-dropped' },
      ...Array.from({ length: 300 }, (_, i) => ({ path: `/p/${i}`, label: `p${i}` }))
    ])
    const { gw } = gateway(authority, { list })
    const stranger = 'f'.repeat(64)
    expectCode(() => gw.listProjects(stranger), 'device_not_authorized')
    const projects = gw.listProjects(CERT)
    expect(projects.length).toBe(200) // MAX_PROJECTS bound
    expect(projects.slice(0, 2)).toEqual([
      { path: '/Projects/storefront', label: 'storefront' },
      { path: '/Work/scry', label: 'scry' }
    ])
    expect(projects.some((p) => p.path === '')).toBe(false)
  })

  it('returns an honest empty project list when no source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    expect(gw.listProjects(CERT)).toEqual([])
  })

  it('lists host Providers only for an authorized device, deduped/bounded, availability preserved', async () => {
    const { authority } = await grantedAuthority()
    const list = vi.fn(() => [
      { id: 'qoder', label: 'Qoder', available: true },
      { id: 'qoder', label: 'Qoder dup', available: true }, // duplicate id dropped
      { id: 'claude', label: 'Claude', available: false },
      { id: '', label: 'empty-id-dropped', available: true },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, label: `p${i}`, available: true }))
    ])
    const { gw } = gateway(authority, undefined, undefined, { list })
    expectCode(() => gw.listProviders('f'.repeat(64)), 'device_not_authorized')
    const providers = gw.listProviders(CERT)
    expect(providers.length).toBe(32) // MAX_PROVIDERS bound
    expect(providers.slice(0, 2)).toEqual([
      { id: 'qoder', label: 'Qoder', available: true },
      { id: 'claude', label: 'Claude', available: false }
    ])
    expect(providers.some((p) => p.id === '')).toBe(false)
  })

  it('returns an honest empty provider list when no source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    expect(gw.listProviders(CERT)).toEqual([])
  })

  it('lists the host session catalog only for an authorized device, deduped/bounded, resumable id preserved', async () => {
    const { authority } = await grantedAuthority()
    const list = vi.fn(() => [
      { sessionId: 's1', externalSessionId: 'ext1', providerId: 'qoder', cwd: '/w/a', label: 'hello', ts: 20 },
      { sessionId: 's1', externalSessionId: 'ext1', providerId: 'qoder', cwd: '/w/a', label: 'dup', ts: 21 }, // dup id dropped
      { sessionId: 's2', providerId: 'claude', cwd: '/w/b', label: 'pending', ts: 10 }, // no externalSessionId
      { sessionId: '', providerId: 'qoder', cwd: '/w', label: 'empty-id', ts: 5 }
    ])
    const { gw } = gateway(authority, undefined, undefined, undefined, { list })
    expectCode(() => gw.listSessions('f'.repeat(64)), 'device_not_authorized')
    const sessions = gw.listSessions(CERT)
    expect(sessions).toEqual([
      { sessionId: 's1', externalSessionId: 'ext1', providerId: 'qoder', cwd: '/w/a', label: 'hello', ts: 20 },
      { sessionId: 's2', providerId: 'claude', cwd: '/w/b', label: 'pending', ts: 10 }
    ])
  })

  it('returns an honest empty session catalog when no source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    expect(gw.listSessions(CERT)).toEqual([])
  })

  it('reads one session\'s content for an authorized device, bounded and kind-filtered', async () => {
    const { authority } = await grantedAuthority()
    const read = vi.fn(async () => [
      { userText: 'hi', items: [
        { kind: 'output' as const, text: 'hello' },
        { kind: 'tool' as const, text: 'Read greet.js' },
        { kind: 'bogus' as unknown as 'output', text: 'dropped' },
        { kind: 'reasoning' as const, text: 5 as unknown as string }
      ] }
    ])
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const gw = new RemoteGateway({ authority, ledger, history: { read } })
    await expect(gw.readHistory('f'.repeat(64), { providerId: 'qoder', cwd: '/w', externalSessionId: 'ext1' }))
      .rejects.toThrow(/device_not_authorized/)
    const turns = await gw.readHistory(CERT, { providerId: 'qoder', cwd: '/w', externalSessionId: 'ext1' })
    expect(turns).toEqual([{ userText: 'hi', items: [{ kind: 'output', text: 'hello' }, { kind: 'tool', text: 'Read greet.js' }] }])
    expect(read).toHaveBeenCalledWith({ providerId: 'qoder', cwd: '/w', externalSessionId: 'ext1' })
  })

  it('returns an honest empty transcript when no history source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    await expect(gw.readHistory(CERT, { providerId: 'qoder', cwd: '/w', externalSessionId: 'x' })).resolves.toEqual([])
  })

  it('stops offering projects to a device the instant its grant is revoked', async () => {
    const { authority, deviceId } = await grantedAuthority()
    const { gw } = gateway(authority, { list: () => [{ path: '/Projects/x', label: 'x' }] })
    expect(gw.listProjects(CERT)).toHaveLength(1)
    await authority.revoke(deviceId)
    expectCode(() => gw.listProjects(CERT), 'device_not_authorized')
  })

  it('denies the device immediately after its grant is revoked, keeping prior events', async () => {
    const { authority, deviceId } = await grantedAuthority()
    const { gw, ledger } = gateway(authority)
    const submit = gw.submitIntent(CERT, { intentId: randomUUID() })
    await authority.revoke(deviceId)
    expectCode(() => gw.submitIntent(CERT, { intentId: randomUUID() }), 'device_not_authorized')
    expectCode(() => gw.poll(CERT, { cursor: 0 }), 'device_not_authorized')
    expectCode(() => gw.runState(CERT, { runId: submit.runId }), 'device_not_authorized')
    expect(ledger.describe().events).toBe(1) // the durable record is not erased
  })
})
