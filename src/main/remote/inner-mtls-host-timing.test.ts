import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity, type HostIdentity } from './host-identity'
import type { HostController } from './host-controller'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { InnerMtlsHost } from './inner-mtls-host'
import { ProviderOperationGate } from '../provider-operation-gate'
import { setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  setPerformanceRecordingSink(null)
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Real inner-mTLS host on loopback: the segmentation contract is about what the
// production transport records, so nothing here mocks TLS or the controller.
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-mtls-timing-'))
  dirs.push(dir)
  const identity: HostIdentity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = await createHostController({
    stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: cwd => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun: async () => {}, gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: directory => new RunOutputFileStore(directory)
  })
  cleanups.push(() => binding.close())
  const server = await identity.issueHostServer()
  const host = new InnerMtlsHost({
    controller: binding.controller, serverCertPEM: server.certificatePEM,
    serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM
  })
  const address = await host.listen()
  cleanups.push(() => host.close())
  return { identity, controller: binding.controller as HostController, caPEM: identity.caCertificatePEM, address }
}

async function pairedDevice(identity: HostIdentity, controller: HostController) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  const csrPEM = csr.toString('pem')
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
  return { keyPEM, certPEM: grant.certificatePEM }
}

describe('inner-mTLS host request segmentation', () => {
  it('separates one handshake from each request and its dispatch stages', async () => {
    const samples: PerformanceSample[] = []
    setPerformanceRecordingSink(sample => samples.push(sample))
    const { identity, controller, caPEM, address } = await harness()
    const device = await pairedDevice(identity, controller)
    const socket: TLSSocket = connect({
      port: address.port, host: address.host, ca: caPEM, cert: device.certPEM, key: device.keyPEM,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
    })
    try {
      await once(socket, 'secureConnect')
      let buffer = ''
      for (const request of [{ op: 'poll', cursor: 0 }, { op: 'providers' }]) {
        socket.write(JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...request as object, keepAlive: true }) + '\n')
        while (!buffer.includes('\n')) buffer += ((await once(socket, 'data'))[0] as Buffer).toString('utf8')
        // Clients detect a reusable lane by this exact prefix.
        expect(buffer.startsWith('{"keepAlive":true,')).toBe(true)
        buffer = ''
      }
    } finally { socket.destroy() }

    expect(samples.map(sample => sample.name)).toEqual(['remote.host.connection', 'remote.host.request', 'remote.host.request'])
    expect(samples[0].checkpoints.map(point => point.stage)).toEqual(['peer_verified'])
    const [poll, providers] = samples.slice(1)
    // Arrival, dispatch and the reply write are separate stages: a slow host
    // dispatch must not be reported as slow transport.
    for (const sample of [poll, providers]) {
      expect(sample.checkpoints.map(point => point.stage)).toEqual(['frame_received', 'dispatch_settled', 'response_written'])
      expect(sample.outcome).toBe('completed')
    }
    expect(poll.counters).toEqual({ 'op.poll': 1 })
    expect(providers.counters).toEqual({ 'op.providers': 1 })
    expect(JSON.stringify(samples)).not.toMatch(/authorized|project/)
    expect(controller.authority.inspectLocal().grants).toHaveLength(1)
  })
})
