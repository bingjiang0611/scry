import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from './host-identity'
import { createHostController } from './host-controller-factory'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'
import { sessionDeleteRequiresArchive } from '../../host-runtime/host-runtime'
import type { AgentStartRequest } from '../../shared/runtime'
import type { DeleteSessionResult } from '../../shared/provider'
import type { DesktopRemoteDeleteSessionRequest } from '../../shared/desktop-remote'

// L3: the same daemon, two grants, two sets of semantics. Every assertion here is
// about the VERIFIED grant's scope, not about which socket the frame arrived on.
type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const AUTHORIZED = '/authorized/project'
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function deviceKeyAndCSR() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=scope-policy', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return { keyPEM: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, csrPEM: csr.toString('pem') }
}

async function harness(onDispatchRefused?: (input: { detail?: string; grantScope: 'local' | 'remote'; error: unknown }) => void, onRunActivity?: (runId: string, intentSeq?: number) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'scry-scope-policy-'))
  dirs.push(directory)
  const identity = await ensureHostIdentity(join(directory, 'identity'))
  // The owner's device-only override. A local submit must keep the user's own mode.
  const startRun = vi.fn(async (_input: {
    runId: string
    routing: { permissionMode?: AgentStartRequest['permissionMode']; cwd: string; forkLastTurn?: AgentStartRequest['forkLastTurn']; conversation?: { conversationId: string; runId: string } }
    grantScope?: 'local' | 'remote'
  }) => {})
  const sessionDelete = vi.fn(async (_request: DesktopRemoteDeleteSessionRequest, _authorize: () => void, _grantScope?: 'local' | 'remote'): Promise<DeleteSessionResult> => ({ ok: true, deleted: [], retained: [], failed: [] }))
  const binding = await createHostController({
    stateDirectory: directory,
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    authorizeWorkspace: (cwd) => { if (cwd !== AUTHORIZED) throw new Error('not_authorized'); return cwd },
    startRun,
    gate: new ProviderOperationGate(),
    readSessionStatus: () => 'not_observed',
    createOutputStore: (dir) => new RunOutputFileStore(dir),
    sessionDelete,
    ...(onDispatchRefused ? { onDispatchRefused } : {}),
    ...(onRunActivity ? { onRunActivity } : {})
  })
  cleanups.push(() => binding.close())
  return { identity, controller: binding.controller, startRun, sessionDelete }
}

async function enrollLocal(identity: Awaited<ReturnType<typeof harness>>['identity'], controller: Awaited<ReturnType<typeof harness>>['controller']) {
  const { csrPEM } = await deviceKeyAndCSR()
  const grant = await controller.authority.enrollLocal({ csrPEM, deviceLabel: 'Scry App' }, () => true)
  void identity
  return grant.certificateSHA256
}

async function pairDevice(identity: Awaited<ReturnType<typeof harness>>['identity'], controller: Awaited<ReturnType<typeof harness>>['controller']) {
  const { csrPEM } = await deviceKeyAndCSR()
  const verified = await identity.verifyCSR(csrPEM)
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'iPhone' }, verified.publicKeySHA256)
  const grant = await controller.authority.confirmLocal(pair.pairingId, verified.publicKeySHA256)
  return grant.certificateSHA256
}

const detail = JSON.stringify({ providerId: 'claude', cwd: AUTHORIZED, prompt: 'hello', permissionMode: 'full_access' })

