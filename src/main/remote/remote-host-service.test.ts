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
import { RemoteHostService } from './remote-host-service'
import { ReverseTunnelTransport, type OutboundLeg } from './relay-client'
import type { PairingAuthority } from './pairing'
import { ProviderOperationGate } from '../provider-operation-gate'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Mode-aware loopback: run legs and pair legs land in separate queues so a run
// device is never bridged to the pairing endpoint. This test exercises the run
// path; pair legs sit idle.
function loopbackRelay(): Promise<{ runHostPort: number; pairHostPort: number; devicePort: number; close: () => Promise<void> }> {
  const runLegs: Socket[] = []
  const pairLegs: Socket[] = []
  const devices: Socket[] = []
  const pair = () => {
    while (runLegs.length && devices.length) {
      const h = runLegs.shift()!; const d = devices.shift()!
      h.on('error', () => {}); d.on('error', () => {}); h.pipe(d); d.pipe(h)
    }
  }
  const runHostServer: Server = netServer((s) => { s.on('error', () => {}); runLegs.push(s); pair() })
  const pairHostServer: Server = netServer((s) => { s.on('error', () => {}); pairLegs.push(s) })
  const deviceServer: Server = netServer((s) => { s.on('error', () => {}); devices.push(s); pair() })
  return Promise.all([
    new Promise<void>((r) => runHostServer.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => pairHostServer.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => deviceServer.listen(0, '127.0.0.1', r))
  ]).then(() => ({
    runHostPort: (runHostServer.address() as { port: number }).port,
    pairHostPort: (pairHostServer.address() as { port: number }).port,
    devicePort: (deviceServer.address() as { port: number }).port,
    close: () => Promise.all([
      new Promise<void>((r) => runHostServer.close(() => r())),
      new Promise<void>((r) => pairHostServer.close(() => r())),
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

async function pairDevice(service: RemoteHostService) {
  const authority: PairingAuthority = service.authority
  const { keyPEM, csrPEM } = await deviceKeyAndCSR()
  const publicKeySHA256 = await hashPublicKey(csrPEM)
  const pair = await authority.begin()
  await authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, publicKeySHA256)
  const grant = await authority.confirmLocal(pair.pairingId, publicKeySHA256)
  return { keyPEM, certPEM: grant.certificatePEM }
}

// Derive the same publicKeySHA256 the host's verifyCSR computes (SHA-256 of the
// SubjectPublicKeyInfo DER) so the test can drive prove()/confirmLocal() locally.
async function hashPublicKey(csrPEM: string): Promise<string> {
  const { verifyCSR } = await import('./enrollment')
  return (await verifyCSR(csrPEM)).publicKeySHA256
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

describe('RemoteHostService (lifecycle facade)', () => {
  it('routes a paired device end-to-end through the configured relay transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const relay = await loopbackRelay()
    cleanups.push(() => relay.close())
    const seen: string[] = []
    const service = await RemoteHostService.create({
      stateDirectory: dir,
      authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('no'); return cwd },
      startRun: async ({ routing }) => { seen.push(routing.cwd) },
      gate: new ProviderOperationGate(),
      createTransport: (ctx) => new ReverseTunnelTransport({ connect: () => netConnect({ port: ctx.mode === 'run' ? relay.runHostPort : relay.pairHostPort, host: '127.0.0.1' }) as unknown as OutboundLeg, poolSize: 2 })
    })
    cleanups.push(() => service.dispose())
    expect(service.relayConfigured).toBe(true)
    await service.start()

    const device = await pairDevice(service)
    const submit = await deviceCall(relay.devicePort, service.caCertificatePEM, device.certPEM, device.keyPEM, { op: 'submit', intentId: randomUUID(), detail: JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude' }) })
    expect(submit.status).toBe('recorded')
    await service.controller.idle()
    expect(seen).toEqual([AUTHORIZED])
  })

  it('is dormant with no transport: start() is a no-op and no relay leg is opened, but local pairing still works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const service = await RemoteHostService.create({
      stateDirectory: dir,
      authorizeWorkspace: (cwd) => cwd,
      startRun: async () => {},
      gate: new ProviderOperationGate()
    })
    cleanups.push(() => service.dispose())
    expect(service.relayConfigured).toBe(false)
    await service.start()
    await service.start() // idempotent
    const pair = await service.authority.begin()
    expect(pair.pairingId).toMatch(/[0-9a-f-]{36}/)
    expect(service.anchorSHA256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exposes a sanitized pairing status + confirm/revoke without leaking secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const service = await RemoteHostService.create({ stateDirectory: dir, authorizeWorkspace: (c) => c, startRun: async () => {}, gate: new ProviderOperationGate() })
    cleanups.push(() => service.dispose())

    // Empty host: honest enabled state, no pending, no devices.
    let status = service.status()
    expect(status.enabled).toBe(true)
    if (!status.enabled) throw new Error('unreachable')
    expect(status.relayConfigured).toBe(false)
    expect(status.pending).toEqual([])
    expect(status.devices).toEqual([])

    // Begin a pairing; the code carries the one-time secret + anchor for the device.
    const code = await service.beginPairing()
    expect(code.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(code.anchorSHA256).toBe(status.anchorSHA256)

    // A device proves possession over the (simulated) verified transport.
    const { csrPEM } = await deviceKeyAndCSR()
    const publicKeySHA256 = await hashPublicKey(csrPEM)
    await service.authority.prove({ pairingId: code.pairingId, secret: code.secret, csrPEM, deviceLabel: 'My iPhone' }, publicKeySHA256)

    // Status now shows the pending pairing awaiting local confirmation, with the
    // key fingerprint but NO secret verifier or PEM anywhere.
    status = service.status()
    if (!status.enabled) throw new Error('unreachable')
    expect(status.pending).toHaveLength(1)
    expect(status.pending[0]).toMatchObject({ pairingId: code.pairingId, state: 'awaiting_local_confirmation', deviceLabel: 'My iPhone', publicKeySHA256 })
    expect(JSON.stringify(status)).not.toContain('BEGIN')
    expect(JSON.stringify(status)).not.toContain(code.secret)

    // Confirming with a WRONG expected fingerprint fails closed.
    await expect(service.confirmPairing(code.pairingId, 'f'.repeat(64))).rejects.toThrow()

    // Confirming with the displayed fingerprint grants the device.
    const device = await service.confirmPairing(code.pairingId, publicKeySHA256)
    expect(device.deviceLabel).toBe('My iPhone')
    expect(device.revoked).toBe(false)
    status = service.status()
    if (!status.enabled) throw new Error('unreachable')
    expect(status.pending).toEqual([])
    expect(status.devices).toHaveLength(1)
    expect(status.devices[0].deviceId).toBe(device.deviceId)

    // Revocation is durable and shown, never silently dropped.
    await service.revokeDevice(device.deviceId)
    status = service.status()
    if (!status.enabled) throw new Error('unreachable')
    expect(status.devices[0].revoked).toBe(true)
  })

  it('dispose releases the durable leases so a fresh service can be created in the same directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const first = await RemoteHostService.create({ stateDirectory: dir, authorizeWorkspace: (c) => c, startRun: async () => {}, gate: new ProviderOperationGate() })
    const hostId = first.hostId
    await first.dispose()
    await first.dispose() // idempotent
    const second = await RemoteHostService.create({ stateDirectory: dir, authorizeWorkspace: (c) => c, startRun: async () => {}, gate: new ProviderOperationGate() })
    cleanups.push(() => second.dispose())
    // Same persisted identity across restarts.
    expect(second.hostId).toBe(hostId)
  })
})
