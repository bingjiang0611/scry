import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import 'reflect-metadata'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity, type HostIdentity } from './host-identity'
import { HostController, type RemoteIntentRouting, type RemoteHistoryPreview } from './host-controller'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { InnerMtlsHost } from './inner-mtls-host'
import { ExecutionTargetRouter } from './execution-targets'
import { providerDiscoveryFixture } from './provider-discovery.fixture'
import { ProviderOperationGate } from '../provider-operation-gate'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../../shared/runtime'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function deviceKeyAndCSR() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return { keyPEM, csrPEM: csr.toString('pem') }
}

async function harness(
  runProvider: (i: {
    runId: string
    routing: RemoteIntentRouting
    progress(d?: string): void
    requestUserInput(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
  }) => Promise<void>,
  listCommands?: (query: { providerId: string; cwd: string; agentProfileId?: string }) => Promise<{ commands: { name: string; description: string }[] }>,
  readHistory?: (query: { providerId: string; cwd: string; externalSessionId: string }) => Promise<Array<{ userText: string; items: Array<{ kind: 'output'; text: string }> }>>,
  lists?: {
    directories(path?: string): { current?: { path: string; label: string }; directories: { path: string; label: string }[] }
    sessions(): { sessionId: string; providerId: string; cwd: string; label: string; ts: number }[]
  },
  readHistoryPreview?: (query: { providerId: string; cwd: string; externalSessionId: string }) => Promise<RemoteHistoryPreview>,
  targetClient?: ConstructorParameters<typeof ExecutionTargetRouter>[0]['client'],
  providerDiscovery?: Pick<Parameters<typeof createHostController>[0], 'listProviders' | 'listProviderControls' | 'listProvidersFull'>
) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-mtls-')); dirs.push(dir)
  const identity: HostIdentity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = await createHostController({
    stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun: runProvider, gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: (directory) => new RunOutputFileStore(directory),
    ...(listCommands ? { listCommands } : {}),
    ...(readHistory ? { readHistory } : {}),
    ...(readHistoryPreview ? { readHistoryPreview } : {}),
    ...(providerDiscovery ? { ...providerDiscovery, readDesktop: async () => ({ kind: 'info' as const, protocol: REMOTE_PROTOCOL_VERSION, hostId: identity.hostId, execution: 'canonical' as const }) } : {}),
    ...(lists ? { listDirectories: lists.directories, listSessions: lists.sessions } : {})
  })
  cleanups.push(() => binding.close())
  const controller: HostController = binding.controller
  const server = await identity.issueHostServer()
  const executionTargets = targetClient ? new ExecutionTargetRouter({
    authorizePeer: (peer) => controller.authorizeDevicePeer(peer), client: targetClient,
    gateway: { hostId: identity.hostId, label: 'Mac1' }
  }) : undefined
  const host = new InnerMtlsHost({ controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM, ...(executionTargets ? { executionTargets } : {}) })
  const addr = await host.listen()
  cleanups.push(() => host.close())
  return { identity, controller, caPEM: identity.caCertificatePEM, addr, host }
}

async function pairDevice(identity: HostIdentity, controller: HostController) {
  const { keyPEM, csrPEM } = await deviceKeyAndCSR()
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
  return { keyPEM, certPEM: grant.certificatePEM, deviceId: grant.deviceId }
}

async function call(addr: { port: number; host: string }, caPEM: string, certPEM: string, keyPEM: string, request: unknown) {
  const socket: TLSSocket = connect({
    port: addr.port, host: addr.host, ca: caPEM, cert: certPEM, key: keyPEM,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  // The device declares the run-channel version on every request, exactly like
  // the desktop client and the phone do.
  const framed = request && typeof request === 'object' && !Array.isArray(request) ? { protocol: REMOTE_PROTOCOL_VERSION, ...request as Record<string, unknown> } : request
  socket.write(JSON.stringify(framed) + '\n')
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0])
}

