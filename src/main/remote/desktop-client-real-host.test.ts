import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { ensureHostIdentity } from './host-identity'
import { desktopTlsRequest, type DesktopSshTunnel } from './desktop-transport'
import { DesktopRemoteClient } from './desktop-client'
import { createHostController } from './host-controller-factory'
import { InnerMtlsHost } from './inner-mtls-host'
import type { MacRunView } from './host-controller'
import { PairingTransport } from './pairing-transport'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'
import { listDesktopDirectories, selectDesktopDirectory } from './desktop-directory-picker'
import { createDesktopHostReader } from './desktop-host-reader'
import type { ActiveRun } from '../../shared/trace'
import { prepareRunAttachments, storeAttachmentReference } from '../attachment-store'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import { decrypt, encrypt, ssh } from './desktop-client-fixtures'

describe('DesktopRemoteClient over real host TLS', () => {
  it.each([false, true])('completes production wire lifecycle independently of output capture failure (%s)', async (captureFailure) => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-real-'))
    const identity = await ensureHostIdentity(join(directory, 'identity'))
    const rememberDirectory = vi.fn()
    const imageBytes = Buffer.alloc(600 * 1024)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(imageBytes)
    let receivedImage: string | undefined
    let liveRun: ActiveRun | null = null
    let hostUiRuns: MacRunView[] = []
    let outputReads: MockInstance | undefined
    let providerStarts = 0
    const binding = await createHostController({
      stateDirectory: directory,
      attachmentDirectory: join(directory, 'upload-staging'),
      hostId: identity.hostId,
      anchorSHA256: identity.anchorSHA256,
      verifyCSR: identity.verifyCSR,
      issue: identity.issue,
      authorizeWorkspace: (cwd) => cwd,
      startRun: async ({ progress, runId, output, routing }) => {
        providerStarts += 1
        receivedImage = routing.attachments?.[0]?.dataBase64
        const attachments = prepareRunAttachments(directory, 'run-real-1', [{ kind: 'image', name: 'screenshot.png', mimeType: 'image/png', dataBase64: receivedImage! }])
        liveRun = { runId: 'run-real-1', providerId: 'claude', cwd: '/workspace', externalSessionId: 'session-real', userText: '', attachments, items: [], done: true }
        expect(upsertTraceArchiveTurn({ userDataDir: directory, cwd: '/workspace', providerId: 'claude', sessionId: 'session-real',
          turn: { runId: 'run-real-1', providerTurnId: 'native-real-1', agentProfileId: null, userText: '', attachments: attachments.map(image => storeAttachmentReference(directory, 'run-real-1', image)), items: [], done: true } })).toBe(true)
        progress(JSON.stringify({ event: 'bound', ledgerRunId: runId, scryRunId: 'run-real-1', providerId: 'claude', cwd: '/workspace' }))
        progress(JSON.stringify({ event: 'session', externalSessionId: 'session-real' }))
        if (captureFailure) {
          output({ kind: 'tool_result', text: 'x'.repeat(512 * 1024 + 1) })
          throw new Error('403 model access restricted')
        }
      },
      gate: new ProviderOperationGate(),
      createOutputStore: (path) => {
        const store = new RunOutputFileStore(path)
        outputReads = vi.spyOn(store, 'since')
        if (captureFailure) outputReads.mockImplementation(() => { throw new Error('output_store_unavailable') })
        return store
      },
      listProjects: () => [{ path: '/workspace', label: 'workspace' }],
      desktopDirectories: { list: listDesktopDirectories, select: path => selectDesktopDirectory(path, rememberDirectory) },
      listProviders: () => [{ id: 'claude', label: 'Claude', available: true }],
      listSessions: () => [{ sessionId: 'session-real', externalSessionId: 'session-real', providerId: 'claude', cwd: '/workspace', label: 'real', ts: Date.now() }],
      sessionCatalogRevision: () => 'revision-real',
      // A run typed on the host's own UI: the desktop client has no receipt for it.
      macRuns: { list: () => hostUiRuns, stop: () => false, answer: () => false },
      readDesktop: createDesktopHostReader({
        userDataDir: directory, hostId: () => identity.hostId, authorizeWorkspace: cwd => cwd,
        authorizeSession: (context) => {
          const known = context.cwd === '/workspace' && context.providerId === 'claude' && context.externalSessionId === 'session-real'
            || context.cwd === directory && context.providerId === 'pi' && context.externalSessionId === 'large-session'
          if (!known) throw new Error('history_session_not_found')
        },
        getRun: () => liveRun
      })
    })
    const server = await identity.issueHostServer()
    const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
    const innerHost = new InnerMtlsHost({ controller: binding.controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
    const pairAddress = await pairingTransport.listen()
    const runAddress = await innerHost.listen()
    const wire: unknown[] = []
    let dropSubmitResponse = true
    let dropBeforeDelivery = false
    let lateSubmit: Parameters<typeof tlsRequest>[0] | undefined
    const tlsRequest = async (options: { path: string; caPEM: string; certPEM: string; keyPEM: string; request: unknown; signal?: AbortSignal }): Promise<unknown> => {
      wire.push(options.request)
      if (dropBeforeDelivery && (options.request as { op?: string }).op === 'submit') {
        dropBeforeDelivery = false
        lateSubmit = options
        throw new Error('request_delivery_unknown')
      }
      const address = options.path === `pair:${pairAddress.port}` ? pairAddress : runAddress
      const response = await desktopTlsRequest({ ...options, path: undefined, host: address.host, port: address.port })
      if (dropSubmitResponse && (options.request as { op?: string }).op === 'submit') { dropSubmitResponse = false; throw new Error('response_lost_after_delivery') }
      return response
    }
    const openTunnel = async (): Promise<DesktopSshTunnel> => ({ pairPath: `pair:${pairAddress.port}`, runPath: `run:${runAddress.port}`, alive: true, close: async () => {} })
    let client = new DesktopRemoteClient({ directory: join(directory, 'client'), encrypt, decrypt }, { openTunnel, tlsRequest })
    try {
      const pairing = await binding.controller.authority.begin()
      const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: identity.hostId, anchorPEM: identity.caCertificatePEM, pairPort: pairAddress.port, runPort: runAddress.port, pairingId: pairing.pairingId, secret: pairing.secret, expiresAt: pairing.expiresAt })).toString('base64url')}`
      const pending = await client.pair({ label: 'real desktop', ssh, invitation })
      await binding.controller.authority.confirmLocal(pairing.pairingId, pending.publicKeySHA256)
      const paired = await client.finishPairing(pending.connection.id)
      expect(paired.state).toBe('paired')
      await client.dispose()
      client = new DesktopRemoteClient({ directory: join(directory, 'client'), encrypt, decrypt }, { openTunnel, tlsRequest })
      await client.restoreConnections()
      await expect(client.list()).resolves.toMatchObject([{ id: pending.connection.id, state: 'connected' }])
      const catalog = await client.catalog(pending.connection.id)
      expect(catalog.projects).toEqual([{ path: '/workspace', label: 'workspace' }])
      expect(catalog.sessions[0].externalSessionId).toBe('session-real')
      expect(catalog.directorySelection).toBe(true)
      const folders = await client.directories(pending.connection.id, directory)
      expect(folders.current.path).toBe(await fs.realpath(directory))
      expect(rememberDirectory).not.toHaveBeenCalled()
      const selectedDirectory = await client.selectDirectory(pending.connection.id, directory)
      expect(selectedDirectory.path).toBe(await fs.realpath(directory))
      expect(rememberDirectory).toHaveBeenCalledExactlyOnceWith(selectedDirectory.path)
      expect(wire.some(request => (request as { op?: string }).op === 'submit')).toBe(false)
      const pairingRequests = wire.filter((request) => (request as { operation?: string }).operation?.startsWith('pair.')).length
      await client.updateSsh(pending.connection.id, { ...ssh, hostname: 'changed.example' })
      await client.connect(pending.connection.id)
      await expect(client.catalog(pending.connection.id)).resolves.toMatchObject({ projects: catalog.projects })
      expect(wire.filter((request) => (request as { operation?: string }).operation?.startsWith('pair.'))).toHaveLength(pairingRequests)
      await expect(client.history(pending.connection.id, { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-real' })).resolves.toMatchObject({ turns: [] })
      const sessionContext = { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-real' }
      await expect(client.liveRun(pending.connection.id, sessionContext)).resolves.toBeNull()
      hostUiRuns = [
        { runId: 'run-other-1', providerId: 'claude', cwd: '/workspace', externalSessionId: 'session-other', prompt: 'other', questions: [], stopping: false },
        { runId: 'run-hostui-1', providerId: 'claude', cwd: '/workspace', externalSessionId: 'session-real', prompt: '继续', questions: [], stopping: false }
      ]
      await expect(client.liveRun(pending.connection.id, sessionContext)).resolves.toEqual({ runId: 'run-hostui-1', origin: 'mac', state: 'running', scryRunId: 'run-hostui-1' })
      await expect(client.liveRun(pending.connection.id, { ...sessionContext, agentProfileId: 'other-profile' })).resolves.toBeNull()
      hostUiRuns = []
      if (!captureFailure) {
        const context = { cwd: directory, providerId: 'pi' as const, externalSessionId: 'large-session' }
        const text = '中文🙂\"\n'.repeat(400_000)
        for (let i = 0; i < 3; i++) expect(upsertTraceArchiveTurn({
          cwd: directory, userDataDir: directory, sessionId: context.externalSessionId, providerId: 'pi',
          turn: { runId: `history-${i}`, agentProfileId: null, userText: `prompt ${i}`, done: true, items: [{ id: `event-${i}`, ts: '2026-10-14T00:00:00Z', runId: `history-${i}`, kind: 'model', stage: 'text', text: i === 2 ? text : `answer ${i}` }] }
        })).toBe(true)
        const history = await client.history(pending.connection.id, context)
        expect(history.turns.map(turn => turn.userText)).toEqual(['prompt 1', 'prompt 2'])
        expect(history.turns[1].items[0].text).toBe(text)
        expect(history.hasOlder).toBe(true)
        const older = await client.history(pending.connection.id, context, history.before, history.snapshot)
        expect(older.turns.map(turn => turn.userText)).toEqual(['prompt 0'])
        expect(older.hasOlder).toBe(false)
      }
      await expect(client.trace(pending.connection.id, { cwd: '/workspace', providerId: 'claude' }, 'run-real-1')).resolves.toBeNull()
      expect(wire).toContainEqual(expect.objectContaining({ op: 'desktop', query: expect.objectContaining({ kind: 'trace', runId: 'run-real-1' }) }))
      const unknownIntent = await client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: '', attachments: [
        { kind: 'image', name: 'screenshot.png', mimeType: 'image/png', size: imageBytes.length, dataBase64: imageBytes.toString('base64') }
      ] })
      expect(unknownIntent.status).toBe('unknown')
      const intent = await client.resolveIntent(pending.connection.id, unknownIntent.intentId)
      expect(intent.status).toBe('recorded')
      await binding.controller.idle()
      // Keep byte-for-byte equality without deep-walking 600 KiB in the test runner.
      expect(Buffer.from(receivedImage ?? '', 'base64').equals(imageBytes)).toBe(true)
      expect(wire.filter(request => (request as { op?: string }).op === 'attachmentChunk')).toHaveLength(3)
      const submitted = wire.find(request => (request as { op?: string }).op === 'submit') as { detail: string }
      expect(submitted.detail.length).toBeLessThan(2048)
      expect(JSON.parse(submitted.detail).attachments[0].dataBase64).toBe('')
      const imageContext = { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-real' }
      const trace = await client.trace(pending.connection.id, imageContext, 'run-real-1')
      expect(Buffer.from(trace!.attachments![0].dataBase64, 'base64').equals(imageBytes)).toBe(true)
      const imageReads = () => wire.filter(request => (request as { query?: { kind?: string } }).query?.kind === 'image').length
      const initialImageReads = imageReads()
      await client.trace(pending.connection.id, imageContext, 'run-real-1', 1)
      expect(imageReads()).toBe(initialImageReads)
      liveRun = null
      const imageHistory = await client.history(pending.connection.id, imageContext)
      expect(Buffer.from(imageHistory.turns[0].attachments![0].dataBase64, 'base64').equals(imageBytes)).toBe(true)
      const expectedState = captureFailure ? 'failed' : 'settled'
      await expect(client.runStatus(pending.connection.id, intent.runId!)).resolves.toMatchObject({ state: expectedState, scryRunId: 'run-real-1', externalSessionId: 'session-real' })
      await expect(client.runStatus(pending.connection.id, intent.runId!)).resolves.toMatchObject({ state: expectedState, scryRunId: 'run-real-1', externalSessionId: 'session-real' })
      await expect(client.intents(pending.connection.id)).resolves.toEqual([])
      expect(outputReads).not.toHaveBeenCalled()
      expect(wire.some((request) => (request as { op?: string }).op === 'watch')).toBe(false)
      const polls = wire.filter((request): request is { op: string; cursor: number } => (request as { op?: string }).op === 'poll')
      expect(polls[0]?.cursor).toBe(0)
      expect(polls[1]?.cursor).toBeGreaterThan(0)
      const grant = binding.controller.authority.inspectLocal().grants[0]
      expect(providerStarts).toBe(1)
      dropBeforeDelivery = true
      const absent = await client.submit(pending.connection.id, { context: { cwd: '/another-project', providerId: 'pi' }, prompt: 'must never execute' })
      await expect(client.intentStatus(pending.connection.id, absent.intentId)).resolves.toMatchObject({ status: 'unknown' })
      const fenced = await client.resolveIntent(pending.connection.id, absent.intentId)
      expect(fenced.status).toBe('recorded')
      expect(binding.controller.intentStatus(grant.certificateSHA256, { intentId: absent.intentId })).toEqual({ runId: fenced.runId, state: 'cancelled' })
      await expect(tlsRequest(lateSubmit!)).resolves.toEqual({ error: 'intent_payload_conflict' })
      await binding.controller.idle()
      expect(providerStarts).toBe(1)
      expect(wire.some(request => (request as { op?: string }).op === 'stop')).toBe(false)
      if (captureFailure) {
        const events = binding.controller.poll(grant.certificateSHA256, { cursor: 0 }).events
        expect(events.filter((event) => event.detail === 'output_capture_failed')).toHaveLength(1)
        expect(events.find((event) => event.kind === 'run_failed')?.detail).toBe('403 model access restricted')
      }
      expect(wire.some((request) => (request as { op?: string }).op === 'desktop')).toBe(true)
      const wrongIdentity = await ensureHostIdentity(join(directory, 'wrong-anchor'))
      const changedInvitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: identity.hostId, anchorPEM: wrongIdentity.caCertificatePEM, pairPort: pairAddress.port, runPort: runAddress.port, pairingId: randomUUID(), secret: Buffer.from('changed-secret').toString('base64url'), expiresAt: Date.now() + 60_000 })).toString('base64url')}`
      await expect(client.pair({ label: 'changed anchor', ssh, invitation: changedInvitation })).rejects.toThrow('host_anchor_changed_forget_required')
      const wrongPairing = await ensureHostIdentity(join(directory, 'wrong-ca'))
      const wrongCaInvitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: wrongPairing.hostId, anchorPEM: wrongPairing.caCertificatePEM, pairPort: pairAddress.port, runPort: runAddress.port, pairingId: randomUUID(), secret: Buffer.from('wrong-secret').toString('base64url'), expiresAt: Date.now() + 60_000 })).toString('base64url')}`
      await expect(client.pair({ label: 'wrong CA', ssh, invitation: wrongCaInvitation })).rejects.toThrow()
      await binding.controller.authority.revoke(grant.deviceId)
      await expect(client.runStatus(pending.connection.id, intent.runId!)).rejects.toThrow('desktop_remote_device_not_authorized')
      await expect(client.directories(pending.connection.id, directory)).rejects.toThrow()
      await expect(client.selectDirectory(pending.connection.id, directory)).rejects.toThrow()
      expect(rememberDirectory).toHaveBeenCalledTimes(1)
      await expect(client.catalog(pending.connection.id)).rejects.toThrow('desktop_remote_device_not_authorized')
    } finally {
      await client.dispose()
      await innerHost.close()
      await pairingTransport.close()
      await binding.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
