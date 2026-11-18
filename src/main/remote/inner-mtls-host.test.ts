import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import 'reflect-metadata'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
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
describe('InnerMtlsHost (production transport end-to-end, loopback)', () => {
  it('routes read-only workspace requests through verified TLS and canonical-project authorization', async () => {
    const start = vi.fn(async () => {})
    const { identity, controller, caPEM, addr } = await harness(start)
    const device = await pairDevice(identity, controller)
    const status = await call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'workspace', query: { action: 'status', cwd: AUTHORIZED, providerId: 'pi', externalSessionId: 's' }
    })
    expect(status.workspace).toMatchObject({ action: 'status', state: 'not_observed', observedAt: expect.any(String) })
    expect(await call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'workspace', query: { action: 'file', cwd: '/unauthorized', path: 'secret' }
    })).toEqual({ error: 'not authorized' })
    expect(await call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'workspace', query: { action: 'write', cwd: AUTHORIZED, path: 'file' }
    })).toEqual({ error: 'invalid_request' })
    expect(start).not.toHaveBeenCalled()
  })

  it('authorizes a paired device by its verified peer certificate and reflects lifecycle', async () => {
    const seen: RemoteIntentRouting[] = []
    const { identity, controller, caPEM, addr } = await harness(async ({ routing }) => { seen.push(routing) })
    const device = await pairDevice(identity, controller)

    const submit = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'submit', intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    expect(submit.status).toBe('recorded')
    await controller.idle()

    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude', prompt: 'go' }])
    const feed = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0 })
    expect(feed.poll.events.map((e: { kind: string }) => e.kind)).toEqual(['intent_recorded', 'run_dispatched', 'run_settled'])
    const state = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'runState', runId: submit.runId })
    expect(state.state).toBe('settled')
  })

  it('round-trips Provider permission and editor questions over the authorized device channel', async () => {
    let providerResponse: AgentQuestionResponse | undefined
    const { identity, controller, caPEM, addr } = await harness(async ({ runId, requestUserInput }) => {
      providerResponse = await requestUserInput({
        runId: `provider-${runId}`,
        questionId: 'permission-1',
        questionKind: 'permission',
        source: 'codex',
        questions: [{
          question: 'Allow command?', header: 'Permission', multiSelect: false,
          options: [{ label: 'Allow', description: 'Proceed' }, { label: 'Deny', description: 'Stop' }]
        }, {
          question: 'Edit note', header: 'Editor', multiSelect: false, inputMode: 'multiline', options: []
        }]
      }, new AbortController().signal)
    })
    const device = await pairDevice(identity, controller)
    const submit = await call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'submit', intentId: randomUUID(), detail: routing({ prompt: 'needs permission' })
    })
    let questions: AgentQuestionRequest[] = []
    for (let attempt = 0; attempt < 20 && questions.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      questions = (await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'questions', runId: submit.runId })).questions ?? []
    }
    expect(questions).toEqual([expect.objectContaining({ runId: submit.runId, questionId: 'permission-1' })])
    const response = {
      runId: submit.runId,
      questionId: 'permission-1',
      behavior: 'answered' as const,
      answers: { 'Allow command?': 'Allow', 'Edit note': 'line one\nline two' }
    }
    const answerId = randomUUID()
    expect(await call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'answerQuestion', runId: submit.runId, answerId, response
    })).toEqual({ answer: { status: 'answered' } })
    expect(await call(addr, caPEM, device.certPEM, device.keyPEM, {
      op: 'answerQuestion', runId: submit.runId, answerId, response
    })).toEqual({ answer: { status: 'duplicate' } })
    await controller.idle()
    expect(providerResponse).toEqual({ ...response, runId: `provider-${submit.runId}` })
  })

  it('refuses a CA-trusted but ungranted certificate (fingerprint-based, not handshake-based)', async () => {
    let ran = 0
    const { identity, controller, caPEM, addr } = await harness(async () => { ran++ })
    // A certificate the CA issued directly, bypassing pairing: it completes the
    // TLS handshake (chains to the pinned CA) but was never granted.
    const { keyPEM, csrPEM } = await deviceKeyAndCSR()
    const verified = await identity.verifyCSR(csrPEM)
    const stranger = await identity.issue({ ...verified, deviceId: randomUUID() })
    const reply = await call(addr, caPEM, stranger.certificatePEM, keyPEM, { op: 'submit', intentId: randomUUID(), detail: routing() })
    expect(reply.error).toBe('device_not_authorized')
    expect(await call(addr, caPEM, stranger.certificatePEM, keyPEM, { op: 'poll', cursor: 0, deviceLabel: 'iPhone 17 Pro' }))
      .toEqual({ error: 'device_not_authorized' })
    expect(controller.authority.inspectLocal().grants).toEqual([])
    await controller.idle()
    expect(ran).toBe(0)
  })

  it('serves inner-mTLS over a relay-delivered stream (serve(), not a TCP accept)', async () => {
    // Simulates the relay path: the host receives a raw byte stream and calls
    // serve(stream) instead of listening for TLS itself. A plain TCP pipe stands
    // in for the outer relay leg; the inner TLS 1.3 mTLS runs over it.
    const seen: RemoteIntentRouting[] = []
    const { identity, controller, caPEM, host } = await harness(async ({ routing }) => { seen.push(routing) })
    const device = await pairDevice(identity, controller)

    const bridge = createNetServer((raw: Socket) => { host.serve(raw) })
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())))
    const port = (bridge.address() as { port: number }).port

    const raw: Socket = netConnect({ port, host: '127.0.0.1' })
    await once(raw, 'connect')
    const tlsSocket: TLSSocket = connect({ socket: raw, ca: caPEM, cert: device.certPEM, key: device.keyPEM, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
    await once(tlsSocket, 'secureConnect')
    tlsSocket.write(JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, op: 'submit', intentId: randomUUID(), detail: routing() }) + '\n')
    let buffer = ''
    for await (const chunk of tlsSocket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
    tlsSocket.destroy()
    const reply = JSON.parse(buffer.split('\n')[0])
    expect(reply.status).toBe('recorded')
    await controller.idle()
    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude' }])
  })

  it('refuses the next request after the grant is revoked', async () => {
    const { identity, controller, caPEM, addr } = await harness(async () => {})
    const { keyPEM, csrPEM } = await deviceKeyAndCSR()
    const verified = await identity.verifyCSR(csrPEM)
    const pair = await controller.authority.begin()
    await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
    const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
    // Works before revocation.
    expect((await call(addr, caPEM, grant.certificatePEM, keyPEM, { op: 'poll', cursor: 0 })).poll).toBeDefined()
    await controller.authority.revoke(grant.deviceId)
    expect((await call(addr, caPEM, grant.certificatePEM, keyPEM, { op: 'poll', cursor: 0 })).error).toBe('device_not_authorized')
  })
})
