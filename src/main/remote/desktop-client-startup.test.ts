import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopRemoteClient } from './desktop-client'
import { decrypt, encrypt, setup, ssh } from './desktop-client-fixtures'

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
