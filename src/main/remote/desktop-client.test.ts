import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { ensureHostIdentity } from './host-identity'
import { generateDesktopDeviceIdentity, desktopTlsRequest, type DesktopSshTunnel } from './desktop-transport'
import { DesktopRemoteClient } from './desktop-client'
import { createHostController } from './host-controller-factory'
import { InnerMtlsHost } from './inner-mtls-host'
import type { MacRunView } from './host-controller'
import { PairingTransport } from './pairing-transport'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'
import { listDesktopDirectories, selectDesktopDirectory } from './desktop-directory-picker'
import { createDesktopHostReader, parseDesktopHostRead } from './desktop-host-reader'
import { mergeRemoteTrace } from '../../renderer/remote-trace'
import type { ActiveRun } from '../../shared/trace'
import { prepareRunAttachments, storeAttachmentReference } from '../attachment-store'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'

const ssh = { hostname: 'desktop.example', username: 'scry', port: 22 }
const encrypt = (value: string): Buffer => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
const decrypt = (value: Buffer): string => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()

async function setup(setupOptions: { submitResponse?: () => unknown; intentStatusResponse?: () => unknown; resolveIntentResponse?: () => unknown; unknownIntent?: boolean; providerDiscovery?: boolean; encrypt?: typeof encrypt } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-'))
  const identity = await generateDesktopDeviceIdentity()
  const host = await ensureHostIdentity(join(directory, 'host'))
  const pairingId = randomUUID()
  const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: host.hostId, anchorPEM: host.caCertificatePEM, pairPort: 2201, runPort: 2202, pairingId, secret: 'pairing-secret', expiresAt: Date.now() + 60_000 })).toString('base64url')}`
  let phase: 'prove' | 'status' = 'prove'
  let tunnelCount = 0
  const tunnelShutdowns: Array<() => void> = []
  const tunnel = (): DesktopSshTunnel => {
    let alive = true
    const stop = (): void => { alive = false }
    tunnelShutdowns.push(stop)
    return { pairPath: `pair-${++tunnelCount}`, runPath: `run-${tunnelCount}`, get alive() { return alive }, close: async () => { stop() } }
  }
  const tlsRequest = vi.fn(async (options: { path: string; request: unknown }): Promise<unknown> => {
    const request = options.request as { operation?: string; requestId?: string; pairingId?: string }
    if (request.operation === 'pair.prove') {
      phase = 'status'
      return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.pending', pairingId, publicKeySHA256: identity.publicKeySHA256 }
    }
    if (request.operation === 'pair.status') {
      const verified = await host.verifyCSR(identity.csrPEM)
      const grant = await host.issue({ ...verified, deviceId: randomUUID() })
      return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.granted', pairingId, deviceId: grant.deviceId, certificatePEM: grant.certificatePEM,
        certificateSHA256: grant.certificateSHA256, expiresAt: grant.expiresAt, scope: 'g0_echo_only' }
    }
    if (phase === 'status' && (request as { op?: string }).op === 'desktop') return { desktop: { kind: 'info', protocol: 1, hostId: host.hostId, execution: 'canonical', ...(setupOptions.providerDiscovery === false ? {} : { providerDiscovery: 2 }) } }
    if ((request as { op?: string }).op === 'providers') return { providers: [{ id: 'claude', label: 'Claude', available: true, permissions: [{ id: 'default', label: 'Default' }] }] }
    if ((request as { op?: string }).op === 'submit') {
      if (setupOptions.submitResponse) return setupOptions.submitResponse()
      throw new Error('network_down')
    }
    if ((request as { op?: string }).op === 'intentStatus' && setupOptions.intentStatusResponse) return setupOptions.intentStatusResponse()
    if ((request as { op?: string }).op === 'intentStatus' && setupOptions.unknownIntent) return { error: 'unknown_intent' }
    if ((request as { op?: string }).op === 'resolveIntent' && setupOptions.resolveIntentResponse) return setupOptions.resolveIntentResponse()
    if ((request as { op?: string }).op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
    return { error: 'unexpected_request' }
  })
  const openTunnel = vi.fn(async (_options: { username: string; hostname: string; port: number; pairPort: number; runPort: number }) => tunnel())
  const client = new DesktopRemoteClient({ directory, encrypt: setupOptions.encrypt ?? encrypt, decrypt }, { generateIdentity: async () => identity, openTunnel, tlsRequest })
  return { directory, host, invitation, client, openTunnel, tlsRequest, phase: () => phase, tunnelCount: () => tunnelCount, dropTunnel: () => tunnelShutdowns.at(-1)!() }
}

describe('DesktopRemoteClient', () => {
  it('explicitly reconciles a connection-wide blocker without replay and preserves the original diagnostic across restart', async () => {
    const runId = randomUUID()
    const fixture = await setup({ unknownIntent: true, resolveIntentResponse: () => ({ intent: { runId, state: 'cancelled' } }) })
    let restored: DesktopRemoteClient | undefined
    try {
      const paired = await fixture.client.pair({ label: 'remote', ssh, invitation: fixture.invitation })
      const id = paired.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const receipt = await fixture.client.submit(id, { context: { cwd: '/project-a', providerId: 'pi' }, prompt: 'original task' })
      expect(receipt).toMatchObject({ status: 'unknown', failure: 'network_down' })
      await expect(fixture.client.submit(id, { context: { cwd: '/project-b', providerId: 'claude' }, prompt: 'new task' })).rejects.toThrow('unknown_receipts_pending')
      await expect(fixture.client.intentStatus(id, receipt.intentId)).resolves.toEqual(receipt)
      const resolved = await fixture.client.resolveIntent(id, receipt.intentId)
      expect(resolved).toEqual({ ...receipt, status: 'recorded', runId })
      await expect(fixture.client.resolveIntent(id, receipt.intentId)).resolves.toEqual(resolved)
      const requests = fixture.tlsRequest.mock.calls.map(([call]) => call.request as { op?: string; intentId?: string })
      expect(requests.filter(request => request.op === 'resolveIntent')).toEqual([{ op: 'resolveIntent', intentId: receipt.intentId }])
      expect(requests.filter(request => request.op === 'submit')).toHaveLength(1)
      expect(requests.some(request => request.op === 'stop')).toBe(false)
      await fixture.client.dispose()
      restored = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt })
      await expect(restored.intents(id)).resolves.toEqual([resolved])
    } finally { await restored?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it.each([
    { response: () => ({ error: 'unknown_op' }), error: 'desktop_remote_unknown_op' },
    { response: () => { throw new Error('reply_lost') }, error: 'reply_lost' },
    { response: () => ({ intent: { runId: randomUUID(), state: 'invented' } }), error: 'invalid_intent_status_response' }
  ])('keeps the blocker if recovery fails: $error', async ({ response, error }) => {
    const fixture = await setup({ resolveIntentResponse: response })
    try {
      const paired = await fixture.client.pair({ label: 'remote', ssh, invitation: fixture.invitation })
      const id = paired.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const receipt = await fixture.client.submit(id, { context: { cwd: '/project-a', providerId: 'pi' }, prompt: 'original' })
      await expect(fixture.client.resolveIntent(id, receipt.intentId)).rejects.toThrow(error)
      await expect(fixture.client.intents(id)).resolves.toEqual([receipt])
      await expect(fixture.client.submit(id, { context: { cwd: '/project-b', providerId: 'claude' }, prompt: 'new' })).rejects.toThrow('unknown_receipts_pending')
      const persisted = JSON.parse(decrypt(await readFile(join(fixture.directory, 'desktop-client.state'))))
      expect(persisted.intents).toEqual([receipt])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('persists before concurrent duplicates can dispatch and preserves uncertainty across repeated lost replies', async () => {
    const fixture = await setup({ submitResponse: () => { throw new Error('reply_lost') }, unknownIntent: true })
    let release!: () => void
    let arrived!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const writing = new Promise<void>((resolve) => { arrived = resolve })
    let writeSpy: MockInstance | undefined
    try {
      const pending = await fixture.client.pair({ label: 'Target', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const target = (await fixture.client.executionTargets())[0]!
      const phoneIntentId = randomUUID()
      const input = { target, phonePeerFingerprint: 'a'.repeat(64), phoneIntentId, payloadHash: 'b'.repeat(64),
        request: { op: 'submit', intentId: phoneIntentId, detail: '{"cwd":"/workspace","providerId":"pi"}' } }
      const original = fs.writeFile.bind(fs)
      writeSpy = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => { arrived(); await blocked; return original(...args) })
      const first = fixture.client.mobileSubmit(input)
      await writing
      const duplicate = fixture.client.mobileSubmit(input)
      await Promise.resolve()
      expect(fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')).toHaveLength(0)
      release()
      await expect(first).resolves.toEqual({ error: 'target_delivery_unknown' })
      await expect(duplicate).resolves.toEqual({ error: 'target_delivery_unknown' })
      const calls = fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')
      expect(calls).toHaveLength(2)
      expect((calls[0][0].request as { intentId: string }).intentId).toBe((calls[1][0].request as { intentId: string }).intentId)
      expect(await fixture.client.intents(id)).toHaveLength(1)
    } finally {
      release?.(); writeSpy?.mockRestore()
      await fixture.client.dispose(); await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('keeps one downstream key for equal target retries and target intent status, rejecting payload changes', async () => {
    const runId = randomUUID()
    const fixture = await setup({
      submitResponse: () => ({ runId, status: 'recorded' }),
      intentStatusResponse: () => ({ intent: { runId, state: 'recorded' } })
    })
    let reloaded: DesktopRemoteClient | undefined
    try {
      const pending = await fixture.client.pair({ label: 'Target', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const target = (await fixture.client.executionTargets())[0]!
      const phoneIntentId = randomUUID()
      const request = { op: 'submit', intentId: phoneIntentId, detail: '{"cwd":"/workspace","providerId":"pi"}' }
      const input = { target, phonePeerFingerprint: 'a'.repeat(64), phoneIntentId, payloadHash: 'b'.repeat(64), request }
      await expect(fixture.client.mobileSubmit(input)).resolves.toEqual({ runId, status: 'recorded' })
      // Simulate a Mac1 restart after the receipt was committed. The same
      // encrypted receipt supplies the downstream key; no fresh UUID is made.
      await fixture.client.dispose()
      reloaded = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt }, { openTunnel: fixture.openTunnel, tlsRequest: fixture.tlsRequest })
      await reloaded.connect(id)
      const reloadedTarget = (await reloaded.executionTargets())[0]!
      await expect(reloaded.mobileSubmit({ ...input, target: reloadedTarget })).resolves.toEqual({ runId, status: 'duplicate' })
      await expect(reloaded.mobileIntentStatus({ target: reloadedTarget, phonePeerFingerprint: input.phonePeerFingerprint, phoneIntentId })).resolves.toEqual({ intent: { runId, state: 'recorded' } })
      const submitCalls = fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')
      // A proven receipt needs no second submit. The persisted downstream key
      // is still used for reconciliation after the Mac1 process restarts.
      expect(submitCalls).toHaveLength(1)
      const downstreamId = (submitCalls[0][0].request as { intentId: string }).intentId
      expect(downstreamId).not.toBe(phoneIntentId)
      expect((await reloaded.intents(id))[0].intentId).toBe(downstreamId)
      await expect(reloaded.mobileSubmit({ ...input, target: reloadedTarget, payloadHash: 'c'.repeat(64) })).rejects.toThrow('intent_payload_conflict')
      expect(fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')).toHaveLength(1)
    } finally { await reloaded?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it.each([false, true])('negotiates before listing providers (selected support: %s)', async (supported) => {
    const fixture = await setup({ providerDiscovery: supported })
    try {
      const pending = await fixture.client.pair({ label: 'Catalog', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      fixture.tlsRequest.mockClear()
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', ...(supported ? { providerDiscovery: 2 } : {}) } })
        .mockResolvedValueOnce({ projects: [] })
        .mockResolvedValueOnce({ providers: [{ id: 'claude', label: 'Claude', available: true }] })
        .mockResolvedValueOnce({ sessionsPage: { sessions: [], cursor: 0, total: 0, hasMore: false, snapshot: 'fixture' } })
      expect(await fixture.client.catalog(id)).toMatchObject({ providerEvidence: supported ? 'host_snapshot' : 'legacy_host' })
      expect(fixture.tlsRequest.mock.calls.map(([value]) => value.request)).toEqual([
        { op: 'desktop', query: { kind: 'info' } }, { op: 'projects' },
        { op: 'providers', ...(supported ? { detail: 'metadata' } : {}) },
        { op: 'sessionsPage', includeArchived: true, cursor: 0, limit: 100 }
      ])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
  it('rejects selected controls from a legacy host without negotiated capability', async () => {
    const fixture = await setup({ providerDiscovery: false })
    try {
      const pending = await fixture.client.pair({ label: 'Legacy controls', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      await expect(fixture.client.providerControls(id, { cwd: '/workspace', providerId: 'claude' })).rejects.toThrow('provider_controls_unavailable')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('requests selected Provider controls with the exact context', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Controls', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const context = { cwd: '/workspace', providerId: 'claude' as const }
      await expect(fixture.client.providerControls(id, context)).resolves.toMatchObject({ id: 'claude', permissions: [{ id: 'default' }] })
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: {
        op: 'providers', detail: 'selected', providerId: 'claude', cwd: '/workspace'
      } }))
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('reassembles bounded history chunks and rejects malformed or non-progressing pages', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'History', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const context = { cwd: '/workspace', providerId: 'pi', externalSessionId: 'session' }
      const history = { historyScope: 'session', turns: [{ userText: 'prompt', items: [{ id: 'event', ts: '2026-10-14', runId: 'run', kind: 'model', stage: 'text', text: 'x'.repeat(DESKTOP_HISTORY_CHUNK_BYTES) }] }], hasOlder: true, before: 5, snapshot: 'stamp', source: 'trace_archive', status: 'available' }
      const result = { kind: 'history', history }
      const bytes = Buffer.from(JSON.stringify(result))
      const first = { kind: 'history_chunk', id: randomUUID(), offset: 0, totalBytes: bytes.length, data: bytes.subarray(0, DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      const second = { ...first, offset: DESKTOP_HISTORY_CHUNK_BYTES, data: bytes.subarray(DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: second })
      const loaded = await fixture.client.history(id, context, 7, 'stamp')
      expect(loaded).toMatchObject(history)
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: { op: 'desktop', query: { kind: 'history', historyScope: 'session', context, before: 7, snapshot: 'stamp', byteChunks: true, images: true, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } } } }))
      // The scope stamp is required even when no byte chunking is needed.
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: result })
      await expect(fixture.client.history(id, context)).resolves.toMatchObject(history)
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { ...result, history: { ...history, historyScope: undefined } } })
      await expect(fixture.client.history(id, context)).rejects.toThrow('history_scope_unverified')
      for (const invalid of [
        { ...first, id: 'invalid' }, { ...first, totalBytes: DESKTOP_HISTORY_MAX_BYTES + 1 },
        { ...first, totalBytes: 0 }, { ...first, offset: 1 },
        { ...first, data: first.data.slice(1) }, { ...first, data: '!'.repeat(first.data.length) }
      ]) {
        fixture.tlsRequest.mockResolvedValueOnce({ desktop: invalid })
        await expect(fixture.client.history(id, context)).rejects.toThrow('invalid_history_response')
      }
      for (const invalid of [first, { ...second, id: randomUUID() }, { ...second, totalBytes: bytes.length + 1 }, { ...second, data: '' }, result]) {
        fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: invalid })
        await expect(fixture.client.history(id, context)).rejects.toThrow('invalid_history_response')
      }
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { ...first, totalBytes: 1, data: Buffer.from('{').toString('base64') } })
      await expect(fixture.client.history(id, context)).rejects.toThrow('invalid_history_response')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('validates bounded directory pages and forwards explicit selection without a run intent', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Directories', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const page = { current: { path: '/custom folder ', label: 'custom folder ' }, directories: [], cursor: 0, total: 0, hasMore: false, snapshot: 'a'.repeat(64) }
      fixture.tlsRequest.mockResolvedValueOnce({ directory: { action: 'list', page } })
      await expect(fixture.client.directories(id, '/custom folder ')).resolves.toEqual(page)
      for (const invalid of [null, { action: 'list', page: null }, { action: 'list', page: { ...page, cursor: 1 } }, { action: 'list', page: { ...page, hasMore: true } }, { action: 'list', page: { ...page, snapshot: 'invalid' } }]) {
        fixture.tlsRequest.mockResolvedValueOnce({ directory: invalid })
        await expect(fixture.client.directories(id)).rejects.toThrow('invalid_directory_response')
      }
      const before = fixture.tlsRequest.mock.calls.length
      await expect(fixture.client.directories(id, '/custom', 1)).rejects.toThrow('invalid_directory_request')
      await expect(fixture.client.selectDirectory(id, 'a\0b')).rejects.toThrow('invalid_directory_path')
      expect(fixture.tlsRequest.mock.calls).toHaveLength(before)
      fixture.tlsRequest.mockResolvedValueOnce({ directory: { action: 'select', project: page.current } })
      await expect(fixture.client.selectDirectory(id, page.current.path)).resolves.toEqual(page.current)
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: { op: 'desktopDirectory', query: { action: 'select', path: page.current.path } } }))
      expect(await fixture.client.intents(id)).toEqual([])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('validates command catalogs and gates session actions on the host capability', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Parity', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      fixture.tlsRequest.mockResolvedValueOnce({ commands: { commands: [{ name: 'review', description: 'Review', source: 'builtin' }] } })
      await expect(fixture.client.commands(id, { cwd: '/workspace', providerId: 'claude' })).resolves.toEqual({ commands: [{ name: 'review', description: 'Review', source: 'builtin' }] })
      fixture.tlsRequest.mockResolvedValueOnce({ commands: { commands: [{ name: 'skill:no-description', description: '' }] } })
      await expect(fixture.client.commands(id, { cwd: '/workspace', providerId: 'pi' })).resolves.toEqual({ commands: [{ name: 'skill:no-description', description: '' }] })
      fixture.tlsRequest.mockResolvedValueOnce({ commands: { commands: [{ name: 'bad', description: 'bad', source: 'invalid' }] } })
      await expect(fixture.client.commands(id, { cwd: '/workspace', providerId: 'claude' })).rejects.toThrow('invalid_catalog_response')
      const before = fixture.tlsRequest.mock.calls.length
      await expect(fixture.client.sessionAction(id, { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-1' }, { kind: 'pin', pinned: true })).rejects.toThrow('desktop_session_actions_unsupported')
      expect(fixture.tlsRequest.mock.calls.slice(before).map((call) => (call[0] as { request: { op?: string } }).request.op)).toEqual(['desktop'])
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', sessionActions: true } })
      fixture.tlsRequest.mockResolvedValueOnce({ sessionAction: 'yes' })
      await expect(fixture.client.sessionAction(id, { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-1' }, { kind: 'pin', pinned: true })).rejects.toThrow('invalid_session_action_response')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('persists the host-confirmed native session binding for first-run receipts across client restart', async () => {
    const runId = randomUUID()
    const fixture = await setup({ submitResponse: () => ({ runId, status: 'recorded' }) })
    let reloaded: DesktopRemoteClient | undefined
    try {
      const pending = await fixture.client.pair({ label: 'Adoption', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      await fixture.client.submit(id, { context: { cwd: '/workspace', providerId: 'pi' }, prompt: 'new session' })
      fixture.tlsRequest.mockResolvedValueOnce({ state: 'dispatched' })
      fixture.tlsRequest.mockResolvedValueOnce({ poll: { cursor: 1, events: [{ runId, kind: 'run_progress', detail: JSON.stringify({ event: 'session', externalSessionId: 'native-adopted' }) }] } })
      await expect(fixture.client.runStatus(id, runId)).resolves.toMatchObject({ externalSessionId: 'native-adopted' })
      reloaded = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt }, { openTunnel: fixture.openTunnel, tlsRequest: fixture.tlsRequest })
      await expect(reloaded.intents(id)).resolves.toMatchObject([{ runId, context: { cwd: '/workspace', providerId: 'pi', externalSessionId: 'native-adopted' } }])
      expect(fixture.tlsRequest.mock.calls.filter(call => (call[0].request as { op?: string }).op === 'submit')).toHaveLength(1)
    } finally { await reloaded?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('resolves a device-started live run on the opened session to its bound trace identity', async () => {
    const ledgerRunId = randomUUID()
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Live', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const scope = { cwd: '/workspace', providerId: 'pi', externalSessionId: 'session-a' }
      const live = (externalSessionId: string) => ({ origin: 'remote', runId: ledgerRunId, providerId: 'pi', cwd: '/workspace', externalSessionId, prompt: 'p', state: 'running', questions: [] })
      fixture.tlsRequest.mockResolvedValueOnce({ liveRuns: { revision: 'r1', runs: [live('session-a')] } })
      fixture.tlsRequest.mockResolvedValueOnce({ state: 'dispatched' })
      fixture.tlsRequest.mockResolvedValueOnce({ poll: { cursor: 1, events: [{ runId: ledgerRunId, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', scryRunId: 'run-phone-1' }) }] } })
      await expect(fixture.client.liveRun(id, scope)).resolves.toEqual({ runId: ledgerRunId, origin: 'remote', state: 'running', scryRunId: 'run-phone-1' })
      expect(fixture.tlsRequest.mock.calls.map(call => (call[0].request as { op?: string }).op).slice(-3)).toEqual(['liveRuns', 'runState', 'poll'])
      fixture.tlsRequest.mockResolvedValueOnce({ liveRuns: { revision: 'r2', runs: [live('session-b')] } })
      await expect(fixture.client.liveRun(id, scope)).resolves.toBeNull()
      fixture.tlsRequest.mockResolvedValueOnce({ liveRuns: { revision: 'r3', runs: [{ ...live('session-a'), state: 'done' }] } })
      await expect(fixture.client.liveRun(id, scope)).rejects.toThrow('invalid_live_runs_response')
      await expect(fixture.client.liveRun(id, { cwd: '/workspace', providerId: 'pi' })).rejects.toThrow('session_required')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('lists a fresh profile without touching secure storage, and fails pairing before networking when encryption fails', async () => {
    const unavailable = vi.fn(() => { throw new Error('secure_storage_unavailable') })
    const fixture = await setup({ encrypt: unavailable })
    try {
      await expect(fixture.client.list()).resolves.toEqual([])
      expect(unavailable).not.toHaveBeenCalled()
      await expect(access(join(fixture.directory, 'desktop-client.state'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fixture.client.pair({ label: 'Unsaved', ssh, invitation: fixture.invitation })).rejects.toThrow('secure_storage_unavailable')
      expect(unavailable).toHaveBeenCalledTimes(1)
      expect(fixture.tunnelCount()).toBe(0)
      await expect(fixture.client.list()).resolves.toEqual([])
      await expect(access(join(fixture.directory, 'desktop-client.state'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not turn an unreadable encrypted store into an empty profile', async () => {
    const fixture = await setup()
    let restored: DesktopRemoteClient | undefined
    try {
      await fixture.client.pair({ label: 'Saved', ssh, invitation: fixture.invitation })
      await fixture.client.dispose()
      restored = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt: () => { throw new Error('secure_storage_unavailable') } })
      await expect(restored.list()).rejects.toThrow('secure_storage_unavailable')
      await expect(access(join(fixture.directory, 'desktop-client.state'))).resolves.toBeUndefined()
    } finally { await restored?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('reports an exited SSH tunnel as disconnected and rejects unsent work without creating an unknown receipt', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Exited SSH', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      expect((await fixture.client.list())[0].state).toBe('connected')
      fixture.dropTunnel()
      expect((await fixture.client.list())[0].state).toBe('disconnected')
      await expect(fixture.client.submit(id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'never sent' })).rejects.toThrow('desktop_not_connected')
      await expect(fixture.client.intents(id)).resolves.toEqual([])
      await fixture.client.connect(id)
      expect((await fixture.client.list())[0].state).toBe('connected')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('updates only SSH routing, disconnects, and retains pairing and unknown receipts across restart without replay', async () => {
    const fixture = await setup({ unknownIntent: true })
    let restored: DesktopRemoteClient | undefined
    try {
      const pending = await fixture.client.pair({ label: 'Changing IP', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const receipt = await fixture.client.submit(id, { context: { cwd: '/workspace', providerId: 'claude', externalSessionId: 'native-session' }, prompt: 'sent once' })
      const statePath = join(fixture.directory, 'desktop-client.state')
      const before = JSON.parse(decrypt(await readFile(statePath)))
      const next = { hostname: '30.7.226.226', username: 'test', port: 2222 }
      const tunnelsBefore = fixture.tunnelCount()
      await fixture.client.updateSsh(id, next)
      expect((await fixture.client.list())[0]).toMatchObject({ id, ssh: next, state: 'disconnected' })
      expect(fixture.tunnelCount()).toBe(tunnelsBefore)
      const after = JSON.parse(decrypt(await readFile(statePath)))
      expect(after).toEqual({ ...before, connections: [{ ...before.connections[0], ssh: next }] })
      await expect(fixture.client.submit(id, { context: receipt.context, prompt: 'do not resend' })).rejects.toThrow('unknown_receipts_pending')
      await fixture.client.connect(id)
      expect(fixture.openTunnel).toHaveBeenLastCalledWith({ ...next, pairPort: 2201, runPort: 2202 })
      expect(fixture.tlsRequest.mock.calls.filter(([call]) => (call.request as { op?: string }).op === 'submit')).toHaveLength(1)
      expect(fixture.tlsRequest.mock.calls.filter(([call]) => (call.request as { operation?: string }).operation?.startsWith('pair.'))).toHaveLength(2)
      await expect(fixture.client.intents(id)).resolves.toEqual([receipt])
      await fixture.client.dispose()
      restored = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt })
      expect((await restored.list())[0]).toMatchObject({ id, ssh: next, state: 'disconnected' })
      await expect(restored.intents(id)).resolves.toEqual([receipt])
    } finally { await restored?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps the new address when an in-flight receipt refresh saves after the address change', async () => {
    const runId = randomUUID()
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded', runId }) })
    const statePath = join(fixture.directory, 'desktop-client.state')
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
    let saveStarted!: () => void
    const started = new Promise<void>((resolve) => { saveStarted = resolve })
    let releaseResponse!: () => void
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
    let requestStarted!: () => void
    const requested = new Promise<void>((resolve) => { requestStarted = resolve })
    const rename = fs.rename.bind(fs)
    const pending: Array<Promise<unknown>> = []
    let renameSpy: MockInstance<typeof fs.rename> | undefined
    try {
      const pairing = await fixture.client.pair({ label: 'Concurrent refresh', ssh, invitation: fixture.invitation })
      const id = pairing.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const receipt = await fixture.client.submit(id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'one run' })
      renameSpy = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
        saveStarted()
        await saveGate
        await rename(from, to)
      })
      const refreshedRunId = randomUUID()
      fixture.tlsRequest.mockImplementationOnce(async () => {
        requestStarted()
        await responseGate
        return { intent: { runId: refreshedRunId, state: 'recorded' } }
      })
      const refresh = fixture.client.intentStatus(id, receipt.intentId)
      pending.push(refresh)
      await requested
      const next = { ...ssh, hostname: 'changed.example' }
      const update = fixture.client.updateSsh(id, next)
      pending.push(update)
      await started
      releaseResponse()
      await vi.waitFor(async () => expect(await fixture.client.intents(id)).toMatchObject([{ runId: refreshedRunId }]))
      releaseSave()
      await Promise.all(pending)
      const saved = JSON.parse(decrypt(await readFile(statePath)))
      expect(saved.connections[0].ssh).toEqual(next)
      expect(saved.intents[0].runId).toBe(refreshedRunId)
    } finally {
      releaseResponse(); releaseSave()
      await Promise.allSettled(pending)
      renameSpy?.mockRestore()
      await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('preserves a pending pairing when its SSH address changes', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Pending', ssh, invitation: fixture.invitation })
      const next = { ...ssh, hostname: 'changed.example' }
      await fixture.client.updateSsh(pending.connection.id, next)
      expect((await fixture.client.list())[0]).toMatchObject({ ssh: next, state: 'pairing' })
      await expect(fixture.client.finishPairing(pending.connection.id)).resolves.toMatchObject({ state: 'paired', connection: { id: pending.connection.id } })
      expect(fixture.openTunnel).toHaveBeenLastCalledWith({ ...next, pairPort: 2201, runPort: 2202 })
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it.each([
    { ...ssh, hostname: '-oProxyCommand=evil' },
    { ...ssh, hostname: 'host\nother' },
    { ...ssh, username: '-root' },
    { ...ssh, port: 0 },
    { ...ssh, port: 65536 },
    { ...ssh, port: 22.5 }
  ])('rejects invalid SSH routing before disconnecting or persisting: %j', async (target) => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Invalid address', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const before = await readFile(join(fixture.directory, 'desktop-client.state'))
      await expect(fixture.client.updateSsh(pending.connection.id, target)).rejects.toThrow('invalid_ssh')
      expect((await fixture.client.list())[0]).toMatchObject({ ssh, state: 'connected' })
      expect(await readFile(join(fixture.directory, 'desktop-client.state'))).toEqual(before)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not publish or persist a new address when secure storage fails', async () => {
    let failSave = false
    const fixture = await setup({ encrypt: (value) => { if (failSave) throw new Error('secure_storage_unavailable'); return encrypt(value) } })
    try {
      const pending = await fixture.client.pair({ label: 'Storage failure', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const before = await readFile(join(fixture.directory, 'desktop-client.state'))
      failSave = true
      await expect(fixture.client.updateSsh(pending.connection.id, { ...ssh, hostname: 'changed.example' })).rejects.toThrow('secure_storage_unavailable')
      expect((await fixture.client.list())[0]).toMatchObject({ ssh, state: 'disconnected' })
      expect(await readFile(join(fixture.directory, 'desktop-client.state'))).toEqual(before)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects an unknown saved connection without opening a tunnel', async () => {
    const fixture = await setup()
    try {
      await expect(fixture.client.updateSsh('missing', ssh)).rejects.toThrow('unknown_connection')
      expect(fixture.tunnelCount()).toBe(0)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('persists an unknown submit receipt and never resends it after reconnect', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Test desktop', ssh, invitation: fixture.invitation })
      expect(pending.state).toBe('pending')
      const connectionId = pending.connection.id
      const paired = await fixture.client.finishPairing(connectionId)
      expect(paired.state).toBe('paired')
      await fixture.client.connect(connectionId)
      const receipt = await fixture.client.submit(connectionId, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'hello' })
      expect(receipt.status).toBe('unknown')
      await fixture.client.dispose()
      const restored = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt }, { generateIdentity: async () => await generateDesktopDeviceIdentity(), openTunnel: async () => ({ pairPath: 'unused', runPath: 'unused', alive: true, close: async () => {} }), tlsRequest: async () => { throw new Error('must_not_resend') } })
      await expect(restored.intents(connectionId)).resolves.toMatchObject([{ status: 'unknown', connectionId }])
      await expect(restored.submit(connectionId, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'again' })).rejects.toThrow('unknown_receipts_pending')
      await restored.dispose()
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps a durable unknown receipt when the submit acknowledgement is malformed', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded' }) })
    try {
      const pending = await fixture.client.pair({ label: 'Malformed ack', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'malformed' })
      expect(receipt.status).toBe('unknown')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toMatchObject([{ intentId: receipt.intentId, status: 'unknown' }])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps an absent host intent unknown instead of unlocking a resend', async () => {
    const fixture = await setup({ unknownIntent: true })
    try {
      const pending = await fixture.client.pair({ label: 'Absent intent', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'ambiguous' })
      const checked = await fixture.client.intentStatus(pending.connection.id, receipt.intentId)
      expect(checked).toMatchObject({ intentId: receipt.intentId, status: 'unknown' })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'resend' })).rejects.toThrow('unknown_receipts_pending')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not evict recorded runs merely to satisfy receipt capacity', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Capacity', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      for (let index = 0; index < 256; index++) await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: `run-${index}` })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'overflow' })).rejects.toThrow('intent_receipt_capacity_exceeded')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toHaveLength(256)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps missing lifecycle evidence unknown and rejects malformed state or event pages', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Status', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const runId = randomUUID()
      for (const response of [null, {}, { state: 'running' }]) {
        fixture.tlsRequest.mockResolvedValueOnce(response)
        await expect(fixture.client.runStatus(id, runId)).rejects.toThrow('invalid_run_status_response')
      }
      fixture.tlsRequest.mockResolvedValueOnce({ state: 'settled' }).mockResolvedValueOnce({ poll: null })
      await expect(fixture.client.runStatus(id, runId)).rejects.toThrow('invalid_run_status_response')
      fixture.tlsRequest.mockResolvedValueOnce({ state: null }).mockResolvedValueOnce({ poll: { events: [], cursor: 0 } })
      await expect(fixture.client.runStatus(id, runId)).resolves.toEqual({ state: 'unknown' })
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects invitations with a changed or malformed anchor', async () => {
    const fixture = await setup()
    try {
      const malformed = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: fixture.host.hostId, anchorPEM: 'not pem', pairPort: 1, runPort: 2, pairingId: randomUUID(), secret: 'secret', expiresAt: Date.now() + 1000 })).toString('base64url')}`
      await expect(fixture.client.pair({ label: 'bad', ssh, invitation: malformed })).rejects.toThrow('invalid_certificate')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})

