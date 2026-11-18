import 'reflect-metadata'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from './host-identity'
import { createHostController } from './host-controller-factory'
import type { HostControllerFactoryDependencies } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'
import { prepareRunFrontdoor } from '../bootstrap/run-frontdoor'
import type { AgentStartRequest } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { ProviderRegistry } from '../providers/registry'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data' } }))
vi.mock('../claude-locate', () => ({ warmShellEnv: async () => ({}) }))

// REVIEW-BATCH4-L3B C2: a named directory must not become a way around the App's
// workspace rule. The App's grant sends into the project it has open; a project
// SUBDIRECTORY is not that project, so the App rule refuses it — while the same
// directory from a device keeps the remote projection, exactly as before.
//
// This drives the real chain: submit -> routing -> RemoteRunPolicy -> frontdoor. The
// fake policy authorizer stands in for the remote workspace grant (which allows
// subdirectories), so the only thing deciding the App's case is the frontdoor rule.
type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function deviceKeyAndCSR() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  void pkcs8
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=scope-workspace', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return csr.toString('pem')
}

async function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-scope-workspace-')))
  const project = join(root, 'project')
  const subdirectory = join(project, 'packages', 'app')
  mkdirSync(subdirectory, { recursive: true })

  const stateDirectory = join(root, 'state')
  const identity = await ensureHostIdentity(stateDirectory)
  const outcomes: Array<{ grantScope?: 'local' | 'remote'; accepted: boolean; reason?: string }> = []
  type StartRunInput = Parameters<HostControllerFactoryDependencies['startRun']>[0]
  const startRun = vi.fn(async (input: StartRunInput) => {
    const request: AgentStartRequest = {
      prompt: input.routing.prompt as string,
      providerId: input.routing.providerId as AgentStartRequest['providerId'],
      cwd: input.routing.cwd
    }
    try {
      prepareRunFrontdoor(request, { origin: 'remote', ...(input.grantScope ? { grantScope: input.grantScope } : {}) }, {
        providerRegistry: {
          get: () => ({ id: 'claude', runtimeProvider: 'claude_sdk', hookTrust: { inspect: async () => null } })
        } as unknown as ProviderRegistry,
        isShuttingDown: false,
        currentCwd: project,
        appSessionStore: () => ({ isArchived: () => false }),
        resolveRemoteProjectDirectory: (cwd) => cwd,
        resolveKnownProjectDirectory: (cwd) => {
          if (cwd !== project) throw new Error('unknown_project')
          return project
        },
        providerOperationGate: new ProviderOperationGate(),
        providerContextKey: (id: ProviderId, cwd: string, profile?: string) => `${id}\0${profile ?? ''}\0${cwd}`
      })
      outcomes.push({ ...(input.grantScope ? { grantScope: input.grantScope } : {}), accepted: true })
    } catch (error) {
      outcomes.push({ ...(input.grantScope ? { grantScope: input.grantScope } : {}), accepted: false, reason: (error as Error).message })
    }
  })
  const binding = await createHostController({
    stateDirectory,
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    // The remote grant permits a subdirectory of a project; that is the existing
    // behaviour this test must not change.
    authorizeWorkspace: (cwd) => { if (!cwd.startsWith(project)) throw new Error('not_authorized'); return cwd },
    startRun,
    gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: (dir) => new RunOutputFileStore(dir),
    sessionDelete: async () => ({ ok: true, deleted: [], retained: [], failed: [] })
  })
  // The controller's lease files live under `root`: close it before removing them.
  cleanups.push(async () => { await binding.close(); rmSync(root, { recursive: true, force: true }) })
  return { identity, controller: binding.controller, startRun, outcomes, project, subdirectory }
}

describe('workspace rule through submit: a subdirectory is the App rule\'s call', () => {
  it('refuses a project subdirectory from the App grant and accepts it from a device', async () => {
    const { identity, controller, outcomes, subdirectory } = await harness()
    const local = await controller.authority.enrollLocal({ csrPEM: await deviceKeyAndCSR(), deviceLabel: 'Scry App' }, () => true)
    const phoneCSR = await deviceKeyAndCSR()
    const verified = await identity.verifyCSR(phoneCSR)
    const pair = await controller.authority.begin()
    await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: phoneCSR, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
    const phone = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
    const detail = JSON.stringify({ providerId: 'claude', cwd: subdirectory, prompt: 'hello' })

    controller.submitIntent(local.certificateSHA256, { intentId: 'local-subdir', detail })
    controller.submitIntent(phone.certificateSHA256, { intentId: 'phone-subdir', detail })
    await vi.waitFor(() => expect(outcomes).toHaveLength(2))

    const byScope = new Map(outcomes.map((outcome) => [outcome.grantScope, outcome]))
    // The App opens a project, not a directory inside it: its own rule says so.
    expect(byScope.get('local')).toMatchObject({ accepted: false })
    expect(byScope.get('local')!.reason).toContain('unknown_project')
    // The device keeps the remote projection, unchanged by this batch.
    expect(byScope.get('remote')).toMatchObject({ accepted: true })
  })
})
