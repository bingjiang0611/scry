import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import 'reflect-metadata'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { randomUUID, webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity, type HostIdentity } from './host-identity'
import { HostController, type RemoteIntentRouting, type RemoteHistoryPreview } from './host-controller'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { InnerMtlsHost } from './inner-mtls-host'
import { ExecutionTargetRouter } from './execution-targets'
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
    ...(providerDiscovery ? { ...providerDiscovery, readDesktop: async () => ({ kind: 'info' as const, protocol: 1 as const, hostId: identity.hostId, execution: 'canonical' as const }) } : {}),
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

const routing = (over: Partial<RemoteIntentRouting> = {}) => JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })

// The loopback production stack: real TLS, real pairing, real controller.
describe('InnerMtlsHost lane framing and targets', () => {
  it('serves execution target discovery and stamped mobile replies through the production mTLS wrapper', async () => {
    const target = { id: 'mac2-opaque', binding: 'b'.repeat(64) }
    const client = {
      executionTargets: vi.fn(async () => [{ ...target, hostId: 'mac2', label: 'Mac2', state: 'connected' as const }]),
      mobileRequest: vi.fn(async () => ({ projects: [] })),
      mobileSubmit: vi.fn(async () => ({ runId: 'run', status: 'recorded' })),
      mobileIntentStatus: vi.fn(async () => ({ intent: { runId: 'run', state: 'recorded' } }))
    }
    const { identity, controller, caPEM, addr } = await harness(async () => {}, undefined, undefined, undefined, undefined, client)
    const device = await pairDevice(identity, controller)
    await expect(call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'executionTargets' })).resolves.toEqual({ executionTargets: {
      version: 1, gateway: { hostId: identity.hostId, label: 'Mac1' },
      targets: [{ ...target, hostId: 'mac2', label: 'Mac2', state: 'connected' }]
    } })
    await expect(call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'executionTargets', keepAlive: true, deviceLabel: 'iPhone discovery'
    })).resolves.toEqual({ keepAlive: true, executionTargets: {
      version: 1, gateway: { hostId: identity.hostId, label: 'Mac1' },
      targets: [{ ...target, hostId: 'mac2', label: 'Mac2', state: 'connected' }]
    } })
    expect(controller.authority.inspectLocal().grants[0].deviceLabel).toBe('iPhone discovery')
    for (const invalid of [
      [{ op: 'executionTargets', arbitraryAuthority: true }, 'invalid_request'],
      [{ op: 'executionTargets', keepAlive: 'true' }, 'invalid_request'],
      [{ op: 'executionTargets', deviceLabel: 42 }, 'invalid_device_label']
    ] as const) {
      await expect(call(addr, caPEM, device.certPEM, device.keyPEM, invalid[0])).resolves.toEqual({ error: invalid[1] })
    }
    await expect(call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'target', target, request: { op: 'projects' } })).resolves.toEqual({ projects: [], executionTarget: target })
    expect(client.mobileRequest).toHaveBeenCalledWith(target, { op: 'projects' }, expect.any(Function))
    await expect(call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'target', target, request: { op: 'desktopDirectory', query: {} } })).resolves.toEqual({ error: 'invalid_target_request' })
    await controller.authority.revoke(device.deviceId)
    await expect(call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'executionTargets' })).resolves.toEqual({ error: 'device_not_authorized' })
  })

  it('accepts persistent mobile target transport metadata without forwarding it as authority', async () => {
    const target = { id: 'mac2-opaque', binding: 'b'.repeat(64) }
    const client = {
      executionTargets: vi.fn(async () => []),
      mobileRequest: vi.fn(async () => ({ projects: [] })),
      mobileSubmit: vi.fn(async () => ({ runId: 'run', status: 'recorded' })),
      mobileIntentStatus: vi.fn(async () => ({ intent: { runId: 'run', state: 'recorded' } }))
    }
    const { identity, controller, caPEM, addr } = await harness(async () => {}, undefined, undefined, undefined, undefined, client)
    const device = await pairDevice(identity, controller)
    const frame = { op: 'target', target, request: { op: 'projects' }, keepAlive: true, deviceLabel: 'iPhone 13 test' }
    await expect(call(addr, caPEM, device.certPEM, device.keyPEM, frame)).resolves.toEqual({ keepAlive: true, projects: [], executionTarget: target })
    expect(client.mobileRequest).toHaveBeenCalledExactlyOnceWith(target, { op: 'projects' }, expect.any(Function))
    expect(controller.authority.inspectLocal().grants[0].deviceLabel).toBe('iPhone 13 test')
    for (const invalid of [
      { ...frame, arbitraryAuthority: true },
      { ...frame, request: { op: 'projects', deviceLabel: 'not the desktop peer', keepAlive: true } }
    ]) {
      await expect(call(addr, caPEM, device.certPEM, device.keyPEM, invalid)).resolves.toEqual({ keepAlive: true, error: 'invalid_target_request' })
    }
    expect(client.mobileRequest).toHaveBeenCalledTimes(1)
    await controller.authority.revoke(device.deviceId)
    await expect(call(addr, caPEM, device.certPEM, device.keyPEM, frame)).resolves.toEqual({ keepAlive: true, error: 'device_not_authorized' })
    expect(client.mobileRequest).toHaveBeenCalledTimes(1)
  })

  it('reuses one TLS session for reads and writes, marks each reply and rechecks revocation', async () => {
    const start = vi.fn(async () => {})
    const turns = [{ userText: 'x'.repeat(600_000), items: [{ kind: 'output' as const, text: 'real answer' }] }]
    const read = vi.fn(async () => turns)
    const preview = vi.fn(async (): Promise<RemoteHistoryPreview> => ({ status: 'unavailable', reason: 'no_fast_evidence' }))
    const { identity, controller, caPEM, addr } = await harness(start, undefined, read, undefined, preview)
    const device = await pairDevice(identity, controller)
    const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    let handshakes = 0
    socket.on('secureConnect', () => { handshakes++ })
    await once(socket, 'secureConnect')
    const exchange = (request: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
      let bytes = ''
      const cleanup = () => { socket.off('data', data); socket.off('error', error); socket.off('close', closed) }
      const error = (cause: Error) => { cleanup(); reject(cause) }
      const closed = () => error(new Error('closed before reply'))
      const data = (chunk: Buffer) => {
        bytes += chunk.toString('utf8')
        if (!bytes.endsWith('\n')) return
        cleanup()
        // Clients detect a reusable lane by this exact prefix.
        expect(bytes.startsWith('{"keepAlive":true,')).toBe(true)
        resolve(JSON.parse(bytes) as Record<string, unknown>)
      }
      socket.on('data', data); socket.once('error', error); socket.once('close', closed)
      socket.write(JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...request as object, keepAlive: true }) + '\n')
    })
    try {
      expect((await exchange({ op: 'historyPreview', agentProfileId: null, providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'reuse' })).historyPreview).toMatchObject({ status: 'unavailable' })
      let cursor = 0
      let snapshot: string | undefined
      const parts: Buffer[] = []
      while (true) {
        const reply = await exchange({ op: 'historyPage', agentProfileId: null, providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'reuse', cursor, limit: 256 * 1024, snapshot })
        const page = reply.historyPage as { cursor: number; snapshot: string; dataBase64: string; hasMore: boolean }
        snapshot ??= page.snapshot
        expect(page.snapshot).toBe(snapshot)
        parts.push(Buffer.from(page.dataBase64, 'base64'))
        cursor = page.cursor
        if (!page.hasMore) break
      }
      expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual(turns)
      expect(read).toHaveBeenCalledTimes(1)
      const submitted = await exchange({ op: 'submit', intentId: randomUUID(), detail: routing() })
      expect(submitted.status).toBe('recorded')
      const runId = submitted.runId as string
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
      const watched = await exchange({ op: 'watch', runId, cursor: 0, outputCursor: 0, waitMs: 0 })
      expect((watched.watch as { poll: { events: unknown[] } }).poll.events.length).toBeGreaterThan(0)
      const live = await exchange({ op: 'liveRuns', waitMs: 0 })
      expect(live.liveRuns).toMatchObject({ runs: expect.any(Array), revision: expect.any(String) })
      expect((await exchange({ op: 'liveRuns', waitMs: 0, revision: 7 })).error).toBe('invalid_request')
      expect((await exchange({ op: 'liveRuns', waitMs: 0, history: { providerId: 'pi', cwd: AUTHORIZED } })).error).toBe('invalid_request')
      expect(handshakes).toBe(1)
      await controller.authority.revoke(device.deviceId)
      expect((await exchange({ op: 'liveRuns', waitMs: 0 })).error).toBe('device_not_authorized')
      expect((await exchange({ op: 'historyPage', agentProfileId: null, providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'reuse', snapshot, cursor: 0 })).error).toBe('device_not_authorized')
      expect((await exchange({ op: 'submit', intentId: randomUUID(), detail: routing() })).error).toBe('device_not_authorized')
      expect(start).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(1)
    } finally { socket.destroy() }
  })

  it('re-arms the idle timeout on a long keep-alive lane without stacking timeout listeners', async () => {
    const { identity, controller, caPEM, addr } = await harness(async () => {})
    const device = await pairDevice(identity, controller)
    const warnings: Error[] = []
    const onWarning = (warning: Error) => { warnings.push(warning) }
    process.on('warning', onWarning)
    const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    try {
      await once(socket, 'secureConnect')
      let buffer = ''
      for (let i = 0; i < 15; i++) {
        socket.write(JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, op: 'poll', cursor: 0, keepAlive: true }) + '\n')
        while (!buffer.includes('\n')) buffer += ((await once(socket, 'data'))[0] as Buffer).toString('utf8')
        expect(buffer.startsWith('{"keepAlive":true,"poll"')).toBe(true)
        buffer = ''
      }
      await new Promise((resolve) => setImmediate(resolve))
      expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toEqual([])
    } finally {
      process.off('warning', onWarning)
      socket.destroy()
    }
  })

  it('keeps one-shot replies unmarked and refuses a one-shot request on a kept lane', async () => {
    const { identity, controller, caPEM, addr } = await harness(async () => {})
    const device = await pairDevice(identity, controller)
    const raw = async (requests: unknown[]) => {
      const socket = connect({ port: addr.port, host: addr.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
      await once(socket, 'secureConnect')
      const lines: string[] = []
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          lines.push(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
          const next = requests[lines.length]
          if (next) socket.write(JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...next as object }) + '\n')
        }
      })
      socket.write(JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...requests[0] as object }) + '\n')
      await once(socket, 'close')
      return lines
    }
    const oneShot = await raw([{ op: 'poll', cursor: 0 }])
    expect(oneShot).toHaveLength(1)
    expect(oneShot[0].startsWith('{"poll"')).toBe(true)
    const mixed = await raw([{ op: 'poll', cursor: 0, keepAlive: true }, { op: 'poll', cursor: 0 }])
    expect(mixed[0].startsWith('{"keepAlive":true,"poll"')).toBe(true)
    expect(JSON.parse(mixed[1])).toEqual({ error: 'keep_alive_required' })
  })
})
