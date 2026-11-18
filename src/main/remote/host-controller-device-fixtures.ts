import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from './host-identity'
import type { HostController } from './host-controller'
import { createHostController, type HostControllerFactoryDependencies } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

// A real controller on a temporary state directory with a real host identity, so
// tests drive the production pairing and authorization paths instead of a stub.
export const AUTHORIZED = '/authorized/project'
export const TEST_QUERY = { providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'session-one', agentProfileId: 'pi:fixture' }

export interface DeviceFixture {
  controller: HostController
  identity: Awaited<ReturnType<typeof ensureHostIdentity>>
  close(): Promise<void>
}

export async function boundController(overrides: Partial<HostControllerFactoryDependencies> = {}): Promise<DeviceFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-device-fixture-'))
  const identity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = await createHostController({
    stateDirectory: dir,
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun: async () => {},
    gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: (directory) => new RunOutputFileStore(directory),
    ...overrides
  })
  return {
    controller: binding.controller as HostController,
    identity,
    close: async () => {
      await binding.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// A paired device: its certificate fingerprint is the peer identity every host
// call authorizes against.
export async function pairedPeer(identity: { verifyCSR(csrPEM: string): Promise<{ publicKeySHA256: string }> }, controller: HostController) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const csrPEM = (await Pkcs10CertificateRequestGenerator.create({
    name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }
  })).toString('pem')
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
  return { peer: grant.certificateSHA256, deviceId: grant.deviceId }
}
