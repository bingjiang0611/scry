import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect, type Socket } from 'node:net'
import { connect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import { ensureHostIdentity } from './host-identity'
import { createHostController } from './host-controller-factory'
import { InnerMtlsHost } from './inner-mtls-host'
import { RunOutputFileStore } from './run-output-file'
import { openLocalChannel } from '../../daemon/local-channel'
import { openLocalEnrollmentStore } from '../../daemon/local-enrollment'
import { ProviderOperationGate } from '../provider-operation-gate'

// L1 acceptance at the transport boundary: a grant enrolled over the daemon's unix
// socket must be useless from anywhere else. The two endpoints below share one
// controller and one CA, exactly like the daemon, and differ only in the transport
// marker the host stamps on each frame.
type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function deviceKeyAndCSR() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=local-app', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return { keyPEM: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, csrPEM: csr.toString('pem') }
}

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'scry-local-scope-'))
  dirs.push(directory)
  const identity = await ensureHostIdentity(join(directory, 'identity'))
  const binding = await createHostController({
    stateDirectory: directory,
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun: async () => {},
    gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: (dir) => new RunOutputFileStore(dir)
  })
  cleanups.push(() => binding.close())
  const controller = binding.controller
  const server = await identity.issueHostServer()
  // Production network endpoint (TCP listener, relay or SSH tunnel).
  const network = new InnerMtlsHost({
    controller,
    serverCertPEM: server.certificatePEM,
    serverKeyPEM: server.privateKeyPEM,
    caPEM: identity.caCertificatePEM
  })
  const addr = await network.listen()
  cleanups.push(() => network.close())
  // Production local endpoint: the daemon's 0600 unix socket, marked local.
  const local = controller
    ? new InnerMtlsHost({
      controller,
      serverCertPEM: server.certificatePEM,
      serverKeyPEM: server.privateKeyPEM,
      caPEM: identity.caCertificatePEM,
      transport: 'local'
    })
    : undefined
  const channel = await openLocalChannel({ directory: join(directory, 'run'), serve: (stream) => local!.serve(stream) })
  cleanups.push(() => local!.close())
  cleanups.push(() => channel.close())
  return { identity, controller, caPEM: identity.caCertificatePEM, addr, socketPath: channel.socketPath, directory }
}

async function enrollLocal(identity: Awaited<ReturnType<typeof harness>>['identity'], controller: Awaited<ReturnType<typeof harness>>['controller'], directory: string) {
  const store = openLocalEnrollmentStore(directory)
  store.ensure(false)
  const secret = JSON.parse(readFileSync(store.secretPath, 'utf8')).secret as string
  const { keyPEM, csrPEM } = await deviceKeyAndCSR()
  await controller.authority.enrollLocal({ csrPEM, deviceLabel: 'Scry App' }, () => store.consume(secret))
  const grant = controller.authority.inspectLocal().grants.find((item) => item.scope === 'local' && item.revokedAt === null)!
  return { keyPEM, certPEM: grant.certificatePEM, deviceId: grant.deviceId, identity }
}

async function readReply(readable: AsyncIterable<Buffer>, write: (frame: string) => void, request: unknown) {
  const framed = request && typeof request === 'object' && !Array.isArray(request)
    ? { protocol: REMOTE_PROTOCOL_VERSION, ...request as Record<string, unknown> }
    : request
  write(`${JSON.stringify(framed)}\n`)
  let buffer = ''
  for await (const chunk of readable) {
    buffer += chunk.toString('utf8')
    if (buffer.includes('\n')) break
  }
  return JSON.parse(buffer.split('\n')[0])
}

async function overNetwork(addr: { port: number; host: string }, caPEM: string, cert: { certPEM: string; keyPEM: string }, request: unknown) {
  const socket: TLSSocket = connect({
    port: addr.port, host: addr.host, ca: caPEM, cert: cert.certPEM, key: cert.keyPEM,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  try { return await readReply(socket, (frame) => socket.write(frame), request) } finally { socket.destroy() }
}

async function overLocalSocket(socketPath: string, caPEM: string, cert: { certPEM: string; keyPEM: string }, request: unknown) {
  const raw: Socket = netConnect(socketPath)
  await once(raw, 'connect')
  const socket: TLSSocket = (await import('node:tls')).connect({
    socket: raw, ca: caPEM, cert: cert.certPEM, key: cert.keyPEM,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  try { return await readReply(socket, (frame) => socket.write(frame), request) } finally { socket.destroy(); raw.destroy() }
}

describe('local grant scope (L1: enrolled over unix socket, useless over the network)', () => {
  it('accepts the App grant on the local socket and refuses it on the network transport', async () => {
    const { identity, controller, caPEM, addr, socketPath, directory } = await harness()
    const app = await enrollLocal(identity, controller, directory)
    if (!caPEM) throw new Error('missing test CA')

    const local = await overLocalSocket(socketPath, caPEM, app, { op: 'providers', detail: 'metadata' })
    expect(local.error).toBeUndefined()
    expect(local.providers).toBeDefined()

    const network = await overNetwork(addr, caPEM, app, { op: 'providers', detail: 'metadata' })
    expect(network).toEqual({ error: 'device_not_authorized' })
  })

  it('still accepts a phone grant on the network transport', async () => {
    const { identity, controller, caPEM, addr } = await harness()
    const { keyPEM, csrPEM } = await deviceKeyAndCSR()
    const verified = await identity.verifyCSR(csrPEM)
    const pair = await controller.authority.begin()
    await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
    const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
    const reply = await overNetwork(addr, caPEM, { certPEM: grant.certificatePEM, keyPEM }, { op: 'providers', detail: 'metadata' })
    expect(reply.error).toBeUndefined()
    expect(reply.providers).toBeDefined()
  })

  it('stops authorizing a revoked App grant on the local socket, with no silent re-enrollment', async () => {
    const { identity, controller, caPEM, socketPath, directory } = await harness()
    const app = await enrollLocal(identity, controller, directory)
    expect((await overLocalSocket(socketPath, caPEM, app, { op: 'providers', detail: 'metadata' })).error).toBeUndefined()
    await controller.authority.revoke(app.deviceId)
    const denied = await overLocalSocket(socketPath, caPEM, app, { op: 'providers', detail: 'metadata' })
    expect(denied).toEqual({ error: 'device_not_authorized' })
    // The daemon does not mint a new secret by itself; only a restart with no valid
    // grant does, and the App must ask the user before using it.
    const store = openLocalEnrollmentStore(directory)
    expect(store.present()).toBe(false)
    expect(controller.authority.inspectLocal().grants.some((grant) => grant.scope === 'local' && grant.revokedAt === null)).toBe(false)
  })
})