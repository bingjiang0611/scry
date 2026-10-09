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
  readHistoryPreview?: (query: { providerId: string; cwd: string; externalSessionId: string }) => Promise<RemoteHistoryPreview>
) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-mtls-')); dirs.push(dir)
  const identity: HostIdentity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = await createHostController({
    stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun: runProvider, gate: new ProviderOperationGate(),
    createOutputStore: (directory) => new RunOutputFileStore(directory),
    ...(listCommands ? { listCommands } : {}),
    ...(readHistory ? { readHistory } : {}),
    ...(readHistoryPreview ? { readHistoryPreview } : {}),
    ...(lists ? { listDirectories: lists.directories, listSessions: lists.sessions } : {})
  })
  cleanups.push(() => binding.close())
  const controller: HostController = binding.controller
  const server = await identity.issueHostServer()
  const host = new InnerMtlsHost({ controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
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
  socket.write(JSON.stringify(request) + '\n')
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0])
}

const routing = (over: Partial<RemoteIntentRouting> = {}) => JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })

describe('InnerMtlsHost (production transport end-to-end, loopback)', () => {
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
    tlsSocket.write(JSON.stringify({ op: 'submit', intentId: randomUUID(), detail: routing() }) + '\n')
    let buffer = ''
    for await (const chunk of tlsSocket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
    tlsSocket.destroy()
    const reply = JSON.parse(buffer.split('\n')[0])
    expect(reply.status).toBe('recorded')
    await controller.idle()
    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude' }])
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
    const malformed = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'historyPreview', providerId: 'codex', cwd: AUTHORIZED })
    expect(malformed.error).toBe('invalid_request')
    expect(readPreview).not.toHaveBeenCalled()
    const allowed = await call(addr, caPEM, device.certPEM, device.keyPEM, { op: 'historyPreview', providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session' })
    expect(allowed.historyPreview.status).toBe('available')
    expect(Buffer.byteLength(JSON.stringify(allowed.historyPreview), 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(readPreview).toHaveBeenCalledWith({ providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session' })
  })

  it('reuses one fresh readonly TLS session, rechecks revocation and forbids writes', async () => {
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
        resolve(JSON.parse(bytes) as Record<string, unknown>)
      }
      socket.on('data', data); socket.once('error', error); socket.once('close', closed)
      socket.write(JSON.stringify({ ...request as object, keepAlive: true }) + '\n')
    })
    try {
      expect((await exchange({ op: 'historyPreview', providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'reuse' })).historyPreview).toMatchObject({ status: 'unavailable' })
      let cursor = 0
      let snapshot: string | undefined
      const parts: Buffer[] = []
      while (true) {
        const reply = await exchange({ op: 'historyPage', providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'reuse', cursor, limit: 256 * 1024, snapshot })
        const page = reply.historyPage as { cursor: number; snapshot: string; dataBase64: string; hasMore: boolean }
        snapshot ??= page.snapshot
        expect(page.snapshot).toBe(snapshot)
        parts.push(Buffer.from(page.dataBase64, 'base64'))
        cursor = page.cursor
        if (!page.hasMore) break
      }
      expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual(turns)
      expect(read).toHaveBeenCalledTimes(1)
      expect(handshakes).toBe(1)
      await controller.authority.revoke(device.deviceId)
      expect((await exchange({ op: 'historyPage', providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'reuse', snapshot, cursor: 0 })).error).toBe('device_not_authorized')
      expect((await exchange({ op: 'submit', intentId: randomUUID(), detail: routing() })).error).toBe('history_connection_read_only')
      expect(start).not.toHaveBeenCalled()
      expect(read).toHaveBeenCalledTimes(1)
    } finally { socket.destroy() }
  })

  it('serves snapshot-fenced history pages over the authorized channel', async () => {
    const readHistory = vi.fn(async () => [{ userText: 'hello', items: [{ kind: 'output' as const, text: 'world'.repeat(20) }] }])
    const { identity, controller, caPEM, addr } = await harness(async () => {}, undefined, readHistory)
    const device = await pairDevice(identity, controller)

    const first = await call(addr, caPEM, device.certPEM, device.keyPEM,
      { op: 'historyPage', providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session', cursor: 0, limit: 8 })
    expect(Buffer.from(first.historyPage.dataBase64, 'base64')).toHaveLength(8)
    const second = await call(addr, caPEM, device.certPEM, device.keyPEM,
      { op: 'historyPage', providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session', cursor: first.historyPage.cursor, limit: 8, snapshot: first.historyPage.snapshot })
    expect(second.historyPage.cursor).toBe(16)
    expect(second.historyPage.snapshot).toBe(first.historyPage.snapshot)
    expect(readHistory).toHaveBeenCalledWith({ providerId: 'codex', cwd: AUTHORIZED, externalSessionId: 'session' })
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
