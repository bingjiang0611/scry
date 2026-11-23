import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { setup, ssh, statusSnapshot } from './desktop-client-fixtures'

describe('DesktopRemoteClient catalog snapshot', () => {
  it.each([false, true])('negotiates before listing providers (selected support: %s)', async (supported) => {
    const fixture = await setup({ providerDiscovery: supported })
    try {
      const pending = await fixture.client.pair({ label: 'Catalog', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      fixture.tlsRequest.mockClear()
      fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: {
        revision: 'r1',
        info: { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: fixture.host.hostId, execution: 'canonical', ...(supported ? { providerDiscovery: 2 } : {}) },
        projects: [],
        providers: [{ id: 'claude', label: 'Claude', available: true }],
      } })
      expect(await fixture.client.catalog(id)).toMatchObject({ providerEvidence: supported ? 'host_snapshot' : 'legacy_host' })
      expect(fixture.tlsRequest.mock.calls.map(([value]) => value.request)).toEqual([{ protocol: REMOTE_PROTOCOL_VERSION, op: 'catalogSnapshot' }])
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
  it.each(['completed', 'invented'])('validates terminal session evidence %s in the subscription', async (lastRunOutcome) => {
    const parked = new Promise<never>(() => {})
    const session = { sessionId: 's1', externalSessionId: 'native', providerId: 'pi', cwd: '/repo', label: 'Done', ts: 20, lastRunId: 'run-1', lastRunOutcome }
    const fixture = await setup({ subscribeResponse: request => request.known ? parked :
      statusSnapshot(fixture.host.hostId, { sessions: [{
        sessionKey: session.sessionId, provider: session.providerId, cwd: session.cwd, title: session.label, ts: session.ts,
        pinnedAt: null, archivedAt: null, pendingQuestions: 0, revSeq: 1, lastRunId: session.lastRunId,
        lastRunOutcome: { value: lastRunOutcome }, catalog: { nativeSessionId: session.externalSessionId }
      }] })
    })
    try {
      const pending = await fixture.client.pair({ label: 'Terminal catalog', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      if (lastRunOutcome === 'completed') expect((await fixture.client.catalog(id)).sessions).toMatchObject([session])
      else await expect(fixture.client.catalog(id)).rejects.toThrow('invalid_catalog_response')
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

  it('drops invalid or unknown hostAdminNoticeItems and truncates above cap without failing catalog read (W11 review #2)', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Notices', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)

      const validNotice = (n: number) => ({
        id: `n-${n}`,
        kind: 'device_approved_via_cli',
        ts: 1_700_000_000_000 + n,
        deviceLabel: `Phone ${n}`
      })
      const mixed = [
        validNotice(1),
        { id: 'future-1', kind: 'future_notice_kind_v9', ts: 1_700_000_000_999 },
        null,
        { id: '', kind: 'cli_approval_enabled', ts: -1 },
        ...Array.from({ length: 40 }, (_, i) => validNotice(i + 2))
      ]
      fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: {
        revision: 'r-notices-mixed',
        info: { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: fixture.host.hostId, execution: 'canonical', providerDiscovery: 2, hostAdminNotices: 1 },
        projects: [{ path: '/repo', label: 'repo' }],
        providers: [{ id: 'claude', label: 'Claude', available: true }],
        hostAdminNoticeItems: mixed
      } })
      const cat = await fixture.client.catalog(id)
      expect(cat.projects).toEqual([{ path: '/repo', label: 'repo' }])
      expect(cat.hostAdminNoticeItems?.length).toBe(32)
      expect(cat.hostAdminNoticeItems?.[0]?.id).toBe('n-1')
      expect(cat.hostAdminNoticeItems?.some((n) => (n as { id: string }).id === 'future-1')).toBe(false)

      fixture.tlsRequest.mockResolvedValueOnce({ catalogSnapshot: {
        revision: 'r-notices-non-array',
        info: { kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: fixture.host.hostId, execution: 'canonical', providerDiscovery: 2, hostAdminNotices: 1 },
        projects: [{ path: '/repo', label: 'repo' }],
        providers: [],
        hostAdminNoticeItems: 'unexpected-future-envelope'
      } })
      const cat2 = await fixture.client.catalog(id)
      expect(cat2.projects).toEqual([{ path: '/repo', label: 'repo' }])
      expect(cat2.hostAdminNoticeItems).toBeUndefined()
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

})
