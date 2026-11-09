import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity, type HostIdentity } from './host-identity'
import type { HostController, RemoteIntentRouting } from './host-controller'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { InnerMtlsHost } from './inner-mtls-host'
import { ProviderOperationGate } from '../provider-operation-gate'

// Production InnerMtlsHost + HostController over loopback for transport-level
// tests (ping, multiplexing, pushed streams, direct route). Real identity, real
// pairing, real TLS 1.3 mTLS; only the Provider run is a test callback.

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

export const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
export const cleanups: Array<() => void | Promise<void>> = []

// Call from afterEach in every test file that uses laneHarness.
export async function cleanupLaneHarness(): Promise<void> {
  for (const c of cleanups.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export async function deviceKeyAndCSR() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return { keyPEM, csrPEM: csr.toString('pem') }
}

export async function laneHarness(runProvider: (input: {
  runId: string
  routing: RemoteIntentRouting
  output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-mtls-lanes-')); dirs.push(dir)
  const identity: HostIdentity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = await createHostController({
    stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun: runProvider, gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: (directory) => new RunOutputFileStore(directory)
  })
  cleanups.push(() => binding.close())
  const controller: HostController = binding.controller
  const server = await identity.issueHostServer()
  const host = new InnerMtlsHost({ controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
  const addr = await host.listen()
  cleanups.push(() => host.close())
  return { identity, controller, caPEM: identity.caCertificatePEM, addr, host }
}

export async function pairDevice(identity: HostIdentity, controller: HostController) {
  const { keyPEM, csrPEM } = await deviceKeyAndCSR()
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
  return { keyPEM, certPEM: grant.certificatePEM, deviceId: grant.deviceId }
}

export async function call(addr: { port: number; host: string }, caPEM: string, certPEM: string, keyPEM: string, request: unknown) {
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

export const routing = (over: Partial<RemoteIntentRouting> = {}) => JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })
