import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { setup, ssh } from './desktop-client-fixtures'

// The catalog wire shape: one snapshot round trip, its unchanged path, and the
// capability it carries for Provider controls.
describe('DesktopRemoteClient catalog snapshot', () => {
  it.each([false, true])('negotiates before listing providers (selected support: %s)', async (supported) => {
    const fixture = await setup({ providerDiscovery: supported })
    try {
      const pending = await fixture.client.pair({ label: 'Catalog', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      fixture.tlsRequest.mockClear()
      // One round trip carries info, projects, provider metadata and the first
      // session page; the negotiated capability rides in the same reply.
      fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: {
        revision: 'r1',
        info: { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: fixture.host.hostId, execution: 'canonical', ...(supported ? { providerDiscovery: 2 } : {}) },
        projects: [],
        providers: [{ id: 'claude', label: 'Claude', available: true }],
        sessionsPage: { sessions: [], cursor: 0, total: 0, hasMore: false, snapshot: 'fixture' }
      } })
      expect(await fixture.client.catalog(id)).toMatchObject({ providerEvidence: supported ? 'host_snapshot' : 'legacy_host' })
      expect(fixture.tlsRequest.mock.calls.map(([value]) => value.request)).toEqual([{ protocol: REMOTE_PROTOCOL_VERSION, op: 'catalogSnapshot' }])
      // Re-reading the same host sends the revision and costs no payload.
      fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: { unchanged: true, revision: 'r1' } })
      expect(await fixture.client.catalog(id)).toMatchObject({ providerEvidence: supported ? 'host_snapshot' : 'legacy_host', projects: [], sessions: [] })
      expect(fixture.tlsRequest.mock.calls.map(([value]) => value.request).at(-1)).toEqual({ protocol: REMOTE_PROTOCOL_VERSION, op: 'catalogSnapshot', revision: 'r1' })
      // Provider controls reuse the snapshot's capability instead of asking again.
      if (supported) {
        fixture.tlsRequest.mockResolvedValueOnce({ providers: [{ id: 'claude', label: 'Claude', available: true }] })
        await fixture.client.providerControls(id, { cwd: '/workspace', providerId: 'claude' })
        expect(fixture.tlsRequest.mock.calls.map(([value]) => (value.request as { op?: string }).op).slice(-2)).toEqual(['catalogSnapshot', 'providers'])
      } else {
        await expect(fixture.client.providerControls(id, { cwd: '/workspace', providerId: 'claude' })).rejects.toThrow('provider_controls_unavailable')
      }
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
  it('validates terminal session evidence instead of accepting invented outcomes', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Terminal catalog', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const session = { sessionId: 's1', externalSessionId: 'native', providerId: 'pi', cwd: '/repo', label: 'Done', ts: 20,
        lastRunId: 'run-1', lastRunOutcome: 'completed' }
      for (const lastRunOutcome of ['completed', 'invented']) {
        fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: {
          revision: `r-${lastRunOutcome}`,
          info: { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: fixture.host.hostId, execution: 'canonical', providerDiscovery: 2 },
          projects: [], providers: [],
          sessionsPage: { sessions: [{ ...session, lastRunOutcome }], cursor: 1, total: 1, hasMore: false, snapshot: 'fixture' }
        } })
        if (lastRunOutcome === 'completed') expect((await fixture.client.catalog(id)).sessions).toEqual([session])
        else await expect(fixture.client.catalog(id)).rejects.toThrow('invalid_catalog_response')
      }
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
        protocol: REMOTE_PROTOCOL_VERSION, op: 'providers', detail: 'selected', providerId: 'claude', cwd: '/workspace'
      } }))
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

})
