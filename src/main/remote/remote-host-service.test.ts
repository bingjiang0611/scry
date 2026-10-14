import 'reflect-metadata'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as netServer, connect as netConnect, type Socket, type Server } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { randomUUID, webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { RemoteHostService } from './remote-host-service'
import { DesktopHostListeners } from './desktop-host-listeners'
import { RunOutputFileStore } from './run-output-file'
import { ReverseTunnelTransport, type OutboundLeg } from './relay-client'
import type { PairingAuthority } from './pairing'
import { ProviderOperationGate } from '../provider-operation-gate'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const createOutputStore = (directory: string) => new RunOutputFileStore(directory)
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
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
      createOutputStore,
      createTransport: (ctx) => new ReverseTunnelTransport({ connect: () => netConnect({ port: ctx.mode === 'run' ? relay.runHostPort : relay.pairHostPort, host: '127.0.0.1' }) as unknown as OutboundLeg, poolSize: 2 }),
      relayAdvertisement: { host: 'scry-relay.example.workers.dev', port: 443, tls: 'system' }
    })
    cleanups.push(() => service.dispose())
    expect(service.relayConfigured).toBe(true)
    await service.start()

    // The scannable code decodes to exactly the fields the Swift PairingCode
    // parser expects, so device<->host is a real cross-language contract.
    const emitted = await service.beginPairing()
    expect(emitted.deviceCode).toMatch(/^scry1:/)
    const decoded = JSON.parse(Buffer.from(emitted.deviceCode!.slice('scry1:'.length), 'base64url').toString('utf8'))
    expect(decoded).toMatchObject({ relayHost: 'scry-relay.example.workers.dev', relayPort: 443, relayTLS: 'system', hostId: service.hostId, pairingId: emitted.pairingId, secret: emitted.secret })
    expect(decoded.anchorPEM).toContain('BEGIN CERTIFICATE')
    expect(decoded.anchorPEM).toBe(service.caCertificatePEM)
    await service.cancelPairing(emitted.pairingId)

    const device = await pairDevice(service)
    const devices = () => { const status = service.status(); if (!status.enabled) throw new Error('remote disabled'); return status.devices }
    expect(devices()[0].deviceLabel).toBe('iPhone')
    const refreshed = await deviceCall(relay.devicePort, service.caCertificatePEM, device.certPEM, device.keyPEM, {
      op: 'poll', cursor: 0, deviceLabel: 'iPhone 17 Pro'
    })
    expect(refreshed.poll).toBeDefined()
    expect(devices()[0].deviceLabel).toBe('iPhone 17 Pro')
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
      gate: new ProviderOperationGate(),
      createOutputStore
    })
    cleanups.push(() => service.dispose())
    expect(service.relayConfigured).toBe(false)
    await service.start()
    await service.start() // idempotent
    const pair = await service.authority.begin()
    expect(pair.pairingId).toMatch(/[0-9a-f-]{36}/)
    expect(service.anchorSHA256).toMatch(/^[0-9a-f]{64}$/)
    // Dormant: no relay dialed, so no scannable device code is emitted (honest
    // 'not reachable yet' rather than a code the phone could never use).
    const dormantCode = await service.beginPairing()
    expect(dormantCode.deviceCode).toBeNull()
  })

  it('exposes a sanitized pairing status + confirm/revoke without leaking secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const service = await RemoteHostService.create({ stateDirectory: dir, authorizeWorkspace: (c) => c, startRun: async () => {}, gate: new ProviderOperationGate(), createOutputStore })
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

  it('restores stable SSH ports and disabling desktop preserves phone grants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const init = { stateDirectory: dir, authorizeWorkspace: (c: string) => c, startRun: async () => {}, gate: new ProviderOperationGate(), createOutputStore }
    const first = await RemoteHostService.create(init)
    cleanups.push(() => first.dispose())
    await pairDevice(first)
    const code = await first.beginDesktopPairing()
    expect(code).toMatch(/^scry-desktop1:/)
    const ports = first.desktopStatus()
    expect(ports.enabled).toBe(true)
    await first.dispose()
    const second = await RemoteHostService.create(init)
    cleanups.push(() => second.dispose())
    await Promise.all([second.start(), second.start()])
    expect(second.desktopStatus()).toEqual(ports)
    await second.disableDesktop()
    expect(second.desktopStatus()).toEqual({ enabled: false })
    const status = second.status()
    if (!status.enabled) throw new Error('host not enabled')
    expect(status.devices).toHaveLength(1)
    expect(status.devices[0].revoked).toBe(false)
  })

  it('restored-port failure stays visible without disabling phone grants or leaking a partial listener', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const init = { stateDirectory: dir, authorizeWorkspace: (c: string) => c, startRun: async () => {}, gate: new ProviderOperationGate(), createOutputStore }
    const first = await RemoteHostService.create(init)
    cleanups.push(() => first.dispose())
    await first.beginDesktopPairing()
    const ports = first.desktopStatus()
    if (!ports.enabled) throw new Error('listener not enabled')
    await first.dispose()
    const occupied = netServer()
    await new Promise<void>(resolve => occupied.listen(ports.runPort, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => occupied.close(() => resolve())))
    const failed = await RemoteHostService.create(init)
    cleanups.push(() => failed.dispose())
    await failed.start()
    expect(failed.status().enabled).toBe(true)
    expect(failed.desktopStatus()).toMatchObject({ enabled: false, reason: expect.stringContaining('EADDRINUSE') })
    // The authority remains operational while only SSH restore is unavailable.
    await pairDevice(failed)
    const status = failed.status()
    if (!status.enabled) throw new Error('phone authority disabled by SSH failure')
    expect(status.devices).toHaveLength(1)
    expect(status.devices[0].revoked).toBe(false)
    await failed.dispose()
    rmSync(join(dir, 'desktop-listeners.json'))
    const pairProbe = netServer()
    await new Promise<void>((resolve, reject) => pairProbe.once('error', reject).listen(ports.pairPort, '127.0.0.1', resolve))
    await new Promise<void>(resolve => pairProbe.close(() => resolve()))
    const fresh = await RemoteHostService.create(init)
    cleanups.push(() => fresh.dispose())
    await fresh.start()
    expect(fresh.desktopStatus()).toEqual({ enabled: false })
  })

  it('dispose owns pending enable and prevents post-disposal listener publication', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const init = { stateDirectory: dir, authorizeWorkspace: (c: string) => c, startRun: async () => {}, gate: new ProviderOperationGate(), createOutputStore }
    const service = await RemoteHostService.create(init)
    cleanups.push(() => service.dispose())
    await service.start()
    let entered!: () => void
    let release!: () => void
    const starting = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const original = DesktopHostListeners.prototype.start
    vi.spyOn(DesktopHostListeners.prototype, 'start').mockImplementation(async function (this: DesktopHostListeners) {
      entered()
      await barrier
      return original.call(this)
    })
    const invitation = expect(service.beginDesktopPairing()).rejects.toThrow()
    await starting
    const closing = service.dispose()
    release()
    await Promise.all([invitation, closing])
    expect(service.desktopStatus()).toEqual({ enabled: false })
    const fresh = await RemoteHostService.create(init)
    cleanups.push(() => fresh.dispose())
    await fresh.start()
  })

  it('dispose releases the durable leases so a fresh service can be created in the same directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-svc-')); dirs.push(dir)
    const first = await RemoteHostService.create({ stateDirectory: dir, authorizeWorkspace: (c) => c, startRun: async () => {}, gate: new ProviderOperationGate(), createOutputStore })
    const hostId = first.hostId
    await first.dispose()
    await first.dispose() // idempotent
    const second = await RemoteHostService.create({ stateDirectory: dir, authorizeWorkspace: (c) => c, startRun: async () => {}, gate: new ProviderOperationGate(), createOutputStore })
    cleanups.push(() => second.dispose())
    // Same persisted identity across restarts.
    expect(second.hostId).toBe(hostId)
  })
})
