import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PairingAuthority, type IssuedPairingCertificate, type PairingDependencies, type PairingPersistence, type PairingState } from './pairing'
import { SessionLedger, type LedgerEvent, type LedgerStore } from './session-ledger'
import { RemoteGateway, RemoteGatewayError, type RemoteDirectoryListing, type RemoteProviderRef } from './remote-gateway'
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
  providers?: { list(): RemoteProviderRef[] },
  sessions?: { list(): { sessionId: string; externalSessionId?: string; providerId: string; cwd: string; label: string; ts: number; pinnedAt?: number }[]; revision?: () => string },
  directories?: { list(path?: string): RemoteDirectoryListing },
  commands?: { list(query: { providerId: string; cwd: string; agentProfileId?: string }): Promise<{ commands: { name: string; description: string; argumentHint?: string; source?: 'builtin' | 'skill' | 'mcp' | 'custom' }[]; reason?: string }> }
) {
  const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
  return { gw: new RemoteGateway({ authority, ledger, ...(projects ? { projects } : {}), ...(output ? { output } : {}), ...(providers ? { providers } : {}), ...(sessions ? { sessions } : {}), ...(directories ? { directories } : {}), ...(commands ? { commands } : {}) }), ledger }
}

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); throw new Error('expected throw ' + code) }
  catch (error) {
    expect(error).toBeInstanceOf(RemoteGatewayError)
    expect((error as RemoteGatewayError).code).toBe(code)
  }
}