// The loopback production stack: real TLS, real pairing, real controller.
describe('InnerMtlsHost desktop reads over production mTLS', () => {
  it('downloads exact arbitrary bytes only for a current owner and the selected workspace through production mTLS', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'scry-file-mtls-')); dirs.push(cwd)
    const bytes = Buffer.alloc(600_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    writeFileSync(join(cwd, 'arbitrary.bin'), bytes)
    const identity = await ensureHostIdentity(join(cwd, 'identity'))
    const startRun = vi.fn(async () => {})
    const binding = await createHostController({ stateDirectory: join(cwd, 'state'), hostId: identity.hostId,
      anchorSHA256: identity.anchorSHA256, verifyCSR: identity.verifyCSR, issue: identity.issue,
      authorizeWorkspace: value => { if (value !== cwd) throw new Error('workspace_not_authorized'); return cwd },
      startRun, gate: new ProviderOperationGate(), createOutputStore: directory => new RunOutputFileStore(directory) })
    cleanups.push(() => binding.close())
    const server = await identity.issueHostServer()
    const host = new InnerMtlsHost({ controller: binding.controller, serverCertPEM: server.certificatePEM,
      serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
    const addr = await host.listen(); cleanups.push(() => host.close())
    const owner = await pairDevice(identity, binding.controller)
    const other = await pairDevice(identity, binding.controller)
    const request = (query: unknown, device = owner) => call(addr, identity.caCertificatePEM, device.certPEM, device.keyPEM, { op: 'fileDownload', query })
    const first = await request({ action: 'open', cwd, target: 'arbitrary.bin' })
    expect(first.fileDownload).toMatchObject({ kind: 'page', offset: 0, hasMore: true, totalBytes: bytes.length })
    const id = first.fileDownload.id
    const next = { action: 'read', cwd, id, offset: first.fileDownload.nextOffset }
    expect(await request(next, other)).toEqual({ error: 'file_download_context_mismatch' })
    expect(await request({ ...next, cwd: '/not-authorized' })).toEqual({ error: 'workspace_not_authorized' })
    const chunks = [Buffer.from(first.fileDownload.data, 'base64')]
    let page = first.fileDownload
    while (page.hasMore) {
      page = (await request({ action: 'read', cwd, id, offset: page.nextOffset })).fileDownload
      chunks.push(Buffer.from(page.data, 'base64'))
    }
    expect(Buffer.concat(chunks)).toEqual(bytes)
    await binding.controller.authority.revoke(owner.deviceId)
    expect(await request({ action: 'open', cwd, target: 'arbitrary.bin' })).toEqual({ error: 'device_not_authorized' })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('negotiates metadata and exact selected controls with the marker consumed by Swift', async () => {
    const fixture = providerDiscoveryFixture({
      authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('workspace_not_authorized'); return cwd },
      defaultWorkspace: () => AUTHORIZED
    })
    await fixture.discovery.refreshMetadata()
    const h = await harness(async () => {}, undefined, undefined, undefined, undefined, undefined, {
      listProviders: fixture.discovery.metadata,
      listProviderControls: fixture.discovery.selected,
      listProvidersFull: fixture.discovery.legacy
    })
    const device = await pairDevice(h.identity, h.controller)
    const request = (value: unknown) => call(h.addr, h.caPEM, device.certPEM, device.keyPEM, value)
    expect(await request({ op: 'desktop', query: { kind: 'info' } })).toMatchObject({ desktop: { providerDiscovery: 2 } })
    expect(await request({ op: 'providers', detail: 'metadata' })).toMatchObject({ providerDiscovery: 2, providers: [{ id: 'pi' }, { id: 'qoder' }, { id: 'opencode' }] })
    expect(fixture.calls).toHaveLength(0)
    const selected = { op: 'providers', detail: 'selected', providerId: 'pi', agentProfileId: 'pi:fixture', cwd: AUTHORIZED }
    expect(await request(selected)).toMatchObject({ providerDiscovery: 2, providers: [{ id: 'pi', agentProfileId: 'pi:fixture', available: true }] })
    expect(fixture.calls).toEqual([{ providerId: 'pi', agentProfileId: 'pi:fixture', cwd: AUTHORIZED }])
    expect(await request({ ...selected, cwd: '/outside' })).toHaveProperty('error')
    expect(await request({ ...selected, agentProfileId: 'pi:missing' })).toHaveProperty('error')
    expect(await request({ op: 'providers', detail: 'unknown' })).toEqual({ error: 'invalid_request' })
    expect(fixture.calls).toHaveLength(1)
    expect(await request({ op: 'providers' })).toHaveProperty('providers')
    expect(fixture.calls).toHaveLength(4)
  })

  it('refreshes only the verified peer device label without changing its pairing or authority', async () => {
    const start = vi.fn(async () => {})
    const { identity, controller, caPEM, addr } = await harness(start)
    const device = await pairDevice(identity, controller)
    const other = await pairDevice(identity, controller)
    const before = controller.authority.inspectLocal().grants
    const reply = await call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'poll', cursor: 0, deviceLabel: 'iPhone 17 Pro', deviceId: other.deviceId
    })
    expect(reply.poll).toBeDefined()
    const expected = before.map((grant) => grant.deviceId === device.deviceId ? { ...grant, deviceLabel: 'iPhone 17 Pro' } : grant)
    expect(controller.authority.inspectLocal().grants).toEqual(expected)
    for (const deviceLabel of ['bad\nlabel', '\u202espoof', 'x'.repeat(81), '', null, 42]) {
      expect(await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0, deviceLabel }))
        .toEqual({ error: 'invalid_device_label' })
    }
    expect(controller.authority.inspectLocal().grants).toEqual(expected)
    await controller.authority.revoke(device.deviceId)
    expect(await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0, deviceLabel: 'spoof' }))
      .toEqual({ error: 'device_not_authorized' })
    expect(controller.authority.inspectLocal().grants[0].deviceLabel).toBe('iPhone 17 Pro')
    expect(start).not.toHaveBeenCalled()
  })

  it('serves Provider-native slash commands over the authorized channel', async () => {
    const listCommands = vi.fn(async () => ({ commands: [{ name: 'review', description: 'Review changes' }] }))
    const { identity, controller, caPEM, addr } = await harness(async () => {}, listCommands)
    const device = await pairDevice(identity, controller)

    const reply = await call(addr, caPEM, device.certPEM, device.keyPEM,
      { op: 'commands', providerId: 'codex', cwd: AUTHORIZED })
    expect(reply.commands.commands).toEqual([{ name: 'review', description: 'Review changes' }])
    expect(listCommands).toHaveBeenCalledWith({ providerId: 'codex', cwd: AUTHORIZED })
  })

  it('serves bounded previews and rejects malformed preview queries before source access', async () => {
    const readPreview = vi.fn(async () => ({ status: 'available' as const, source: 'indexed_archive' as const, partial: true as const, truncated: true, bytes: 0, turns: [{ userText: 'prompt🙂'.repeat(2_000), userTextTruncated: true, truncated: true, items: [{ kind: 'output' as const, text: 'answer🙂'.repeat(2_000), truncated: true }] }] }))
    const { identity, controller, caPEM, addr } = await harness(async () => {}, undefined, undefined, undefined, readPreview)
    const device = await pairDevice(identity, controller)
    const malformed = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'historyPreview', agentProfileId: null, providerId: 'codex', cwd: AUTHORIZED })
    expect(malformed.error).toBe('invalid_request')
    const unscoped = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'historyPreview', providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session' })
    expect(unscoped.error).toBe('history_profile_required')
    expect(readPreview).not.toHaveBeenCalled()
    const allowed = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'historyPreview', agentProfileId: null, providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session' })
    expect(allowed.historyPreview.status).toBe('available')
    expect(allowed.historyProfile).toEqual({ agentProfileId: null })
    expect(Buffer.byteLength(JSON.stringify(allowed.historyPreview), 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(readPreview).toHaveBeenCalledWith({ providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session', agentProfileId: null })
    const scoped = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'historyPreview', agentProfileId: 'profile-A', providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session' })
    expect(scoped.historyProfile).toEqual({ agentProfileId: 'profile-A' })
    expect(readPreview).toHaveBeenLastCalledWith({ providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session', agentProfileId: 'profile-A' })
  })

  it('serves snapshot-fenced history pages over the authorized channel', async () => {
    const readHistory = vi.fn(async () => [{ userText: 'hello', items: [{ kind: 'output' as const, text: 'world'.repeat(20) }] }])
    const { identity, controller, caPEM, addr } = await harness(async () => {}, undefined, readHistory)
    const device = await pairDevice(identity, controller)

    const first = await call(addr, caPEM, device.certPEM, device.keyPEM,
      { op: 'historyPage', agentProfileId: null, providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session', cursor: 0, limit: 8 })
    expect(Buffer.from(first.historyPage.dataBase64, 'base64')).toHaveLength(8)
    const second = await call(addr, caPEM, device.certPEM, device.keyPEM,
      { op: 'historyPage', agentProfileId: null, providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session', cursor: first.historyPage.cursor, limit: 8, snapshot: first.historyPage.snapshot })
    expect(second.historyPage.cursor).toBe(16)
    expect(second.historyPage.snapshot).toBe(first.historyPage.snapshot)
    expect(readHistory).toHaveBeenCalledWith({ providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session', agentProfileId: null })
  })

  it('routes paged session and directory catalogs over inner mTLS', async () => {
    const lists = {
      directories: (path?: string) => ({
        ...(path ? { current: { path, label: 'repo' } } : {}),
        directories: Array.from({ length: 3 }, (_, index) => ({ path: `/repo/d${index}`, label: `d${index}` }))
      }),
      sessions: () => Array.from({ length: 3 }, (_, index) => ({
        sessionId: `s${index}`, providerId: 'codex', cwd: AUTHORIZED, label: `session ${index}`, ts: index
      }))
    }
    const { identity, controller, caPEM, addr } = await harness(async () => {}, undefined, undefined, lists)
    const device = await pairDevice(identity, controller)

    const directories = await call(addr, caPEM, device.certPEM, device.keyPEM,
      { op: 'directoriesPage', path: '/repo', cursor: 0, limit: 2 })
    expect(directories.directoriesPage.directories).toHaveLength(2)
    expect(directories.directoriesPage.hasMore).toBe(true)
    const sessions = await call(addr, caPEM, device.certPEM, device.keyPEM,
      { op: 'sessionsPage', cursor: 0, limit: 2 })
    expect(sessions.sessionsPage.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(['s0', 's1'])
    expect(sessions.sessionsPage.hasMore).toBe(true)
  })
})
