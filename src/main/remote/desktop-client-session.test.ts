import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { setup, ssh } from './desktop-client-fixtures'

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