describe('DesktopRemoteClient session write acknowledgements', () => {
  it.each(['fork', 'delete'])('keeps a malformed %s acknowledgement unknown without retrying', async (operation) => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'sessions', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      const original = fixture.tlsRequest.getMockImplementation()!
      fixture.tlsRequest.mockImplementation(async (options) => {
        const request = options.request as { op?: string }
        if (request.op === 'desktop') return { desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', sessionFork: true, sessionDelete: true } }
        if (request.op === 'sessionFork' || request.op === 'sessionDelete') return {}
        return original(options)
      })
      await fixture.client.connect(pending.connection.id)
      const request = operation === 'fork'
        ? fixture.client.forkSession(pending.connection.id, { providerId: 'claude', cwd: '/workspace', sourceSessionId: 'session', sourceRunId: 'run', sourceProviderTurnId: 'turn', sourceForkTurnId: 'boundary' })
        : fixture.client.deleteSession(pending.connection.id, { providerId: 'claude', cwd: '/workspace', externalSessionId: 'session', confirmed: true })
      await expect(request).rejects.toThrow('desktop_session_operation_unknown')
      expect(fixture.tlsRequest.mock.calls.filter(([options]) => ['sessionFork', 'sessionDelete'].includes((options.request as { op: string }).op))).toHaveLength(1)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})

describe('DesktopRemoteClient attachment submission fence', () => {
  it('does not persist an unknown intent during upload or after an upload failure', async () => {
    const fixture = await setup()
    let entered!: () => void
    let release!: () => void
    const uploading = new Promise<void>((resolve) => { entered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    try {
      const pending = await fixture.client.pair({ label: 'images', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      const original = fixture.tlsRequest.getMockImplementation()!
      fixture.tlsRequest.mockImplementation(async (options) => {
        const request = options.request as { op?: string }
        if (request.op === 'desktop') return { desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', attachments: { transport: 'chunked', maxBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxCount: 16, chunkBytes: 256 * 1024 } } }
        if (request.op === 'attachmentStart') { entered(); await blocked; throw new Error('network_down') }
        return original(options)
      })
      await fixture.client.connect(pending.connection.id)
      const request = { context: { cwd: '/workspace', providerId: 'claude' }, prompt: '', attachments: [{ kind: 'image' as const, name: 'image.png', mimeType: 'image/png' as const, dataBase64: 'iVBORw0KGgo=' }] }
      const sending = fixture.client.submit(pending.connection.id, request)
      const rejected = expect(sending).rejects.toThrow('attachment_transfer_failed')
      await uploading
      await expect(fixture.client.submit(pending.connection.id, request)).rejects.toThrow('submission_in_progress')
      expect(JSON.parse(decrypt(await readFile(join(fixture.directory, 'desktop-client.state')))).intents).toEqual([])
      release()
      await rejected
      await expect(fixture.client.intents(pending.connection.id)).resolves.toEqual([])
      expect(fixture.tlsRequest.mock.calls.some(([options]) => (options.request as { op?: string }).op === 'submit')).toBe(false)
    } finally { release(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})

describe('DesktopRemoteClient startup restoration', () => {
  async function pairedFixture() {
    const fixture = await setup({ unknownIntent: true })
    const pending = await fixture.client.pair({ label: 'Saved host', ssh, invitation: fixture.invitation })
    await fixture.client.finishPairing(pending.connection.id)
    await fixture.client.dispose()
    fixture.openTunnel.mockClear()
    fixture.tlsRequest.mockClear()
    return { ...fixture, id: pending.connection.id }
  }

  function reopen(fixture: Awaited<ReturnType<typeof pairedFixture>>) {
    return new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt }, fixture)
  }

  it('restores a legacy paired host once after restart without submitting work', async () => {
    const fixture = await pairedFixture()
    const client = reopen(fixture)
    try {
      await expect(client.list()).resolves.toMatchObject([{ state: 'disconnected' }])
      await Promise.all([client.restoreConnections(), client.restoreConnections()])
      await expect(client.list()).resolves.toMatchObject([{ id: fixture.id, state: 'connected' }])
      expect(fixture.openTunnel).toHaveBeenCalledTimes(1)
      expect(fixture.tlsRequest.mock.calls.map(([options]) => options.request)).toEqual([{ op: 'desktop', query: { kind: 'info' } }])
    } finally { await client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('persists manual disconnect across restart and opts back in after a successful manual connection', async () => {
    const fixture = await pairedFixture()
    let client = reopen(fixture)
    try {
      await client.restoreConnections()
      await client.disconnect(fixture.id)
      await client.dispose()
      fixture.openTunnel.mockClear()
      client = reopen(fixture)
      await client.restoreConnections()
      expect(fixture.openTunnel).not.toHaveBeenCalled()
      await expect(client.list()).resolves.toMatchObject([{ state: 'disconnected' }])
      await client.connect(fixture.id)
      await client.dispose()
      fixture.openTunnel.mockClear()
      client = reopen(fixture)
      await client.restoreConnections()
      expect(fixture.openTunnel).toHaveBeenCalledTimes(1)
      await expect(client.list()).resolves.toMatchObject([{ state: 'connected' }])
    } finally { await client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('skips pending and expired grants, isolates an offline host, and allows a manual retry', async () => {
    const fixture = await pairedFixture()
    const statePath = join(fixture.directory, 'desktop-client.state')
    const state = JSON.parse(decrypt(await readFile(statePath)))
    const saved = state.connections[0]
    state.connections = [
      { ...saved, id: 'pending', pending: { pairingId: randomUUID(), secret: 'pending', expiresAt: Date.now() + 60_000, publicKeySHA256: state.identity.publicKeySHA256 } },
      { ...saved, id: 'expired', certificateExpiresAt: Date.now() - 1 },
      { ...saved, id: 'offline' },
      saved
    ]
    await fs.writeFile(statePath, encrypt(JSON.stringify(state)))
    fixture.openTunnel.mockRejectedValueOnce(new Error('ssh_tunnel_exited:255'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = reopen(fixture)
    try {
      await client.restoreConnections()
      await expect(client.list()).resolves.toMatchObject([
        { id: 'pending', state: 'pairing' }, { id: 'expired', state: 'disconnected' },
        { id: 'offline', state: 'disconnected' }, { id: fixture.id, state: 'connected' }
      ])
      expect(fixture.openTunnel).toHaveBeenCalledTimes(2)
      expect(warning).toHaveBeenCalledWith('[scry] desktop connection restore failed:', 'offline', expect.objectContaining({ message: 'ssh_tunnel_exited:255' }))
      await client.restoreConnections()
      expect(fixture.openTunnel).toHaveBeenCalledTimes(2)
      await client.connect('offline')
      await expect(client.list()).resolves.toContainEqual(expect.objectContaining({ id: 'offline', state: 'connected' }))
    } finally { warning.mockRestore(); await client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rechecks a queued manual disconnect before restoring the next host', async () => {
    const fixture = await pairedFixture()
    const statePath = join(fixture.directory, 'desktop-client.state')
    const state = JSON.parse(decrypt(await readFile(statePath)))
    state.connections.push({ ...state.connections[0], id: 'next-host' })
    await fs.writeFile(statePath, encrypt(JSON.stringify(state)))
    let entered!: () => void
    let release!: () => void
    const opening = new Promise<void>((resolve) => { entered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const open = fixture.openTunnel.getMockImplementation()!
    fixture.openTunnel.mockImplementationOnce(async (options) => { entered(); await blocked; return open(options) })
    const client = reopen(fixture)
    try {
      const restoring = client.restoreConnections()
      await opening
      const disconnecting = client.disconnect('next-host')
      release()
      await Promise.all([restoring, disconnecting])
      expect(fixture.openTunnel).toHaveBeenCalledTimes(1)
      await expect(client.list()).resolves.toMatchObject([{ state: 'connected' }, { id: 'next-host', state: 'disconnected' }])
    } finally { release(); await client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not reconnect later hosts after disposal and closes the active tunnel', async () => {
    const fixture = await pairedFixture()
    const statePath = join(fixture.directory, 'desktop-client.state')
    const state = JSON.parse(decrypt(await readFile(statePath)))
    state.connections.push({ ...state.connections[0], id: 'next-host' })
    await fs.writeFile(statePath, encrypt(JSON.stringify(state)))
    let entered!: () => void
    let release!: () => void
    const opening = new Promise<void>((resolve) => { entered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const open = fixture.openTunnel.getMockImplementation()!
    fixture.openTunnel.mockImplementationOnce(async (options) => { entered(); await blocked; return open(options) })
    const client = reopen(fixture)
    try {
      const restoring = client.restoreConnections()
      await opening
      const disposing = client.dispose()
      release()
      await Promise.all([restoring, disposing])
      expect(fixture.openTunnel).toHaveBeenCalledTimes(1)
      expect((await fixture.openTunnel.mock.results[0].value).alive).toBe(false)
    } finally { release(); await client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('preserves unknown receipts without replaying a submit on startup', async () => {
    const fixture = await pairedFixture()
    let client = reopen(fixture)
    try {
      await client.connect(fixture.id)
      const receipt = await client.submit(fixture.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'send once' })
      expect(receipt.status).toBe('unknown')
      await client.dispose()
      fixture.tlsRequest.mockClear()
      client = reopen(fixture)
      await client.restoreConnections()
      await expect(client.intents(fixture.id)).resolves.toMatchObject([{ intentId: receipt.intentId, status: 'unknown' }])
      expect(fixture.tlsRequest.mock.calls.map(([options]) => options.request)).toEqual([
        { op: 'desktop', query: { kind: 'info' } }, { op: 'intentStatus', intentId: receipt.intentId }
      ])
    } finally { await client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it.each([
    { error: 'device_not_authorized' },
    { desktop: { kind: 'info', protocol: 1, hostId: randomUUID(), execution: 'canonical' } }
  ])('does not publish a restored connection when peer authorization fails: %j', async (response) => {
    const fixture = await pairedFixture()
    fixture.tlsRequest.mockResolvedValueOnce(response)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = reopen(fixture)
    try {
      await client.restoreConnections()
      await expect(client.list()).resolves.toMatchObject([{ state: 'disconnected' }])
      expect((await fixture.openTunnel.mock.results[0].value).alive).toBe(false)
      expect(warning).toHaveBeenCalledOnce()
    } finally { warning.mockRestore(); await client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})

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
      expect(Buffer.from(receivedImage ?? '', 'base64')).toEqual(imageBytes)
      expect(wire.filter(request => (request as { op?: string }).op === 'attachmentChunk')).toHaveLength(3)
      const submitted = wire.find(request => (request as { op?: string }).op === 'submit') as { detail: string }
      expect(submitted.detail.length).toBeLessThan(2048)
      expect(JSON.parse(submitted.detail).attachments[0].dataBase64).toBe('')
      const imageContext = { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-real' }
      const trace = await client.trace(pending.connection.id, imageContext, 'run-real-1')
      expect(Buffer.from(trace!.attachments![0].dataBase64, 'base64')).toEqual(imageBytes)
      const imageReads = () => wire.filter(request => (request as { query?: { kind?: string } }).query?.kind === 'image').length
      const initialImageReads = imageReads()
      await client.trace(pending.connection.id, imageContext, 'run-real-1', 1)
      expect(imageReads()).toBe(initialImageReads)
      liveRun = null
      const imageHistory = await client.history(pending.connection.id, imageContext)
      expect(Buffer.from(imageHistory.turns[0].attachments![0].dataBase64, 'base64')).toEqual(imageBytes)
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

describe('DesktopRemoteClient trace delta negotiation', () => {
  // `legacyHost` reproduces a host built before `traceDelta`: its info does not
  // declare the capability and its parser drops the unknown `delta` field.
  // `ignoresDelta` is a host that declared it at connect time but no longer
  // honours it (for example downgraded behind the same tunnel).
  async function deltaSetup(options: { legacyHost?: boolean; ignoresDelta?: boolean; tamper?: (result: Record<string, unknown>) => void } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-delta-'))
    const identity = await generateDesktopDeviceIdentity()
    const host = await ensureHostIdentity(join(directory, 'host'))
    const pairingId = randomUUID()
    const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: host.hostId, anchorPEM: host.caCertificatePEM, pairPort: 2201, runPort: 2202, pairingId, secret: 'pairing-secret', expiresAt: Date.now() + 60_000 })).toString('base64url')}`
    const cwd = '/workspace'
    const runId = 'run-delta-1'
    const run: ActiveRun = { runId, cwd, providerId: 'claude', externalSessionId: 'native', userText: 'task', items: [], done: false }
    const reader = createDesktopHostReader({ userDataDir: join(directory, 'user-data'), hostId: () => host.hostId, authorizeWorkspace: (path) => path, getRun: (id) => id === runId ? { ...run, items: run.items.map((item) => ({ ...item })) } : null })
    const queries: Record<string, unknown>[] = []
    const tlsRequest = vi.fn(async (input: { request: unknown }): Promise<unknown> => {
      const request = input.request as { operation?: string; requestId?: string; op?: string; query?: Record<string, unknown> }
      if (request.operation === 'pair.prove') return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.pending', pairingId, publicKeySHA256: identity.publicKeySHA256 }
      if (request.operation === 'pair.status') {
        const verified = await host.verifyCSR(identity.csrPEM)
        const grant = await host.issue({ ...verified, deviceId: randomUUID() })
        return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.granted', pairingId, deviceId: grant.deviceId, certificatePEM: grant.certificatePEM,
          certificateSHA256: grant.certificateSHA256, expiresAt: grant.expiresAt, scope: 'g0_echo_only' }
      }
      if (request.op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
      if (request.op === 'projects') return { projects: [] }
      if (request.op === 'providers') return { providers: [] }
      if (request.op === 'sessionsPage') return { sessionsPage: { sessions: [], cursor: 0, total: 0, hasMore: false, snapshot: 'catalog' } }
      if (request.op !== 'desktop') return { error: 'unexpected_request' }
      queries.push(JSON.parse(JSON.stringify(request.query)) as Record<string, unknown>)
      const query = JSON.parse(JSON.stringify(request.query)) as Record<string, unknown>
      if (options.legacyHost || options.ignoresDelta) delete query.delta
      const result = await reader(parseDesktopHostRead(query))
      if (options.legacyHost && result.kind === 'info') delete result.traceDelta
      const wire = JSON.parse(JSON.stringify({ desktop: result })) as { desktop: Record<string, unknown> }
      if (wire.desktop.kind === 'trace_delta') options.tamper?.(wire.desktop)
      return wire
    })
    const client = new DesktopRemoteClient({ directory, encrypt, decrypt }, { generateIdentity: async () => identity, openTunnel: async () => ({ pairPath: 'pair', runPath: 'run', alive: true, close: async () => {} }), tlsRequest })
    const pending = await client.pair({ label: 'Target', ssh, invitation })
    const id = pending.connection.id
    await client.finishPairing(id)
    await client.connect(id)
    const item = (index: number, text = `t${index}`) => ({ id: `event-${index}`, runId, ts: '2026-10-23T00:00:00Z', kind: 'model' as const, stage: 'text', text })
    const context = { cwd, providerId: 'claude', externalSessionId: 'native' }
    return { client, id, run, runId, context, item, queries, traceQueries: () => queries.filter((query) => query.kind === 'trace'), dispose: () => rm(directory, { recursive: true, force: true }) }
  }

  it('new client and new host exchange only changed items and reproduce the host run', async () => {
    const f = await deltaSetup()
    try {
      expect(await f.client.catalog(f.id)).toMatchObject({ traceDelta: 1 })
      f.run.items.push(f.item(0), f.item(1))
      const first = await f.client.traceDelta(f.id, f.context, f.runId)
      expect(first).toMatchObject({ kind: 'snapshot', cursor: { count: 2 }, run: { items: [f.item(0), f.item(1)], attachments: [] } })
      if (first.kind !== 'snapshot' || !first.cursor) throw new Error('expected a cursor')
      f.run.items[0] = f.item(0, 'persisted')
      f.run.items.push(f.item(2))
      const next = await f.client.traceDelta(f.id, f.context, f.runId, first.cursor, 0)
      expect(next).toMatchObject({ kind: 'delta', base: first.cursor.revision, cursor: { count: 3 }, changes: [{ index: 0, item: f.item(0, 'persisted') }, { index: 2, item: f.item(2) }] })
      expect(f.traceQueries().at(-1)).toMatchObject({ delta: { after: first.cursor } })
      const merged = mergeRemoteTrace({ run: first.run!, cursor: first.cursor }, next)
      expect(merged.kind === 'applied' && merged.view?.run.items).toEqual(f.run.items)
      // Invalid caller input fails before any host request.
      await expect(f.client.traceDelta(f.id, f.context, f.runId, { revision: first.cursor.revision, count: 2 }, -1)).rejects.toThrow('invalid_request')
    } finally { await f.dispose() }
  })

  it.each([
    ['an index outside count', (result: Record<string, unknown>) => { result.changes = [{ index: 5, item: (result.changes as { item: unknown }[])[0].item }] }],
    ['an item without identity', (result: Record<string, unknown>) => { result.changes = [{ index: 1, item: { text: 'x' } }] }],
    ['a run body inside the delta', (result: Record<string, unknown>) => { (result.run as Record<string, unknown>).items = [] }]
  ])('rejects a delta with %s', async (_name, tamper) => {
    const f = await deltaSetup({ tamper })
    try {
      f.run.items.push(f.item(0))
      const first = await f.client.traceDelta(f.id, f.context, f.runId)
      if (first.kind !== 'snapshot' || !first.cursor) throw new Error('expected a cursor')
      f.run.items.push(f.item(1))
      await expect(f.client.traceDelta(f.id, f.context, f.runId, first.cursor)).rejects.toThrow('invalid_trace_response')
    } finally { await f.dispose() }
  })

  it('new client and old host keep reading complete snapshots without a cursor', async () => {
    const f = await deltaSetup({ legacyHost: true })
    try {
      const catalog = await f.client.catalog(f.id)
      expect(catalog.traceDelta).toBeUndefined()
      f.run.items.push(f.item(0))
      const read = await f.client.traceDelta(f.id, f.context, f.runId)
      expect(read).toEqual({ kind: 'snapshot', run: expect.objectContaining({ items: [f.item(0)] }) })
      expect(f.traceQueries().every((query) => !('delta' in query))).toBe(true)
    } finally { await f.dispose() }
  })

  it('falls back to snapshots when a host that declared deltas answers in the legacy shape', async () => {
    const f = await deltaSetup({ ignoresDelta: true })
    try {
      f.run.items.push(f.item(0))
      const read = await f.client.traceDelta(f.id, f.context, f.runId, { revision: 'stale:1', count: 0 })
      expect(read).toEqual({ kind: 'snapshot', run: expect.objectContaining({ items: [f.item(0)] }) })
      expect(f.traceQueries().at(-1)).toMatchObject({ delta: { after: { revision: 'stale:1', count: 0 } } })
    } finally { await f.dispose() }
  })

  it.each([false, true])('the legacy trace read (old client) still returns the full run (old host: %s)', async (legacyHost) => {
    const f = await deltaSetup({ legacyHost })
    try {
      f.run.items.push(f.item(0), f.item(1))
      await expect(f.client.trace(f.id, f.context, f.runId)).resolves.toMatchObject({ runId: f.runId, items: [f.item(0), f.item(1)] })
      expect(f.traceQueries().every((query) => !('delta' in query))).toBe(true)
    } finally { await f.dispose() }
  })
})
