import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import { requestOn, withPairedHost } from './desktop-host-fixtures'
import { setup, ssh } from './desktop-client-fixtures'

// The run-channel version gate. Three paths, each asserted on the real stack:
// matching versions talk, a mismatch is refused and names the older end, and a
// request that declares nothing is refused rather than assumed current.
describe('run-channel protocol version', () => {
  it('refuses a request that declares no version', async () => {
    await withPairedHost(async ({ lanes, endpoint }) => {
      const reply = await lanes.request('control', 'c1', { endpoint, request: { op: 'projects' }, replayable: true })
      expect(reply).toEqual({ error: 'protocol_mismatch', hostProtocol: REMOTE_PROTOCOL_VERSION, clientProtocol: null })
    })
  })

  it('refuses an older client and reports that the client is behind', async () => {
    await withPairedHost(async ({ lanes, endpoint }) => {
      const reply = await requestOn(lanes, 'control', 'c1', { endpoint, request: { op: 'projects', protocol: REMOTE_PROTOCOL_VERSION - 1 }, replayable: true })
      expect(reply).toEqual({ error: 'protocol_mismatch', hostProtocol: REMOTE_PROTOCOL_VERSION, clientProtocol: REMOTE_PROTOCOL_VERSION - 1 })
    })
  })

  it('refuses a newer client and reports that the host is behind', async () => {
    await withPairedHost(async ({ lanes, endpoint }) => {
      const reply = await requestOn(lanes, 'control', 'c1', { endpoint, request: { op: 'projects', protocol: REMOTE_PROTOCOL_VERSION + 1 }, replayable: true })
      expect(reply).toEqual({ error: 'protocol_mismatch', hostProtocol: REMOTE_PROTOCOL_VERSION, clientProtocol: REMOTE_PROTOCOL_VERSION + 1 })
    })
  })

  it('turns each mismatch into copy that says which end to upgrade', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Version', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      // The host refuses before answering with data, so the client must not read
      // the refusal as an empty catalog.
      fixture.tlsRequest.mockResolvedValueOnce({ error: 'protocol_mismatch', hostProtocol: REMOTE_PROTOCOL_VERSION - 1, clientProtocol: REMOTE_PROTOCOL_VERSION })
      await expect(fixture.client.catalog(id)).rejects.toThrow('desktop_protocol_host_older')
      fixture.tlsRequest.mockResolvedValueOnce({ error: 'protocol_mismatch', hostProtocol: REMOTE_PROTOCOL_VERSION + 1, clientProtocol: REMOTE_PROTOCOL_VERSION })
      await expect(fixture.client.catalog(id)).rejects.toThrow('desktop_protocol_client_older')
      // A refusal that names no versions cannot pick a direction; it stays generic.
      fixture.tlsRequest.mockResolvedValueOnce({ error: 'protocol_mismatch' })
      await expect(fixture.client.catalog(id)).rejects.toThrow('desktop_protocol_mismatch')
      // A host that states an older version in `info` is the same refusal, so an
      // old host cannot be mistaken for a host without capabilities.
      fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: {
        revision: 'r1',
        info: { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION - 1, hostId: fixture.host.hostId, execution: 'canonical' },
        projects: [], providers: [],
        sessionsPage: { sessions: [], cursor: 0, total: 0, hasMore: false, snapshot: 's' }
      } })
      await expect(fixture.client.catalog(id)).rejects.toThrow('desktop_protocol_host_older')
      fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: {
        revision: 'r2',
        info: { kind: 'info', hostId: fixture.host.hostId, execution: 'canonical' },
        projects: [], providers: [],
        sessionsPage: { sessions: [], cursor: 0, total: 0, hasMore: false, snapshot: 's' }
      } })
      await expect(fixture.client.catalog(id)).rejects.toThrow('desktop_protocol_missing')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})
