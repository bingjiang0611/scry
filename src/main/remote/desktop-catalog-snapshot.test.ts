import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { requestOn, withPairedHost } from './desktop-host-fixtures'

type Snapshot = { revision: string; info: unknown; projects: unknown[]; providers: unknown[]; sessionsPage: { sessions: unknown[]; cursor: number; total: number; hasMore: boolean; snapshot: string } }

// The claim is "one round trip for the catalog", so these run over the real lane
// and count what the host actually received.
describe('one catalog snapshot per round trip', () => {
  it('answers info, projects, providers and the first session page together', async () => {
    await withPairedHost(async ({ lanes, endpoint }) => {
      const response = await requestOn(lanes, 'bulk', 'c1', { endpoint, request: { op: 'catalogSnapshot' }, replayable: true }) as { catalogSnapshot: Snapshot }
      const snapshot = response.catalogSnapshot
      expect(snapshot.revision).toMatch(/^[a-f0-9]{32}$/)
      expect(snapshot.info).toMatchObject({ kind: 'info', execution: 'canonical' })
      expect(Array.isArray(snapshot.projects)).toBe(true)
      expect(Array.isArray(snapshot.providers)).toBe(true)
      expect(snapshot.sessionsPage).toMatchObject({ cursor: 0, hasMore: false })
      expect(typeof snapshot.sessionsPage.snapshot).toBe('string')
    })
  })

  it('answers unchanged when the device already holds that revision', async () => {
    await withPairedHost(async ({ lanes, endpoint }) => {
      const first = await requestOn(lanes, 'bulk', 'c1', { endpoint, request: { op: 'catalogSnapshot' }, replayable: true }) as { catalogSnapshot: Snapshot }
      const second = await requestOn(lanes, 'bulk', 'c1', { endpoint, request: { op: 'catalogSnapshot', revision: first.catalogSnapshot.revision }, replayable: true }) as { catalogSnapshot: unknown }
      // The payload is not re-sent: the reply is the flag and the revision only.
      expect(second.catalogSnapshot).toEqual({ unchanged: true, revision: first.catalogSnapshot.revision })
      const stale = await requestOn(lanes, 'bulk', 'c1', { endpoint, request: { op: 'catalogSnapshot', revision: 'deadbeef' }, replayable: true }) as { catalogSnapshot: Snapshot }
      // A revision the host does not recognize is answered in full, never guessed.
      expect(stale.catalogSnapshot).toMatchObject({ revision: first.catalogSnapshot.revision })
      expect(stale.catalogSnapshot).toHaveProperty('projects')
    })
  })

  it('refuses a revoked device instead of serving a cached catalog', async () => {
    await withPairedHost(async ({ service, lanes, endpoint, deviceId }) => {
      await expect(requestOn(lanes, 'bulk', 'c1', { endpoint, request: { op: 'catalogSnapshot' }, replayable: true })).resolves.toHaveProperty('catalogSnapshot')
      await service.revokeDevice(deviceId)
      await expect(requestOn(lanes, 'bulk', 'c2', { endpoint, request: { op: 'catalogSnapshot' }, replayable: true }))
        .resolves.toEqual({ error: 'device_not_authorized' })
    })
  })
})
