import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { RemoteHostService } from './remote-host-service'
import { RunOutputFileStore } from './run-output-file'
import { DesktopLanes } from './desktop-lane'
import { verifyCSR } from './enrollment'
import { ProviderOperationGate } from '../provider-operation-gate'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

export interface PairedHost {
  service: RemoteHostService
  lanes: DesktopLanes
  // What a real desktop client reads from its pairing state.
  endpoint: { host: string; port: number; caPEM: string; certPEM: string; keyPEM: string }
  fingerprint: string
  deviceId: string
}

// Real host, real mTLS, real lanes: these suites claim things a mocked transport
// cannot show -- request counts, revision negotiation, revocation.
export async function withPairedHost<T>(run: (host: PairedHost) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-paired-host-'))
  const service = await RemoteHostService.create({
    stateDirectory: dir, authorizeWorkspace: (cwd: string) => cwd, startRun: async () => {},
    // The minimum desktop surface a device needs: info, projects, providers and
    // the session page. Anything else is honestly unavailable on this host.
    readDesktop: (query) => query.kind === 'info'
      ? Promise.resolve({ kind: 'info' as const, protocol: 1 as const, hostId: 'host-fixture', execution: 'canonical' as const })
      : Promise.reject(new Error('desktop_protocol_unavailable')),
    listProjects: () => [],
    listProviders: () => [],
    listSessions: () => [],
    gate: new ProviderOperationGate(), createOutputStore: (directory: string) => new RunOutputFileStore(directory)
  })
  const lanes = new DesktopLanes()
  try {
    const address = await service.host.listen()
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
    const csrPEM = (await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })).toString('pem')
    const { publicKeySHA256 } = await verifyCSR(csrPEM)
    const pair = await service.authority.begin()
    await service.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'Desktop' }, publicKeySHA256)
    const grant = await service.authority.confirmLocal(pair.pairingId, publicKeySHA256)
    return await run({
      service, lanes,
      endpoint: {
        host: address.host, port: address.port, caPEM: service.caCertificatePEM,
        certPEM: grant.certificatePEM, keyPEM: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`
      },
      fingerprint: grant.certificateSHA256, deviceId: grant.deviceId
    })
  } finally {
    lanes.closeAll()
    await service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}
