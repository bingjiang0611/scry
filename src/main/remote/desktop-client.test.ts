import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureHostIdentity } from './host-identity'
import { generateDesktopDeviceIdentity, desktopTlsRequest, type DesktopSshTunnel } from './desktop-transport'
import { DesktopRemoteClient } from './desktop-client'
import { createHostController } from './host-controller-factory'
import { InnerMtlsHost } from './inner-mtls-host'
import { PairingTransport } from './pairing-transport'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'

const ssh = { hostname: 'desktop.example', username: 'scry', port: 22 }
const encrypt = (value: string): Buffer => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
const decrypt = (value: Buffer): string => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()

async function setup(setupOptions: { submitResponse?: () => unknown; unknownIntent?: boolean; encrypt?: typeof encrypt } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-'))
  const identity = await generateDesktopDeviceIdentity()
  const host = await ensureHostIdentity(join(directory, 'host'))
  const pairingId = randomUUID()
  const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: host.hostId, anchorPEM: host.caCertificatePEM, pairPort: 2201, runPort: 2202, pairingId, secret: 'pairing-secret', expiresAt: Date.now() + 60_000 })).toString('base64url')}`
  let phase: 'prove' | 'status' = 'prove'
  let tunnelCount = 0
  const tunnelShutdowns: Array<() => void> = []
  const tunnel = (): DesktopSshTunnel => {
    let alive = true
    const stop = (): void => { alive = false }
    tunnelShutdowns.push(stop)
    return { pairPath: `pair-${++tunnelCount}`, runPath: `run-${tunnelCount}`, get alive() { return alive }, close: async () => { stop() } }
  }
  const tlsRequest = async (options: { path: string; request: unknown }): Promise<unknown> => {
    const request = options.request as { operation?: string; requestId?: string; pairingId?: string }
    if (request.operation === 'pair.prove') {
      phase = 'status'
      return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.pending', pairingId, publicKeySHA256: identity.publicKeySHA256 }
    }
    if (request.operation === 'pair.status') {
      const verified = await host.verifyCSR(identity.csrPEM)
      const grant = await host.issue({ ...verified, deviceId: randomUUID() })
      return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.granted', pairingId, deviceId: grant.deviceId, certificatePEM: grant.certificatePEM,
        certificateSHA256: grant.certificateSHA256, expiresAt: grant.expiresAt, scope: 'g0_echo_only' }
    }
    if (phase === 'status' && (request as { op?: string }).op === 'desktop') return { desktop: { kind: 'info', protocol: 1, hostId: host.hostId, execution: 'canonical' } }
    if ((request as { op?: string }).op === 'submit') {
      if (setupOptions.submitResponse) return setupOptions.submitResponse()
      throw new Error('network_down')
    }
    if ((request as { op?: string }).op === 'intentStatus' && setupOptions.unknownIntent) return { error: 'unknown_intent' }
    if ((request as { op?: string }).op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
    return { error: 'unexpected_request' }
  }
  const client = new DesktopRemoteClient({ directory, encrypt: setupOptions.encrypt ?? encrypt, decrypt }, { generateIdentity: async () => identity, openTunnel: async () => tunnel(), tlsRequest })
  return { directory, host, invitation, client, phase: () => phase, tunnelCount: () => tunnelCount, dropTunnel: () => tunnelShutdowns.at(-1)!() }
}

describe('DesktopRemoteClient', () => {
  it('lists a fresh profile without touching secure storage, and fails pairing before networking when encryption fails', async () => {
    const unavailable = vi.fn(() => { throw new Error('secure_storage_unavailable') })
    const fixture = await setup({ encrypt: unavailable })
    try {
      await expect(fixture.client.list()).resolves.toEqual([])
      expect(unavailable).not.toHaveBeenCalled()
      await expect(access(join(fixture.directory, 'desktop-client.state'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fixture.client.pair({ label: 'Unsaved', ssh, invitation: fixture.invitation })).rejects.toThrow('secure_storage_unavailable')
      expect(unavailable).toHaveBeenCalledTimes(1)
      expect(fixture.tunnelCount()).toBe(0)
      await expect(fixture.client.list()).resolves.toEqual([])
      await expect(access(join(fixture.directory, 'desktop-client.state'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not turn an unreadable encrypted store into an empty profile', async () => {
    const fixture = await setup()
    let restored: DesktopRemoteClient | undefined
    try {
      await fixture.client.pair({ label: 'Saved', ssh, invitation: fixture.invitation })
      await fixture.client.dispose()
      restored = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt: () => { throw new Error('secure_storage_unavailable') } })
      await expect(restored.list()).rejects.toThrow('secure_storage_unavailable')
      await expect(access(join(fixture.directory, 'desktop-client.state'))).resolves.toBeUndefined()
    } finally { await restored?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('reports an exited SSH tunnel as disconnected and rejects unsent work without creating an unknown receipt', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Exited SSH', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      expect((await fixture.client.list())[0].state).toBe('connected')
      fixture.dropTunnel()
      expect((await fixture.client.list())[0].state).toBe('disconnected')
      await expect(fixture.client.submit(id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'never sent' })).rejects.toThrow('desktop_not_connected')
      await expect(fixture.client.intents(id)).resolves.toEqual([])
      await fixture.client.connect(id)
      expect((await fixture.client.list())[0].state).toBe('connected')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('persists an unknown submit receipt and never resends it after reconnect', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Test desktop', ssh, invitation: fixture.invitation })
      expect(pending.state).toBe('pending')
      const connectionId = pending.connection.id
      const paired = await fixture.client.finishPairing(connectionId)
      expect(paired.state).toBe('paired')
      await fixture.client.connect(connectionId)
      const receipt = await fixture.client.submit(connectionId, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'hello' })
      expect(receipt.status).toBe('unknown')
      await fixture.client.dispose()
      const restored = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt }, { generateIdentity: async () => await generateDesktopDeviceIdentity(), openTunnel: async () => ({ pairPath: 'unused', runPath: 'unused', alive: true, close: async () => {} }), tlsRequest: async () => { throw new Error('must_not_resend') } })
      await expect(restored.intents(connectionId)).resolves.toMatchObject([{ status: 'unknown', connectionId }])
      await expect(restored.submit(connectionId, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'again' })).rejects.toThrow('unknown_receipts_pending')
      await restored.dispose()
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps a durable unknown receipt when the submit acknowledgement is malformed', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded' }) })
    try {
      const pending = await fixture.client.pair({ label: 'Malformed ack', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'malformed' })
      expect(receipt.status).toBe('unknown')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toMatchObject([{ intentId: receipt.intentId, status: 'unknown' }])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps an absent host intent unknown instead of unlocking a resend', async () => {
    const fixture = await setup({ unknownIntent: true })
    try {
      const pending = await fixture.client.pair({ label: 'Absent intent', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'ambiguous' })
      const checked = await fixture.client.intentStatus(pending.connection.id, receipt.intentId)
      expect(checked).toMatchObject({ intentId: receipt.intentId, status: 'unknown' })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'resend' })).rejects.toThrow('unknown_receipts_pending')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not evict recorded runs merely to satisfy receipt capacity', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Capacity', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      for (let index = 0; index < 256; index++) await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: `run-${index}` })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'overflow' })).rejects.toThrow('intent_receipt_capacity_exceeded')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toHaveLength(256)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects invitations with a changed or malformed anchor', async () => {
    const fixture = await setup()
    try {
      const malformed = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: fixture.host.hostId, anchorPEM: 'not pem', pairPort: 1, runPort: 2, pairingId: randomUUID(), secret: 'secret', expiresAt: Date.now() + 1000 })).toString('base64url')}`
      await expect(fixture.client.pair({ label: 'bad', ssh, invitation: malformed })).rejects.toThrow('invalid_certificate')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})