describe('RemoteGateway', () => {
  it('authenticates workspace reads before parsing/access and rechecks revocation', async () => {
    const { authority, deviceId } = await grantedAuthority()
    const read = vi.fn(async () => ({ action: 'list' as const, listing: { entries: [], truncated: false } }))
    const gw = new RemoteGateway({ authority, ledger: new SessionLedger({ store: new MemoryLedgerStore() }), workspace: { read } })
    await expect(gw.readWorkspace('f'.repeat(64), null)).rejects.toMatchObject({ code: 'device_not_authorized' })
    expect(read).not.toHaveBeenCalled()
    await expect(gw.readWorkspace(CERT, { action: 'write', cwd: '/x' })).rejects.toThrow('invalid_request')
    expect(read).not.toHaveBeenCalled()
    const query = { action: 'list', cwd: '/x', path: '' }
    await expect(gw.readWorkspace(CERT, query)).resolves.toMatchObject({ action: 'list' })
    expect(read).toHaveBeenCalledTimes(1)
    await authority.revoke(deviceId)
    await expect(gw.readWorkspace(CERT, query)).rejects.toMatchObject({ code: 'device_not_authorized' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('denies every operation to an unauthorized certificate and never mutates the ledger', async () => {
    const { authority } = await grantedAuthority()
    const { gw, ledger } = gateway(authority)
    const stranger = 'f'.repeat(64)
    expectCode(() => gw.submitIntent(stranger, { intentId: randomUUID() }), 'device_not_authorized')
    expectCode(() => gw.poll(stranger, { cursor: 0 }), 'device_not_authorized')
    expectCode(() => gw.runState(stranger, { runId: randomUUID() }), 'device_not_authorized')
    await expect(gw.pollOutput(stranger, { runId: randomUUID(), cursor: 0 })).rejects.toMatchObject({ code: 'device_not_authorized' })
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

    const page = await gw.pollOutput(CERT, { runId, cursor: 0 })
    expect(page.chunks.map((c) => c.kind)).toEqual(['output', 'tool'])
    expect(page.chunks[0].text).toBe('Hello from the agent')
    // Strictly-after-cursor paging.
    const after = await gw.pollOutput(CERT, { runId, cursor: page.chunks[0].seq })
    expect(after.chunks.map((c) => c.kind)).toEqual(['tool'])
    // Unknown run => honest empty page at the same cursor, never fabricated.
    await expect(gw.pollOutput(CERT, { runId: randomUUID(), cursor: 0 })).resolves.toEqual({ chunks: [], cursor: 0 })
    // Revoked device loses output access like every other op.
    await authority.revoke(deviceId)
    await expect(gw.pollOutput(CERT, { runId, cursor: 0 })).rejects.toMatchObject({ code: 'device_not_authorized' })
  })

  it('returns an honest empty output page when no output source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    await expect(gw.pollOutput(CERT, { runId: randomUUID(), cursor: 0 })).resolves.toEqual({ chunks: [], cursor: 0 })
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

  it('scopes client intent ids to the authenticated device and rejects conflicting retries', () => {
    const firstCert = '1'.repeat(64)
    const secondCert = '2'.repeat(64)
    const { gw, ledger } = gateway({ authorizesCertificate: (fingerprint) => fingerprint === firstCert || fingerprint === secondCert })
    const intentId = randomUUID()
    const first = gw.submitIntent(firstCert, { intentId, detail: 'first device' })
    const second = gw.submitIntent(secondCert, { intentId, detail: 'second device' })
    expect(first.status).toBe('recorded')
    expect(second.status).toBe('recorded')
    expect(second.runId).not.toBe(first.runId)
    expect(ledger.describe().events).toBe(2)
    expect(() => gw.submitIntent(firstCert, { intentId, detail: 'changed payload' })).toThrow('intent_payload_conflict')
    expect(ledger.describe().events).toBe(2)
  })

  // A lost submit receipt used to leave the phone with only one recovery: resend
  // the whole intent (prompt + base64 image). Reconciliation is now a read.
  it('reconciles a lost receipt by intent id without resending, scoped to the device', () => {
    const firstCert = '1'.repeat(64)
    const secondCert = '2'.repeat(64)
    const { gw, ledger } = gateway({ authorizesCertificate: (fingerprint) => fingerprint === firstCert || fingerprint === secondCert })
    const intentId = randomUUID()
    expectCode(() => gw.intentStatus(firstCert, { intentId }), 'unknown_intent')
    const submitted = gw.submitIntent(firstCert, { intentId, detail: 'with attachment' })
    ledger.markDispatched(submitted.runId)
    expect(gw.intentStatus(firstCert, { intentId })).toEqual({ runId: submitted.runId, state: 'dispatched' })
    // Another device cannot probe this device's intent ids.
    expectCode(() => gw.intentStatus(secondCert, { intentId }), 'unknown_intent')
    expectCode(() => gw.intentStatus('3'.repeat(64), { intentId }), 'device_not_authorized')
    expect(ledger.describe().events).toBe(2)
  })

  it('does not echo the intent body back to devices through poll', async () => {
    const { authority } = await grantedAuthority()
    const { gw, ledger } = gateway(authority)
    const submit = gw.submitIntent(CERT, { intentId: randomUUID(), detail: '{"prompt":"x","attachments":[{"dataBase64":"AAAA"}]}' })
    ledger.markDispatched(submit.runId)
    ledger.markProgress(submit.runId, '{"event":"started"}')
    const events = gw.poll(CERT, { cursor: 0 }).events
    expect(events[0]).toMatchObject({ kind: 'intent_recorded', runId: submit.runId })
    expect(events[0]).not.toHaveProperty('detail')
    // Lifecycle markers the device does use keep their detail.
    expect(events[2]).toMatchObject({ kind: 'run_progress', detail: '{"event":"started"}' })
    // The host's own dispatch input is untouched.
    expect(ledger.since(0).events[0].detail).toContain('dataBase64')
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

  it('authorizes and bounds each folder-hierarchy level returned by the host source', async () => {
    const { authority } = await grantedAuthority()
    const list = vi.fn((path?: string): RemoteDirectoryListing => path ? {
      current: { path, label: 'src' },
      parent: { path: '/Projects/scry', label: 'scry' },
      directories: [
        { path: `${path}/main`, label: 'main' },
        { path: `${path}/main`, label: 'duplicate' },
        { path: '', label: 'invalid' }
      ]
    } : { directories: [{ path: '/Projects/scry', label: 'scry' }] })
    const { gw } = gateway(authority, undefined, undefined, undefined, undefined, { list })

    expectCode(() => gw.listDirectories('f'.repeat(64), {}), 'device_not_authorized')
    expect(gw.listDirectories(CERT, {})).toEqual({ directories: [{ path: '/Projects/scry', label: 'scry' }] })
    expect(gw.listDirectories(CERT, { path: '/Projects/scry/src' })).toEqual({
      current: { path: '/Projects/scry/src', label: 'src' },
      parent: { path: '/Projects/scry', label: 'scry' },
      directories: [{ path: '/Projects/scry/src/main', label: 'main' }]
    })
    expectCode(() => gw.listDirectories(CERT, { path: '' }), 'invalid_target')
  })

  it('pages every directory with a stable snapshot fence', async () => {
    const { authority } = await grantedAuthority()
    let entries = Array.from({ length: 245 }, (_, index) => ({ path: `/repo/d${index}`, label: `d${index}` }))
    const { gw } = gateway(authority, undefined, undefined, undefined, undefined, {
      list: () => ({ current: { path: '/repo', label: 'repo' }, directories: entries })
    })
    const collected: string[] = []
    let cursor = 0
    let snapshot: string | undefined
    do {
      const page = gw.listDirectoriesPage(CERT, { path: '/repo', cursor, limit: 37, ...(snapshot ? { snapshot } : {}) })
      snapshot ??= page.snapshot
      expect(page.directories.length).toBeLessThanOrEqual(37)
      collected.push(...page.directories.map((entry) => entry.path))
      cursor = page.cursor
      if (!page.hasMore) break
    } while (true)
    expect(collected).toEqual(entries.map((entry) => entry.path))
    entries = [...entries, { path: '/repo/new', label: 'new' }]
    expectCode(() => gw.listDirectoriesPage(CERT, { path: '/repo', cursor: 0, snapshot }), 'directory_snapshot_changed')
  })

  it('lists host Providers only for an authorized device, deduped/bounded, availability preserved', async () => {
    const { authority } = await grantedAuthority()
    const list = vi.fn(() => [
      { id: 'qoder', label: 'Qoder', available: true, modelId: 'qoder-default',
        models: [
          { id: 'qoder-default', providerId: 'upstream-a', label: 'Qoder A', isDefault: true,
            efforts: [{ id: 'high', label: '高', isDefault: true }] },
          { id: 'qoder-default', providerId: 'upstream-b', label: 'Qoder B' }
        ],
        efforts: [{ id: 'high', label: '高', isDefault: true }],
        permissions: [{ id: 'default', label: '默认审批', description: '由 Provider 决定' }] },
      { id: 'qoder', label: 'Qoder dup', available: true }, // duplicate default context dropped
      { id: 'qoder', agentProfileId: 'profile-a', label: 'Qoder · Profile A', available: true },
      { id: 'claude', label: 'Claude', available: false },
      { id: '', label: 'empty-id-dropped', available: true },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, label: `p${i}`, available: true }))
    ])
    const { gw } = gateway(authority, undefined, undefined, { list })
    expectCode(() => gw.listProviders('f'.repeat(64)), 'device_not_authorized')
    const providers = gw.listProviders(CERT)
    expect(providers.length).toBe(32) // MAX_PROVIDERS bound
    expect(providers.slice(0, 3)).toEqual([
      { id: 'qoder', label: 'Qoder', available: true },
      { id: 'qoder', agentProfileId: 'profile-a', label: 'Qoder · Profile A', available: true },
      { id: 'claude', label: 'Claude', available: false }
    ])
    expect(providers.some((p) => p.id === '')).toBe(false)
  })

  it('resolves controls only for the selected authorized context', async () => {
    const { authority } = await grantedAuthority()
    const selected = vi.fn(async (query: { detail: 'selected'; providerId: string; cwd: string; agentProfileId?: string }) => ({
      id: query.providerId, label: 'Selected', available: true,
      agentProfileId: query.agentProfileId,
      permissions: [{ id: 'default', label: 'Default' }]
    }))
    const gw = new RemoteGateway({ authority, ledger: new SessionLedger({ store: new MemoryLedgerStore() }), providers: {
      list: () => [{ id: 'claude', label: 'Claude', available: true }], selected
    } })
    expect(gw.listProviders(CERT)).toEqual([{ id: 'claude', label: 'Claude', available: true }])
    expect(selected).not.toHaveBeenCalled()
    await expect(gw.listProviderControls(CERT, { detail: 'selected', providerId: 'claude', cwd: '/authorized' })).resolves.toMatchObject({ id: 'claude', permissions: [{ id: 'default' }] })
    expect(selected).toHaveBeenCalledExactlyOnceWith({ detail: 'selected', providerId: 'claude', cwd: '/authorized' })
    await expect(gw.listProviderControls(CERT, { detail: 'selected', providerId: 'claude', cwd: '' })).rejects.toMatchObject({ code: 'invalid_provider_context' })
    await expect(gw.listProviderControls(CERT, { detail: 'selected', providerId: 'qoder', cwd: '/authorized' })).rejects.toMatchObject({ code: 'provider_not_authorized' })
    expect(selected).toHaveBeenCalledTimes(1)
  })

  it('returns an honest empty provider list when no source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    expect(gw.listProviders(CERT)).toEqual([])
  })

  it('authorizes, scopes, sanitizes and bounds native slash commands', async () => {
    const { authority } = await grantedAuthority()
    const list = vi.fn(async () => ({ commands: [
      { name: '/review', description: 'Review changes', argumentHint: '[path]', source: 'builtin' as const },
      { name: 'review', description: 'duplicate' },
      { name: 'bad command', description: 'invalid whitespace' },
      ...Array.from({ length: 300 }, (_, index) => ({ name: `cmd-${index}`, description: 'x'.repeat(700) }))
    ] }))
    const { gw } = gateway(authority, undefined, undefined, undefined, undefined, undefined, { list })

    await expect(gw.listCommands('f'.repeat(64), { providerId: 'codex', cwd: '/repo' }))
      .rejects.toMatchObject({ code: 'device_not_authorized' })
    const catalog = await gw.listCommands(CERT, { providerId: 'codex', cwd: '/repo', agentProfileId: 'profile' })
    expect(list).toHaveBeenCalledWith({ providerId: 'codex', cwd: '/repo', agentProfileId: 'profile' })
    expect(catalog.commands).toHaveLength(256)
    expect(catalog.commands[0]).toEqual({ name: 'review', description: 'Review changes', argumentHint: '[path]', source: 'builtin' })
    expect(catalog.commands.some((command) => command.name === 'bad command')).toBe(false)
    expect(catalog.commands.at(-1)?.description.length).toBe(512)
  })

  it('lists the host session catalog only for an authorized device, deduped/bounded, resumable id preserved', async () => {
    const { authority } = await grantedAuthority()
    const list = vi.fn(() => [
      { sessionId: 's1', externalSessionId: 'ext1', providerId: 'qoder', cwd: '/w/a', label: 'hello', ts: 20, pinnedAt: 30, isActive: true },
      { sessionId: 's1', externalSessionId: 'ext1', providerId: 'qoder', cwd: '/w/a', label: 'dup', ts: 21 }, // dup id dropped
      { sessionId: 's2', providerId: 'claude', cwd: '/w/b', label: 'pending', ts: 10, archivedAt: 40, pinnedAt: 35 }, // no externalSessionId
      { sessionId: '', providerId: 'qoder', cwd: '/w', label: 'empty-id', ts: 5 }
    ])
    const { gw } = gateway(authority, undefined, undefined, undefined, { list })
    expectCode(() => gw.listSessions('f'.repeat(64)), 'device_not_authorized')
    const sessions = gw.listSessions(CERT)
    expect(sessions).toEqual([
      { sessionId: 's1', externalSessionId: 'ext1', providerId: 'qoder', cwd: '/w/a', label: 'hello', ts: 20, pinnedAt: 30, isActive: true }
    ])
    expect(gw.listSessionsPage(CERT, {}).sessions).toEqual(sessions)
    expect(gw.listSessionsPage(CERT, { includeArchived: true }).sessions).toEqual([
      ...sessions, { sessionId: 's2', providerId: 'claude', cwd: '/w/b', label: 'pending', ts: 10, archivedAt: 40, pinnedAt: 35 }
    ])
    expect(gw.listSessionsPage(CERT, {}).sessions).toEqual(sessions)
  })

  it('pages the complete session catalog and rejects a changed snapshot', async () => {
    const { authority } = await grantedAuthority()
    let entries = Array.from({ length: 350 }, (_, index) => ({
      sessionId: `s${index}`, providerId: 'codex', cwd: '/repo', label: `session ${index}`, ts: index
    }))
    const { gw } = gateway(authority, undefined, undefined, undefined, { list: () => entries })
    const collected: string[] = []
    let cursor = 0
    let snapshot: string | undefined
    do {
      const page = gw.listSessionsPage(CERT, { cursor, limit: 41, ...(snapshot ? { snapshot } : {}) })
      snapshot ??= page.snapshot
      expect(page.sessions.length).toBeLessThanOrEqual(41)
      collected.push(...page.sessions.map((entry) => entry.sessionId))
      cursor = page.cursor
      if (!page.hasMore) break
    } while (true)
    expect(collected).toEqual(entries.map((entry) => entry.sessionId))
    entries = entries.slice(1)
    expectCode(() => gw.listSessionsPage(CERT, { cursor: 0, snapshot }), 'session_snapshot_changed')
  })

  it('freezes a production revision-backed session catalog across pages', async () => {
    const { authority } = await grantedAuthority()
    let suffix = ''
    const list = vi.fn(() => Array.from({ length: 245 }, (_, index) => ({
      sessionId: `session-${index}${suffix}`, externalSessionId: `external-${index}`, providerId: 'pi', cwd: '/repo', label: `s${index}`, ts: index
    })))
    const revision = vi.fn(() => suffix || 'revision-1')
    const { gw } = gateway(authority, undefined, undefined, undefined, { list, revision })
    const first = gw.listSessionsPage(CERT, { cursor: 0, limit: 100 })
    const second = gw.listSessionsPage(CERT, { cursor: first.cursor, limit: 100, snapshot: first.snapshot })
    expect(first.sessions.length + second.sessions.length).toBe(200)
    expect(list).toHaveBeenCalledTimes(1)
    suffix = '-changed'
    revision.mockReturnValue('revision-2')
    expect(() => gw.listSessionsPage(CERT, { cursor: second.cursor, limit: 100, snapshot: first.snapshot })).toThrow('session_snapshot_changed')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps a frozen walk stable across metadata mutation but refreshes cursor zero', async () => {
    const { authority } = await grantedAuthority()
    let label = 'before'
    const list = vi.fn(() => [{ sessionId: 's', providerId: 'pi', cwd: '/repo', label, ts: 1 }])
    const { gw } = gateway(authority, undefined, undefined, undefined, { list, revision: () => 'roots-v1' })
    const first = gw.listSessionsPage(CERT, { cursor: 0, limit: 1 })
    label = 'after'
    const continued = gw.listSessionsPage(CERT, { cursor: 0, limit: 1, snapshot: first.snapshot })
    expect(continued.sessions[0].label).toBe('before')
    const fresh = gw.listSessionsPage(CERT, { cursor: 0, limit: 1 })
    expect(fresh.sessions[0].label).toBe('after')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('returns an honest empty session catalog when no source is configured', async () => {
    const { authority } = await grantedAuthority()
    const { gw } = gateway(authority)
    expect(gw.listSessions(CERT)).toEqual([])
  })

  it('serves a bounded structured preview without turning unavailable into empty history', async () => {
    const { authority } = await grantedAuthority()
    const readPreview = vi.fn(async ({ providerId }: { providerId: string }) => (providerId === 'claude'
      ? { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
      : { status: 'available' as const, source: 'indexed_archive' as const, partial: true as const, truncated: false, bytes: 0, turns: [{
      userText: '问🙂'.repeat(2_000), userTextTruncated: false, truncated: false,
      items: [{ kind: 'output' as const, text: '答🙂'.repeat(2_000), truncated: false }, { kind: 'tool' as const, text: 'second', truncated: false }, { kind: 'output' as const, text: 'dropped', truncated: false }]
    }] }))
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const gw = new RemoteGateway({ authority, ledger, historyPreview: { read: readPreview } })
    const preview = await gw.readHistoryPreview(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'ext1' })
    expect(preview.status).toBe('available')
    if (preview.status === 'available') {
      expect(preview.turns).toHaveLength(1)
      expect(preview.turns[0].items).toHaveLength(2)
      expect(preview.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(preview), 'utf8')).toBeLessThanOrEqual(16 * 1024)
      expect(preview.turns[0].userText.endsWith('🙂')).toBe(true)
    }
    await expect(gw.readHistoryPreview(CERT, { providerId: 'claude', cwd: '/w', externalSessionId: 'missing' })).resolves.toEqual({ status: 'unavailable', reason: 'no_fast_evidence' })
    expect(readPreview).toHaveBeenCalledTimes(2)
  })

  it('keeps genuine escaped preview content and reports exact encoded bytes', async () => {
    const { authority } = await grantedAuthority()
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const gw = new RemoteGateway({ authority, ledger, historyPreview: { read: async () => ({
      status: 'available', source: 'indexed_archive', partial: true, truncated: false, bytes: 0,
      turns: [0, 1].map(() => ({ userText: '\u0000'.repeat(1_024), userTextTruncated: true, truncated: false,
        items: [0, 1, 2].map(() => ({ kind: 'output' as const, text: '\u0000'.repeat(1_024), truncated: false })) }))
    }) } })
    const preview = await gw.readHistoryPreview(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'escaped' })
    expect(preview.status).toBe('available')
    if (preview.status !== 'available') throw new Error('preview unavailable')
    expect(preview.turns).toHaveLength(2)
    expect(preview.turns.every((turn) => turn.userText.length > 0 && turn.items.length === 2 && turn.truncated && turn.userTextTruncated)).toBe(true)
    expect(preview.bytes).toBe(Buffer.byteLength(JSON.stringify(preview), 'utf8'))
    expect(preview.bytes).toBeLessThanOrEqual(16 * 1_024)
    expect(preview.truncated).toBe(true)
  })

  it('refuses preview source access for an unauthorized device', async () => {
    const { authority } = await grantedAuthority()
    const readPreview = vi.fn(async () => ({ status: 'available' as const, source: 'indexed_archive' as const, partial: true as const, truncated: false, bytes: 0, turns: [] }))
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const gw = new RemoteGateway({ authority, ledger, historyPreview: { read: readPreview } })
    await expect(gw.readHistoryPreview('f'.repeat(64), { providerId: 'pi', cwd: '/w', externalSessionId: 'x' })).rejects.toThrow('device_not_authorized')
    expect(readPreview).not.toHaveBeenCalled()
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

  it('bounds the serialized history below the device transport frame limit', async () => {
    const { authority } = await grantedAuthority()
    const read = vi.fn(async () => [{
      userText: 'large history',
      items: Array.from({ length: 450 }, (_, index) => ({
        kind: 'output' as const,
        // Include JSON-escaped content so the budget covers wire bytes, not just
        // source character count.
        text: `${index}: ${'"\\\n'.repeat(6_000)}`
      }))
    }])
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const gw = new RemoteGateway({ authority, ledger, history: { read } })
    const turns = await gw.readHistory(CERT, { providerId: 'qoder', cwd: '/w', externalSessionId: 'large' })
    expect(turns).toHaveLength(1)
    expect(turns[0].items.length).toBeGreaterThan(0)
    expect(turns[0].items.length).toBeLessThan(450)
    expect(Buffer.byteLength(JSON.stringify(turns), 'utf8')).toBeLessThanOrEqual(6 * 1024 * 1024)
  })

  it('shares concurrent assembly and extends an actively read frozen snapshot', async () => {
    const { authority } = await grantedAuthority()
    const turns = [{ userText: '问🙂\\\n', items: [{ kind: 'output' as const, text: 'x'.repeat(600_000) }] }]
    const read = vi.fn(async () => turns)
    const gw = new RemoteGateway({ authority, ledger: new SessionLedger({ store: new MemoryLedgerStore() }), history: { read } })
    const query = { providerId: 'pi', cwd: '/w', externalSessionId: 'shared' }
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const [small, large] = await Promise.all([
        gw.readHistoryPage(CERT, { ...query, limit: 64 * 1024 }),
        gw.readHistoryPage(CERT, { ...query, limit: 256 * 1024 })
      ])
      expect(read).toHaveBeenCalledTimes(1)
      expect(large.snapshot).toBe(small.snapshot)
      expect(Buffer.from(large.dataBase64, 'base64')).toHaveLength(256 * 1024)
      read.mockResolvedValue([{ userText: 'new turn', items: [] }])
      for (let index = 0; index < 3; index++) {
        now += 20_000
        expect((await gw.readHistoryPage(CERT, { ...query, snapshot: large.snapshot, cursor: 0 })).snapshot).toBe(large.snapshot)
      }
      expect(read).toHaveBeenCalledTimes(1)
      now += 30_001
      await expect(gw.readHistoryPage(CERT, { ...query, snapshot: large.snapshot })).rejects.toThrow('history_snapshot_changed')
      expect(read).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })

  it('pages complete history bytes with a restart-stable snapshot fence', async () => {
    const { authority } = await grantedAuthority()
    const expected = [{ userText: '问🙂'.repeat(30_000), items: [
      { kind: 'output' as const, text: '答'.repeat(300_000) },
      { kind: 'tool_result' as const, text: 'result'.repeat(50_000) }
    ] }]
    const read = vi.fn(async () => expected)
    const ledger = new SessionLedger({ store: new MemoryLedgerStore() })
    const gw = new RemoteGateway({ authority, ledger, history: { read } })
    const chunks: Buffer[] = []
    let cursor = 0
    let snapshot: string | undefined
    do {
      const page = await gw.readHistoryPage(CERT, {
        providerId: 'qoder', cwd: '/w', externalSessionId: 'complete', cursor, limit: 65_535, ...(snapshot ? { snapshot } : {})
      })
      snapshot ??= page.snapshot
      expect(page.snapshot).toBe(snapshot)
      chunks.push(Buffer.from(page.dataBase64, 'base64'))
      cursor = page.cursor
      if (!page.hasMore) break
    } while (true)
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(expected)
    await expect(gw.readHistoryPage(CERT, {
      providerId: 'qoder', cwd: '/w', externalSessionId: 'complete', cursor: 0, limit: 262_145
    })).rejects.toThrow('invalid_history_limit')
    await expect(gw.readHistoryPage(CERT, {
      providerId: 'qoder', cwd: '/w', externalSessionId: 'complete', cursor: cursor + 1, snapshot
    })).rejects.toThrow('invalid_history_cursor')

    // A supplied snapshot drains the immutable cached bytes even when the live
    // source changes between pages. This is required for active Mac sessions.
    read.mockResolvedValueOnce([{ userText: 'changed', items: [] }])
    const replay = await gw.readHistoryPage(CERT, {
      providerId: 'qoder', cwd: '/w', externalSessionId: 'complete', cursor: 0, snapshot
    })
    expect(replay.snapshot).toBe(snapshot)
    await expect(gw.readHistoryPage(CERT, {
      providerId: 'qoder', cwd: '/w', externalSessionId: 'complete', cursor: 0, snapshot: '0'.repeat(64)
    })).rejects.toThrow('history_snapshot_changed')
  })

  it('pages complete recent and older structured turns with an exact snapshot fence', async () => {
    const { authority } = await grantedAuthority()
    let version = 'v1'
    const read = vi.fn(async ({ before, snapshot }: { before?: number; snapshot?: string }) => {
      const all = ['old-0', 'old-1', 'recent-0', 'recent-1']
      const current = `snapshot-${version}`
      if (snapshot && snapshot !== current) throw new Error('history_snapshot_changed')
      const end = before ?? all.length
      const start = Math.max(0, end - 2)
      return { turns: all.slice(start, end).map(userText => ({ userText, items: [{ kind: 'output' as const, text: userText }] })), offset: start, totalTurns: all.length, hasOlder: start > 0, snapshot: current, source: 'indexed_archive' as const, completeness: start === 0 && end === all.length ? 'complete' as const : 'partial' as const }
    })
    const gw = new RemoteGateway({ authority, ledger: new SessionLedger({ store: new MemoryLedgerStore() }), historyTurnsPage: { read } })
    const recent = await gw.readHistoryTurnsPage(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'x', limit: 2 })
    expect(recent.turns.map(turn => turn.userText)).toEqual(['recent-0', 'recent-1'])
    const older = await gw.readHistoryTurnsPage(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'x', before: recent.offset, snapshot: recent.snapshot, limit: 2 })
    expect(older.turns.map(turn => turn.userText)).toEqual(['old-0', 'old-1'])
    // Reaching offset zero does not make this older-only response the whole history.
    expect(older.completeness).toBe('partial')
    version = 'v2'
    await expect(gw.readHistoryTurnsPage(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'x', before: recent.offset, snapshot: recent.snapshot })).rejects.toThrow('history_snapshot_changed')
  })

  it('fits a large window by leaving whole older turns behind a cursor, not clipping their bodies', async () => {
    const { authority } = await grantedAuthority()
    const text = 'x'.repeat(4 * 1024 * 1024)
    const gw = new RemoteGateway({ authority, ledger: new SessionLedger({ store: new MemoryLedgerStore() }), historyTurnsPage: { read: async ({ before }) => ({
      turns: (before === 1 ? ['older'] : ['older', 'recent']).map(userText => ({ userText, items: [{ kind: 'output' as const, text }] })),
      offset: 0, totalTurns: 2, hasOlder: false, snapshot: 'large-window', source: 'indexed_archive' as const,
      completeness: before === 1 ? 'partial' as const : 'complete' as const
    }) } })
    const recent = await gw.readHistoryTurnsPage(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'x', limit: 3 })
    expect(recent).toMatchObject({ offset: 1, totalTurns: 2, hasOlder: true, completeness: 'partial' })
    expect(recent.turns).toEqual([{ userText: 'recent', items: [{ kind: 'output', text }] }])
    const older = await gw.readHistoryTurnsPage(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'x', before: recent.offset, snapshot: recent.snapshot, limit: 3 })
    expect(older.turns).toEqual([{ userText: 'older', items: [{ kind: 'output', text }] }])
  })

  it('reports structured capacity instead of clipping a large turn', async () => {
    const { authority } = await grantedAuthority()
    const gw = new RemoteGateway({ authority, ledger: new SessionLedger({ store: new MemoryLedgerStore() }), historyTurnsPage: { read: async () => ({
      turns: [{ userText: 'large', items: [{ kind: 'output' as const, text: 'x'.repeat(7 * 1024 * 1024) }] }], offset: 0, totalTurns: 1, hasOlder: false,
      snapshot: 'large', source: 'monolithic' as const, completeness: 'complete' as const
    }) } })
    await expect(gw.readHistoryTurnsPage(CERT, { providerId: 'pi', cwd: '/w', externalSessionId: 'x' })).rejects.toThrow('history_capacity_exceeded')
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
