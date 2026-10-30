import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { DesktopRemoteClient } from './desktop-client'
import { generateDesktopDeviceIdentity } from './desktop-transport'
import { decrypt, encrypt, setup, ssh } from './desktop-client-fixtures'

describe('DesktopRemoteClient connection and receipt lifecycle', () => {
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