describe('DesktopRemoteClient over real host TLS', () => {
  it('completes pairing, catalog, trace/history reads, submit lifecycle, and revocation on production wire', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-real-'))
    const identity = await ensureHostIdentity(join(directory, 'identity'))
    const binding = await createHostController({
      stateDirectory: directory,
      hostId: identity.hostId,
      anchorSHA256: identity.anchorSHA256,
      verifyCSR: identity.verifyCSR,
      issue: identity.issue,
      authorizeWorkspace: (cwd) => cwd,
      startRun: async ({ progress, runId }) => {
        progress(JSON.stringify({ event: 'bound', ledgerRunId: runId, scryRunId: 'run-real-1', providerId: 'claude', cwd: '/workspace' }))
        progress(JSON.stringify({ event: 'session', externalSessionId: 'session-real' }))
      },
      gate: new ProviderOperationGate(),
      createOutputStore: (path) => new RunOutputFileStore(path),
      listProjects: () => [{ path: '/workspace', label: 'workspace' }],
      listProviders: () => [{ id: 'claude', label: 'Claude', available: true }],
      listSessions: () => [{ sessionId: 'session-real', externalSessionId: 'session-real', providerId: 'claude', cwd: '/workspace', label: 'real', ts: Date.now() }],
      sessionCatalogRevision: () => 'revision-real',
      readDesktop: async (query) => query.kind === 'info'
        ? { kind: 'info', protocol: 1, hostId: identity.hostId, execution: 'canonical' }
        : query.kind === 'history'
          ? { kind: 'history', history: { turns: [], hasOlder: false, source: 'trace_archive', status: 'available' } }
          : { kind: 'trace', run: null }
    })
    const server = await identity.issueHostServer()
    const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
    const innerHost = new InnerMtlsHost({ controller: binding.controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
    const pairAddress = await pairingTransport.listen()
    const runAddress = await innerHost.listen()
    const wire: unknown[] = []
    let dropSubmitResponse = true
    const tlsRequest = async (options: { path: string; caPEM: string; certPEM: string; keyPEM: string; request: unknown; signal?: AbortSignal }): Promise<unknown> => {
      wire.push(options.request)
      const address = options.path === `pair:${pairAddress.port}` ? pairAddress : runAddress
      const response = await desktopTlsRequest({ ...options, path: undefined, host: address.host, port: address.port })
      if (dropSubmitResponse && (options.request as { op?: string }).op === 'submit') { dropSubmitResponse = false; throw new Error('response_lost_after_delivery') }
      return response
    }
    const openTunnel = async (): Promise<DesktopSshTunnel> => ({ pairPath: `pair:${pairAddress.port}`, runPath: `run:${runAddress.port}`, alive: true, close: async () => {} })
    const client = new DesktopRemoteClient({ directory: join(directory, 'client'), encrypt, decrypt }, { openTunnel, tlsRequest })
    try {
      const pairing = await binding.controller.authority.begin()
      const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: identity.hostId, anchorPEM: identity.caCertificatePEM, pairPort: pairAddress.port, runPort: runAddress.port, pairingId: pairing.pairingId, secret: pairing.secret, expiresAt: pairing.expiresAt })).toString('base64url')}`
      const pending = await client.pair({ label: 'real desktop', ssh, invitation })
      await binding.controller.authority.confirmLocal(pairing.pairingId, pending.publicKeySHA256)
      const paired = await client.finishPairing(pending.connection.id)
      expect(paired.state).toBe('paired')
      await client.connect(pending.connection.id)
      const catalog = await client.catalog(pending.connection.id)
      expect(catalog.projects).toEqual([{ path: '/workspace', label: 'workspace' }])
      expect(catalog.sessions[0].externalSessionId).toBe('session-real')
      await expect(client.history(pending.connection.id, { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-real' })).resolves.toMatchObject({ turns: [] })
      await expect(client.trace(pending.connection.id, { cwd: '/workspace', providerId: 'claude' }, 'run-real-1')).resolves.toBeNull()
      expect(wire).toContainEqual(expect.objectContaining({ op: 'desktop', query: expect.objectContaining({ kind: 'trace', runId: 'run-real-1' }) }))
      const unknownIntent = await client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'real wire' })
      expect(unknownIntent.status).toBe('unknown')
      const intent = await client.intentStatus(pending.connection.id, unknownIntent.intentId)
      expect(intent.status).toBe('recorded')
      await expect(client.runStatus(pending.connection.id, intent.runId!)).resolves.toMatchObject({ state: 'settled', scryRunId: 'run-real-1', externalSessionId: 'session-real' })
      await expect(client.runStatus(pending.connection.id, intent.runId!)).resolves.toMatchObject({ state: 'settled', scryRunId: 'run-real-1', externalSessionId: 'session-real' })
      const watches = wire.filter((request): request is { op: string; cursor: number } => (request as { op?: string }).op === 'watch')
      expect(watches[0]?.cursor).toBe(0)
      expect(watches[1]?.cursor).toBeGreaterThan(0)
      expect(wire.some((request) => (request as { op?: string }).op === 'desktop')).toBe(true)
      const wrongIdentity = await ensureHostIdentity(join(directory, 'wrong-anchor'))
      const changedInvitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: identity.hostId, anchorPEM: wrongIdentity.caCertificatePEM, pairPort: pairAddress.port, runPort: runAddress.port, pairingId: randomUUID(), secret: Buffer.from('changed-secret').toString('base64url'), expiresAt: Date.now() + 60_000 })).toString('base64url')}`
      await expect(client.pair({ label: 'changed anchor', ssh, invitation: changedInvitation })).rejects.toThrow('host_anchor_changed_forget_required')
      const wrongPairing = await ensureHostIdentity(join(directory, 'wrong-ca'))
      const wrongCaInvitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: wrongPairing.hostId, anchorPEM: wrongPairing.caCertificatePEM, pairPort: pairAddress.port, runPort: runAddress.port, pairingId: randomUUID(), secret: Buffer.from('wrong-secret').toString('base64url'), expiresAt: Date.now() + 60_000 })).toString('base64url')}`
      await expect(client.pair({ label: 'wrong CA', ssh, invitation: wrongCaInvitation })).rejects.toThrow()
      const grant = binding.controller.authority.inspectLocal().grants[0]
      await binding.controller.authority.revoke(grant.deviceId)
      await expect(client.catalog(pending.connection.id)).rejects.toThrow('desktop_remote_device_not_authorized')
    } finally {
      await client.dispose()
      await innerHost.close()
      await pairingTransport.close()
      await binding.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
