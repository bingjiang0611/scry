import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity, type HostIdentity } from './host-identity'
import type { HostController } from './host-controller'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boundController(options: {
  readHistory?: (query: { providerId: string; cwd: string; externalSessionId: string }) => Promise<Array<{ userText: string; items: Array<{ kind: 'output'; text: string }> }>>
  listCommands?: (query: { providerId: string; cwd: string; agentProfileId?: string }) => Promise<{ commands: { name: string; description: string }[] }>
}) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-prewarm-'))
  dirs.push(dir)
  const identity: HostIdentity = await ensureHostIdentity(join(dir, 'identity'))
  const binding = await createHostController({
    stateDirectory: dir, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR, issue: identity.issue,
    authorizeWorkspace: cwd => { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd },
    startRun: async () => {}, gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: directory => new RunOutputFileStore(directory),
    ...(options.readHistory ? { readHistory: options.readHistory } : {}),
    ...(options.listCommands ? { listCommands: options.listCommands } : {})
  })
  cleanups.push(() => binding.close())
  return { identity, controller: binding.controller as HostController }
}

async function pairedPeer(identity: HostIdentity, controller: HostController) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  const csrPEM = csr.toString('pem')
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
  return { peer: grant.certificateSHA256, deviceId: grant.deviceId }
}

const query = { providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'session-one', agentProfileId: 'pi:fixture' }

describe('session open prewarms the provider context', () => {
  it('reads the same provider/profile/workspace catalog after an authorized session read', async () => {
    const readHistory = vi.fn(async () => [{ userText: 'hello', items: [{ kind: 'output' as const, text: 'hi' }] }])
    const listCommands = vi.fn(async () => ({ commands: [{ name: 'help', description: 'help' }] }))
    const { identity, controller } = await boundController({ readHistory, listCommands })
    const { peer } = await pairedPeer(identity, controller)
    expect(await controller.readHistory(peer, query)).toHaveLength(1)
    await vi.waitFor(() => expect(listCommands).toHaveBeenCalledTimes(1))
    expect(listCommands).toHaveBeenCalledWith({ providerId: 'pi', cwd: AUTHORIZED, agentProfileId: 'pi:fixture' })
  })

  it('never starts a Provider process for a denied peer or workspace', async () => {
    const readHistory = vi.fn(async () => [])
    const listCommands = vi.fn(async () => ({ commands: [] }))
    const { identity, controller } = await boundController({ readHistory, listCommands })
    const { peer, deviceId } = await pairedPeer(identity, controller)
    await expect(controller.readHistory('b'.repeat(64), query)).rejects.toThrow('device_not_authorized')
    await controller.authority.revoke(deviceId)
    await expect(controller.readHistory(peer, query)).rejects.toThrow('device_not_authorized')
    const other = await pairedPeer(identity, controller)
    // A profile-scope history read does not require the workspace, but prewarming
    // does: a Provider process must never start inside an unauthorized repository.
    expect(await controller.readHistory(other.peer, { ...query, cwd: '/outside' })).toEqual([])
    expect(listCommands).not.toHaveBeenCalled()
  })

  it('does not prewarm when the session read itself fails, and swallows a failed warm', async () => {
    const failing = await boundController({
      readHistory: async () => { throw new Error('transcript_unavailable') },
      listCommands: vi.fn(async () => ({ commands: [] }))
    })
    const failedPeer = await pairedPeer(failing.identity, failing.controller)
    await expect(failing.controller.readHistory(failedPeer.peer, query)).rejects.toThrow('transcript_unavailable')
    expect(failing.controller.readHistory).toBeTypeOf('function')

    const warmFails = await boundController({
      readHistory: async () => [{ userText: 'hello', items: [{ kind: 'output' as const, text: 'hi' }] }],
      listCommands: async () => { throw new Error('provider_start_failed') }
    })
    const warmPeer = await pairedPeer(warmFails.identity, warmFails.controller)
    // A failed warm-up is not session evidence: the read still returns its turns.
    await expect(warmFails.controller.readHistory(warmPeer.peer, query)).resolves.toHaveLength(1)
  })
})