describe('scope policy (L3: submit and sessionDelete read the verified grant)', () => {
  it('records the submitting grant scope for the run and passes it to the run start', async () => {
    const { identity, controller, startRun } = await harness()
    const local = await enrollLocal(identity, controller)
    const phone = await pairDevice(identity, controller)

    controller.submitIntent(local, { intentId: 'local-1', detail })
    controller.submitIntent(phone, { intentId: 'phone-1', detail })
    // The dispatcher runs whatever is recorded; the scope it reports back is the
    // submitter's, so the binding can pick semantics per run.
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))
    expect(startRun.mock.calls.map((call) => call[0].grantScope)).toEqual(['local', 'remote'])
  })

  it('answers the verified scope from the authority, and refuses an unknown certificate', async () => {
    const { identity, controller } = await harness()
    const local = await enrollLocal(identity, controller)
    expect(controller.authority.grantScope(local)).toBe('local')
    expect(controller.authority.grantScope('e'.repeat(64))).toBeUndefined()
  })

  it('passes the verified scope to sessionDelete so the archived rule differs by grant', async () => {
    const { identity, controller, sessionDelete } = await harness()
    const local = await enrollLocal(identity, controller)
    const phone = await pairDevice(identity, controller)
    const input = { confirmed: true, providerId: 'claude', cwd: AUTHORIZED, externalSessionId: 'session-1' }

    await controller.sessionDelete(local, input)
    await controller.sessionDelete(phone, input)
    expect(sessionDelete.mock.calls.map((call) => call[2])).toEqual(['local', 'remote'])
    // The rule itself: an unarchived session is deletable only by the App's grant.
    expect(sessionDeleteRequiresArchive('local')).toBe(false)
    expect(sessionDeleteRequiresArchive('remote')).toBe(true)
    expect(sessionDeleteRequiresArchive(undefined)).toBe(true)
  })

  it('keeps the local submit request intact instead of the device projection', async () => {
    const { identity, controller, startRun } = await harness()
    const local = await enrollLocal(identity, controller)
    controller.submitIntent(local, { intentId: 'local-2', detail })
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    const routing = startRun.mock.calls[0]![0].routing
    expect(routing.permissionMode).toBe('full_access')
    expect(routing.cwd).toBe(AUTHORIZED)
  })

  it('lets the App submit without naming a directory, and refuses a device that does', async () => {
    // The App has a current workspace; a phone does not. An unnamed submit from the
    // App keeps the App's own fallback, while the same request from a device has no
    // workspace to fall back to and must be refused rather than guessed.
    const unnamed = JSON.stringify({ providerId: 'claude', prompt: 'hello' })
    const localRun = await harness()
    const local = await enrollLocal(localRun.identity, localRun.controller)
    localRun.controller.submitIntent(local, { intentId: 'local-unnamed', detail: unnamed })
    await vi.waitFor(() => expect(localRun.startRun).toHaveBeenCalledTimes(1))
    expect(localRun.startRun.mock.calls[0]![0].routing.cwd).toBe('')

    const deviceRun = await harness()
    const phone = await pairDevice(deviceRun.identity, deviceRun.controller)
    deviceRun.controller.submitIntent(phone, { intentId: 'phone-unnamed', detail: unnamed })
    // Give the dispatcher the same chance it needed for the run above.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(deviceRun.startRun).not.toHaveBeenCalled()
  })

  it('still refuses a local submit into a directory the App never authorized', async () => {
    // An unnamed submit is allowed; an unauthorized name is not. Removing the
    // directory must not remove the workspace check.
    const { identity, controller, startRun } = await harness()
    const local = await enrollLocal(identity, controller)
    controller.submitIntent(local, {
      intentId: 'local-unauthorized',
      detail: JSON.stringify({ providerId: 'claude', cwd: '/not-authorized', prompt: 'hello' })
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(startRun).not.toHaveBeenCalled()
  })

  it('carries an App turn boundary through, and refuses a request it cannot run', async () => {
    // Editing the last message is an App flow. The boundary is forwarded through the
    // App's own normalizer, so the run that executes is the run that was asked for...
    const { identity, controller, startRun } = await harness()
    const local = await enrollLocal(identity, controller)
    controller.submitIntent(local, {
      intentId: 'local-fork',
      detail: JSON.stringify({
        providerId: 'claude', cwd: AUTHORIZED, prompt: 'hello', expectedExternalSessionId: 'session-1',
        forkLastTurn: { replaceRunId: 'run-a', replaceProviderTurnId: 'turn-a', replaceForkTurnId: 'message-a' }
      })
    })
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    expect(startRun.mock.calls[0]![0].routing.forkLastTurn).toEqual({
      replaceRunId: 'run-a', replaceProviderTurnId: 'turn-a', replaceForkTurnId: 'message-a'
    })

    // ...while a workspace PREPARATION still needs a flow this frame does not carry.
    const second = await harness()
    const secondLocal = await enrollLocal(second.identity, second.controller)
    second.controller.submitIntent(secondLocal, {
      intentId: 'local-workspace',
      detail: JSON.stringify({ providerId: 'claude', cwd: AUTHORIZED, prompt: 'hello', workspace: { kind: 'worktree' } })
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(second.startRun).not.toHaveBeenCalled()
  })

  it('carries a conversation run marker only from the App', async () => {
    // A conversation run reuses the turn's run id and the App's in-process launch;
    // a device must not be able to name either.
    const marker = { conversationId: 'conversation-1', runId: 'run-conversation-1' }
    const conversation = JSON.stringify({ providerId: 'claude', cwd: AUTHORIZED, prompt: 'hello', conversation: marker })
    const localRun = await harness()
    const local = await enrollLocal(localRun.identity, localRun.controller)
    localRun.controller.submitIntent(local, { intentId: 'local-conversation', detail: conversation })
    await vi.waitFor(() => expect(localRun.startRun).toHaveBeenCalledTimes(1))
    expect(localRun.startRun.mock.calls[0]![0].routing.conversation).toEqual(marker)

    const deviceRun = await harness()
    const phone = await pairDevice(deviceRun.identity, deviceRun.controller)
    deviceRun.controller.submitIntent(phone, { intentId: 'phone-conversation', detail: conversation })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(deviceRun.startRun).not.toHaveBeenCalled()

    const malformed = await harness()
    const app = await enrollLocal(malformed.identity, malformed.controller)
    malformed.controller.submitIntent(app, {
      intentId: 'local-malformed',
      detail: JSON.stringify({ providerId: 'claude', cwd: AUTHORIZED, prompt: 'hello', conversation: { conversationId: 'c', runId: 7 } })
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(malformed.startRun).not.toHaveBeenCalled()
  })

  it('reports a run the ledger refused before it reached the run start, and only that', async () => {
    // A daemon conversation send waits for its run to start; a policy refusal never
    // reaches the binding, so the host must say so or the send would wait forever.
    const refused = vi.fn()
    const { identity, controller, startRun } = await harness(refused)
    const local = await enrollLocal(identity, controller)
    const marker = { conversationId: 'conversation-1', runId: 'run-conversation-1' }
    controller.submitIntent(local, {
      intentId: 'local-refused',
      detail: JSON.stringify({ providerId: 'claude', cwd: '/not-authorized', prompt: 'hello', conversation: marker })
    })
    await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1))
    expect(refused.mock.calls[0]![0]).toMatchObject({ grantScope: 'local', detail: expect.stringContaining('run-conversation-1') })
    expect(startRun).not.toHaveBeenCalled()

    controller.submitIntent(local, { intentId: 'local-started', detail })
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('names the run whose ledger events or output changed, for the App event feed', async () => {
    // P3f E2: the App reads a run when the daemon says it changed. A global "something
    // changed" would make every run re-read on every chunk of every other run.
    const activity = vi.fn()
    const { identity, controller, startRun } = await harness(undefined, activity)
    startRun.mockImplementationOnce(async (input) => {
      (input as unknown as { output(chunk: { kind: 'output'; text: string }): void }).output({ kind: 'output', text: 'hello' })
    })
    const local = await enrollLocal(identity, controller)
    const { runId } = controller.submitIntent(local, { intentId: 'local-activity', detail })
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(activity.mock.calls.length).toBeGreaterThanOrEqual(3))
    // Intent, dispatch and output all name this run, and only this run.
    expect(new Set(activity.mock.calls.map(([id]) => id))).toEqual(new Set([runId]))
    // E3: every notice carries where the run's evidence starts, so a client that never
    // saw it can follow it from its intent instead of walking the ledger from 0.
    const { seq } = controller.submitIntent(local, { intentId: 'local-activity', detail })
    expect(new Set(activity.mock.calls.map(([, intentSeq]) => intentSeq))).toEqual(new Set([seq]))
  })
})
