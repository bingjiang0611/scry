import 'reflect-metadata'
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as netServer, connect as netConnect, type Socket, type Server } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { randomUUID, webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity, type HostIdentity } from './host-identity'
import { HostController, type RemoteIntentRouting } from './host-controller'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { InnerMtlsHost } from './inner-mtls-host'
import { RelayClient, ReverseTunnelTransport, type OutboundLeg } from './relay-client'
import { ProviderOperationGate } from '../provider-operation-gate'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  // LIFO teardown: close the client (destroys the warm-pool legs) before the
  // relay, so the relay's server.close() is not left waiting on open sockets.
  for (const c of cleanups.splice(0).reverse()) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// A minimal loopback stand-in for the public relay: it accepts outbound host
// legs on one port and device connections on another, and cross-pipes the first
// waiting device to the first ready host leg (raw byte shuttling only).
function loopbackRelay(): Promise<{ hostPort: number; devicePort: number; close: () => Promise<void> }> {
  const hostLegs: Socket[] = []
  const devices: Socket[] = []
  const pair = () => {
    while (hostLegs.length && devices.length) {
      const h = hostLegs.shift()!
      const d = devices.shift()!
      h.on('error', () => {}); d.on('error', () => {})
      h.pipe(d); d.pipe(h)
    }
  }
  const hostServer: Server = netServer((s) => { s.on('error', () => {}); hostLegs.push(s); pair() })
  const deviceServer: Server = netServer((s) => { s.on('error', () => {}); devices.push(s); pair() })
  return Promise.all([
    new Promise<void>((r) => hostServer.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => deviceServer.listen(0, '127.0.0.1', r))
  ]).then(() => ({
    hostPort: (hostServer.address() as { port: number }).port,
    devicePort: (deviceServer.address() as { port: number }).port,
    close: () => Promise.all([
      new Promise<void>((r) => hostServer.close(() => r())),
      new Promise<void>((r) => deviceServer.close(() => r()))
    ]).then(() => {})
  }))
}

async function deviceKeyAndCSR() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return { keyPEM, csrPEM: csr.toString('pem') }
}

async function pairDevice(identity: HostIdentity, controller: HostController) {
  const { keyPEM, csrPEM } = await deviceKeyAndCSR()
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
  return { keyPEM, certPEM: grant.certificatePEM }
}

async function deviceCall(devicePort: number, caPEM: string, certPEM: string, keyPEM: string, request: unknown) {
  const raw: Socket = netConnect({ port: devicePort, host: '127.0.0.1' })
  await once(raw, 'connect')
  const socket: TLSSocket = tlsConnect({ socket: raw, ca: caPEM, cert: certPEM, key: keyPEM, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
  await once(socket, 'secureConnect')
  socket.write(JSON.stringify(request) + '\n')
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0])
}

describe('RelayClient (device -> relay -> host reverse tunnel, loopback)', () => {
  it('bridges relay-delivered device sessions into the inner-mTLS host end-to-end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-relay-')); dirs.push(dir)
    const identity = await ensureHostIdentity(join(dir, 'identity'))
    const seen: RemoteIntentRouting[] = []
    const binding = await createHostController({
      stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
      verifyCSR: identity.verifyCSR, issue: identity.issue,
      authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('no'); return cwd },
      startRun: async ({ routing }) => { seen.push(routing) }, gate: new ProviderOperationGate(),
      createOutputStore: (directory) => new RunOutputFileStore(directory)
    })
    cleanups.push(() => binding.close())
    const controller = binding.controller
    const server = await identity.issueHostServer()
    const host = new InnerMtlsHost({ controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })

    const relay = await loopbackRelay()
    cleanups.push(() => relay.close())
    const transport = new ReverseTunnelTransport({ connect: () => netConnect({ port: relay.hostPort, host: '127.0.0.1' }) as unknown as OutboundLeg, poolSize: 3 })
    const client = new RelayClient({ host, transport })
    await client.start()
    cleanups.push(() => client.close())

    const device = await pairDevice(identity, controller)
    const caPEM = identity.caCertificatePEM

    // First device session through the relay reverse tunnel.
    const submit = await deviceCall(relay.devicePort, caPEM, device.certPEM, device.keyPEM, { op: 'submit', intentId: randomUUID(), detail: JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', prompt: 'go' }) })
    expect(submit.status).toBe('recorded')
    await controller.idle()
    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude', prompt: 'go' }])

    // A second session must reuse the warm pool (proves the tunnel replenishes).
    const feed = await deviceCall(relay.devicePort, caPEM, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0 })
    expect(feed.poll.events.map((e: { kind: string }) => e.kind)).toEqual(['intent_recorded', 'run_dispatched', 'run_settled'])
  })

  it('refuses a CA-trusted but ungranted device through the relay without running the executor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-relay-')); dirs.push(dir)
    const identity = await ensureHostIdentity(join(dir, 'identity'))
    let ran = 0
    const binding = await createHostController({
      stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
      verifyCSR: identity.verifyCSR, issue: identity.issue,
      authorizeWorkspace: (cwd) => cwd, startRun: async () => { ran++ }, gate: new ProviderOperationGate(),
      createOutputStore: (directory) => new RunOutputFileStore(directory)
    })
    cleanups.push(() => binding.close())
    const controller = binding.controller
    const server = await identity.issueHostServer()
    const host = new InnerMtlsHost({ controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
    const relay = await loopbackRelay()
    cleanups.push(() => relay.close())
    const client = new RelayClient({ host, transport: new ReverseTunnelTransport({ connect: () => netConnect({ port: relay.hostPort, host: '127.0.0.1' }) as unknown as OutboundLeg, poolSize: 2 }) })
    await client.start()
    cleanups.push(() => client.close())

    // CA-signed but never granted: completes the inner handshake, refused by fingerprint.
    const { keyPEM, csrPEM } = await deviceKeyAndCSR()
    const verified = await identity.verifyCSR(csrPEM)
    const stranger = await identity.issue({ ...verified, deviceId: randomUUID() })
    const reply = await deviceCall(relay.devicePort, identity.caCertificatePEM, stranger.certificatePEM, keyPEM, { op: 'submit', intentId: randomUUID(), detail: JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude' }) })
    expect(reply.error).toBe('device_not_authorized')
    await controller.idle()
    expect(ran).toBe(0)
  })
})
