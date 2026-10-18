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
import { PairingTransport } from './pairing-transport'
import { RunOutputFileStore } from './run-output-file'
import { ProviderOperationGate } from '../provider-operation-gate'
import { listDesktopDirectories, selectDesktopDirectory } from './desktop-directory-picker'
import { createDesktopHostReader } from './desktop-host-reader'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'

const ssh = { hostname: 'desktop.example', username: 'scry', port: 22 }
const encrypt = (value: string): Buffer => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
const decrypt = (value: Buffer): string => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()

async function setup(setupOptions: { submitResponse?: () => unknown; unknownIntent?: boolean; encrypt?: typeof encrypt } = {}) {
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
    if (phase === 'status' && (request as { op?: string }).op === 'desktop') return { desktop: { kind: 'info', protocol: 1, hostId: host.hostId, execution: 'canonical' } }
    if ((request as { op?: string }).op === 'submit') {
      if (setupOptions.submitResponse) return setupOptions.submitResponse()
      throw new Error('network_down')
    }
    if ((request as { op?: string }).op === 'intentStatus' && setupOptions.unknownIntent) return { error: 'unknown_intent' }
    if ((request as { op?: string }).op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
    return { error: 'unexpected_request' }
  })
  const openTunnel = vi.fn(async (_options: { username: string; hostname: string; port: number; pairPort: number; runPort: number }) => tunnel())
  const client = new DesktopRemoteClient({ directory, encrypt: setupOptions.encrypt ?? encrypt, decrypt }, { generateIdentity: async () => identity, openTunnel, tlsRequest })
  return { directory, host, invitation, client, openTunnel, tlsRequest, phase: () => phase, tunnelCount: () => tunnelCount, dropTunnel: () => tunnelShutdowns.at(-1)!() }
}

describe('DesktopRemoteClient', () => {
  it('reassembles bounded history chunks and rejects malformed or non-progressing pages', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'History', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const context = { cwd: '/workspace', providerId: 'pi', externalSessionId: 'session' }
      const history = { turns: [{ userText: 'prompt', items: [{ id: 'event', ts: '2026-10-14', runId: 'run', kind: 'model', stage: 'text', text: 'x'.repeat(DESKTOP_HISTORY_CHUNK_BYTES) }] }], hasOlder: true, before: 5, snapshot: 'stamp', source: 'trace_archive', status: 'available' }
      const result = { kind: 'history', history }
      const bytes = Buffer.from(JSON.stringify(result))
      const first = { kind: 'history_chunk', id: randomUUID(), offset: 0, totalBytes: bytes.length, data: bytes.subarray(0, DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      const second = { ...first, offset: DESKTOP_HISTORY_CHUNK_BYTES, data: bytes.subarray(DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: second })
      const loaded = await fixture.client.history(id, context, 7, 'stamp')
      expect(loaded).toMatchObject(history)
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: { op: 'desktop', query: { kind: 'history', context, before: 7, snapshot: 'stamp', byteChunks: true, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } } } }))
      // Hosts that do not know byteChunks still return their original envelope.
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: result })
      await expect(fixture.client.history(id, context)).resolves.toMatchObject(history)
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

describe('DesktopRemoteClient over real host TLS', () => {
  it.each([false, true])('completes production wire lifecycle independently of output capture failure (%s)', async (captureFailure) => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-real-'))
    const identity = await ensureHostIdentity(join(directory, 'identity'))
    const rememberDirectory = vi.fn()
    let outputReads: MockInstance | undefined
    const binding = await createHostController({
      stateDirectory: directory,
      hostId: identity.hostId,
      anchorSHA256: identity.anchorSHA256,
      verifyCSR: identity.verifyCSR,
      issue: identity.issue,
      authorizeWorkspace: (cwd) => cwd,
      startRun: async ({ progress, runId, output }) => {
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
      readDesktop: createDesktopHostReader({ userDataDir: directory, hostId: () => identity.hostId, authorizeWorkspace: cwd => cwd, getRun: () => null })
    })
    const server = await identity.issueHostServer()
    const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
    const innerHost = new InnerMtlsHost({ controller: binding.controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
    const pairAddress = await pairingTransport.listen()
    const runAddress = await innerHost.listen()
    const wire: unknown[] = []
    let dropSubmitResponse = true
    const tlsRequest = async (options: { path: string; caPEM: string; certPEM: string; keyPEM: string; request: unknown; signal?: AbortSignal }): Promise<unknown> => {
      wire.push(options.request)
      const address = options.path === `pair:${pairAddress.port}` ? pairAddress : runAddress
      const response = await desktopTlsRequest({ ...options, path: undefined, host: address.host, port: address.port })
      if (dropSubmitResponse && (options.request as { op?: string }).op === 'submit') { dropSubmitResponse = false; throw new Error('response_lost_after_delivery') }
      return response
    }
    const openTunnel = async (): Promise<DesktopSshTunnel> => ({ pairPath: `pair:${pairAddress.port}`, runPath: `run:${runAddress.port}`, alive: true, close: async () => {} })
    const client = new DesktopRemoteClient({ directory: join(directory, 'client'), encrypt, decrypt }, { openTunnel, tlsRequest })
    try {
      const pairing = await binding.controller.authority.begin()
      const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: identity.hostId, anchorPEM: identity.caCertificatePEM, pairPort: pairAddress.port, runPort: runAddress.port, pairingId: pairing.pairingId, secret: pairing.secret, expiresAt: pairing.expiresAt })).toString('base64url')}`
      const pending = await client.pair({ label: 'real desktop', ssh, invitation })
      await binding.controller.authority.confirmLocal(pairing.pairingId, pending.publicKeySHA256)
      const paired = await client.finishPairing(pending.connection.id)
      expect(paired.state).toBe('paired')
      await client.connect(pending.connection.id)
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
      if (!captureFailure) {
        const context = { cwd: directory, providerId: 'pi' as const, externalSessionId: 'large-session' }
        const text = '中文🙂\"\n'.repeat(400_000)
        for (let i = 0; i < 3; i++) expect(upsertTraceArchiveTurn({
          cwd: directory, userDataDir: directory, sessionId: context.externalSessionId, providerId: 'pi',
          turn: { runId: `history-${i}`, userText: `prompt ${i}`, done: true, items: [{ id: `event-${i}`, ts: '2026-10-14T00:00:00Z', runId: `history-${i}`, kind: 'model', stage: 'text', text: i === 2 ? text : `answer ${i}` }] }
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
      const unknownIntent = await client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'real wire' })
      expect(unknownIntent.status).toBe('unknown')
      const intent = await client.intentStatus(pending.connection.id, unknownIntent.intentId)
      expect(intent.status).toBe('recorded')
      await binding.controller.idle()
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
