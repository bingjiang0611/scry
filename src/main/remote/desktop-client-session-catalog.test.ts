import { rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { setup, ssh } from './desktop-client-fixtures'

describe('DesktopRemoteClient session catalog bindings', () => {
  it('accepts the real composite connection id when focus enters or leaves a session', async () => {
    const viewed = vi.fn()
    const attention = { baseline: vi.fn(), catalog: vi.fn(() => []), viewed, disconnect: vi.fn(), forget: vi.fn() }
    const fixture = await setup({ attention })
    try {
      const pending = await fixture.client.pair({ label: 'Attention', ssh, invitation: fixture.invitation })
      const context = { cwd: '/workspace', providerId: 'pi', externalSessionId: 'native-session' }
      await fixture.client.setViewedSession(pending.connection.id, context)
      await fixture.client.setViewedSession(pending.connection.id, null)
      expect(viewed).toHaveBeenNthCalledWith(1, pending.connection.id, context)
      expect(viewed).toHaveBeenNthCalledWith(2, pending.connection.id, null)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})
