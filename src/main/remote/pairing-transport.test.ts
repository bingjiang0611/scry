import 'reflect-metadata'
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from './host-identity'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { PairingTransport } from './pairing-transport'
import { verifyCSR } from './enrollment'
import { ProviderOperationGate } from '../provider-operation-gate'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function deviceMaterials() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  const selfSigned = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=device',
    notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 3_600_000),
    keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }
  })
  return { keyPEM, csrPEM: csr.toString('pem'), certPEM: selfSigned.toString('pem') }
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-pair-tp-')); dirs.push(dir)
  const identity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = await createHostController({
    stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: (cwd) => cwd, startRun: async () => {}, gate: new ProviderOperationGate(),
    createOutputStore: (directory) => new RunOutputFileStore(directory)
  })
  cleanups.push(() => binding.close())
  const server = await identity.issueHostServer()
  const transport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
  const addr = await transport.listen()
  cleanups.push(() => transport.close())
  return { identity, controller: binding.controller, addr, caPEM: identity.caCertificatePEM }
}

async function call(addr: { port: number; host: string }, caPEM: string, certPEM: string, keyPEM: string, request: unknown) {
  const raw: Socket = netConnect({ port: addr.port, host: addr.host })
  await once(raw, 'connect')
  const socket: TLSSocket = tlsConnect({ socket: raw, ca: caPEM, cert: certPEM, key: keyPEM, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
  await once(socket, 'secureConnect')
  socket.write(JSON.stringify(request) + '\n')
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0])
}

describe('PairingTransport (device-facing pairing prove/status)', () => {
  it('proves possession with a self-signed client cert and drives to a local grant', async () => {
    const { identity, controller, addr, caPEM } = await harness()
    const device = await deviceMaterials()
    const expected = await verifyCSR(device.csrPEM)
    const pair = await controller.authority.begin()

    const rid = 'req-1'
    const proved = await call(addr, caPEM, device.certPEM, device.keyPEM, { protocolMajor: 1, requestId: rid, operation: 'pair.prove', pairingId: pair.pairingId, secret: pair.secret, csrPEM: device.csrPEM, deviceLabel: 'My iPhone' })
    expect(proved.kind).toBe('pair.pending')
    expect(proved.requestId).toBe(rid)
    // The fingerprint came from the verified TLS peer cert, matching the CSR key.
    expect(proved.publicKeySHA256).toBe(expected.publicKeySHA256)

    // Status over a fresh connection reflects the same pending state.
    const status = await call(addr, caPEM, device.certPEM, device.keyPEM, { protocolMajor: 1, requestId: 'req-2', operation: 'pair.status', pairingId: pair.pairingId, secret: pair.secret })
    expect(status.kind).toBe('pair.pending')

    // Local confirmation (Mac UI) grants the device; a re-prove then returns the
    // granted certificate over the same wire.
    const grant = await controller.authority.confirmLocal(pair.pairingId, proved.publicKeySHA256)
    expect(grant.deviceId).toMatch(/[0-9a-f-]{36}/)
    const granted = await call(addr, caPEM, device.certPEM, device.keyPEM, { protocolMajor: 1, requestId: 'req-3', operation: 'pair.prove', pairingId: pair.pairingId, secret: pair.secret, csrPEM: device.csrPEM, deviceLabel: 'My iPhone' })
    expect(granted.kind).toBe('pair.granted')
    expect(granted.deviceId).toBe(grant.deviceId)
    expect(granted.certificatePEM).toContain('BEGIN CERTIFICATE')
    void identity
  })

  it('refuses a client cert whose key does not match the CSR (no JSON-asserted key)', async () => {
    const { controller, addr, caPEM } = await harness()
    const device = await deviceMaterials()
    const other = await deviceMaterials() // different keypair -> different cert
    const pair = await controller.authority.begin()
    // Present `other`'s cert (TLS proves the OTHER key) but send `device`'s CSR.
    const reply = await call(addr, caPEM, other.certPEM, other.keyPEM, { protocolMajor: 1, requestId: 'req-1', operation: 'pair.prove', pairingId: pair.pairingId, secret: pair.secret, csrPEM: device.csrPEM, deviceLabel: 'x' })
    expect(reply.kind).toBe('pair.denied')
    expect(typeof reply.code).toBe('string')
  })

  it('refuses a wrong pairing secret with a truthful error, not a receipt', async () => {
    const { controller, addr, caPEM } = await harness()
    const device = await deviceMaterials()
    const pair = await controller.authority.begin()
    void pair
    const reply = await call(addr, caPEM, device.certPEM, device.keyPEM, { protocolMajor: 1, requestId: 'req-1', operation: 'pair.prove', pairingId: pair.pairingId, secret: 'A'.repeat(43), csrPEM: device.csrPEM, deviceLabel: 'x' })
    expect(reply.kind).toBe('pair.denied')
    expect(typeof reply.code).toBe('string')
  })
})
