import { describe, expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { capabilityReady, capabilityUnavailable, type ProviderContext, type ProviderDescriptor } from '../../shared/provider'
import { providerDiscoveryFixture } from './provider-discovery.fixture'
import { isRemoteProviderObservationTime } from '../../shared/desktop-remote'

const pi = { detail: 'selected' as const, providerId: 'pi', agentProfileId: 'pi:fixture', cwd: '/workspace' }
const ready = (context: ProviderContext) => capabilityReady(context, 'read', { models: [], permissions: [] })

describe('selected Provider discovery production path', () => {
  it('keeps metadata and selected observation times separate without a settled capability cache', async () => {
    let now = 1000
    const { discovery, calls } = providerDiscoveryFixture({ now: () => now })
    await discovery.refreshMetadata()
    expect(discovery.metadata().every((row) => row.observedAt === 1000)).toBe(true)
    now = 2000
    expect((await discovery.selected(pi)).observedAt).toBe(2000)
    expect(discovery.metadata()[0].observedAt).toBe(1000)
    // Publication identity must still change when the host clock is unchanged.
    now = 1000
    await discovery.refreshMetadata()
    expect(discovery.metadata()[0]).toMatchObject({ observedAt: 1000, metadataRevision: 2 })
    expect(calls).toHaveLength(1)
    now = 4000
    expect((await discovery.selected(pi)).observedAt).toBe(4000)
    expect(calls).toHaveLength(2)
  })

  it('refreshes metadata without initializing any Provider, then only reads the selected context', async () => {
    const { discovery, calls } = providerDiscoveryFixture()
    await discovery.refreshMetadata()
    expect(discovery.metadata().map((row) => row.id)).toEqual(['pi', 'qoder', 'opencode'])
    expect(discovery.metadata().every((row) => !row.models && !row.permissions)).toBe(true)
    expect(calls).toEqual([])
    expect(await discovery.selected(pi)).toMatchObject({ id: 'pi', agentProfileId: 'pi:fixture', available: true })
    expect(calls).toEqual([{ providerId: 'pi', agentProfileId: 'pi:fixture', cwd: '/workspace' }])
  })

  it('validates optional observation time without inventing a current timestamp', () => {
    expect(isRemoteProviderObservationTime(0)).toBe(true)
    expect(isRemoteProviderObservationTime(1700000000000)).toBe(true)
    for (const value of [undefined, '1000', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(isRemoteProviderObservationTime(value)).toBe(false)
    }
  })

  it('does not wait for a different selected Provider and never starts an unselected one', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const controls = vi.fn(async (context: ProviderContext) => {
      if (context.providerId === 'qoder') await blocked
      return ready(context)
    })
    const { discovery } = providerDiscoveryFixture({ controls })
    const slow = discovery.selected({ detail: 'selected', providerId: 'qoder', cwd: '/workspace' })
    try {
      expect(await discovery.selected(pi)).toMatchObject({ id: 'pi', available: true })
      expect(controls.mock.calls.map(([context]) => context.providerId)).toEqual(['qoder', 'pi'])
    } finally {
      release()
      await slow
    }
  })

  it('coalesces canonical aliases only while the same context is in flight', async () => {
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const controls = vi.fn(async (context: ProviderContext) => { entered(); await blocked; return ready(context) })
    const { discovery } = providerDiscoveryFixture({ controls })
    const first = discovery.selected(pi)
    const second = discovery.selected({ ...pi, cwd: '/workspace-alias' })
    await started
    release()
    await Promise.all([first, second])
    expect(controls).toHaveBeenCalledTimes(1)
    await discovery.selected(pi)
    expect(controls).toHaveBeenCalledTimes(2)
  })

  it('rejects unauthorized workspace and Provider/profile mismatches before the adapter', async () => {
    const { discovery, calls } = providerDiscoveryFixture()
    await expect(discovery.selected({ ...pi, cwd: '/outside' })).rejects.toThrow('workspace_not_authorized')
    await expect(discovery.selected({ ...pi, agentProfileId: 'pi:missing' })).rejects.toThrow('invalid_provider_context')
    await expect(discovery.selected({ ...pi, agentProfileId: undefined })).rejects.toThrow('invalid_provider_context')
    await expect(discovery.selected({ ...pi, providerId: 'qoder' })).rejects.toThrow('invalid_provider_context')
    await expect(discovery.selected({ ...pi, providerId: 'missing' })).rejects.toThrow('invalid_provider_context')
    expect(calls).toEqual([])
  })

  it('revalidates workspace authorization before joining a pending read', async () => {
    let allowed = true
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const controls = vi.fn(async (context: ProviderContext) => { entered(); await blocked; return ready(context) })
    const { discovery } = providerDiscoveryFixture({
      controls,
      authorizeWorkspace: (cwd) => { if (!allowed) throw new Error('revoked'); return cwd }
    })
    const first = discovery.selected(pi)
    await started
    allowed = false
    try {
      await expect(discovery.selected(pi)).rejects.toThrow('revoked')
      expect(controls).toHaveBeenCalledTimes(1)
    } finally { release(); await first }
  })

  it('fences a pending pre-invalidation result and reads once again after the adapter settles', async () => {
    let release!: () => void
    let entered!: () => void
    let reads = 0
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const controls = vi.fn(async (context: ProviderContext) => {
      if (reads++ === 0) { entered(); await blocked }
      return ready(context)
    })
    const { discovery, profiles } = providerDiscoveryFixture({ controls })
    const old = discovery.selected(pi)
    await started
    profiles[0].label = 'Renamed profile'
    discovery.invalidate('pi')
    const fresh = discovery.selected(pi)
    await setImmediate()
    expect(controls).toHaveBeenCalledTimes(1)
    release()
    const [oldResult, freshResult] = await Promise.all([old, fresh])
    expect(oldResult.available).toBe(false)
    expect(freshResult.available).toBe(true)
    expect(controls).toHaveBeenCalledTimes(2)
  })

  it('does not publish metadata captured before an explicit invalidation', async () => {
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fixture = providerDiscoveryFixture({ descriptors: async (): Promise<ProviderDescriptor[]> => {
      entered(); await blocked; return fixture.descriptors
    } })
    const old = fixture.discovery.refreshMetadata()
    await started
    fixture.discovery.invalidate('pi')
    release()
    await old
    expect(fixture.discovery.metadata()).toEqual([])
    await fixture.discovery.refreshMetadata()
    expect(fixture.discovery.metadata()).toHaveLength(3)
  })

  it('does not let an invalidated pending legacy snapshot refill its cache', async () => {
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let reads = 0
    const controls = vi.fn(async (context: ProviderContext) => {
      if (reads++ === 0) { entered(); await blocked }
      return ready(context)
    })
    const { discovery } = providerDiscoveryFixture({ controls })
    const old = discovery.legacy()
    await started
    discovery.invalidate('pi')
    const fresh = discovery.legacy()
    await setImmediate()
    expect(controls).toHaveBeenCalledTimes(3)
    release()
    expect((await old).find(row => row.id === 'pi')?.available).toBe(false)
    expect((await fresh).find(row => row.id === 'pi')?.available).toBe(true)
    expect(controls).toHaveBeenCalledTimes(6)
    await discovery.legacy()
    expect(controls).toHaveBeenCalledTimes(6)
  })

  it('invalidates an explicitly requested legacy snapshot before its TTL when configuration changes', async () => {
    const { discovery, calls } = providerDiscoveryFixture({ now: () => 1000 })
    await discovery.legacy()
    expect(calls).toHaveLength(3)
    discovery.invalidate('pi')
    await discovery.legacy()
    expect(calls).toHaveLength(6)
  })

  it('reports failure as unavailable without keeping an old successful catalog', async () => {
    const controls = vi.fn(async (context: ProviderContext) => ready(context))
    const { discovery, errors } = providerDiscoveryFixture({ controls })
    expect((await discovery.selected(pi)).available).toBe(true)
    controls.mockRejectedValueOnce(new Error('Provider auth operation is busy'))
    expect(await discovery.selected(pi)).toMatchObject({ id: 'pi', available: false })
    expect(errors).toHaveLength(1)
    controls.mockImplementationOnce(async (context) => capabilityUnavailable(context, 'unknown', 'probe failed'))
    expect((await discovery.selected(pi)).available).toBe(false)
    expect((await discovery.selected(pi)).available).toBe(true)
    expect(controls).toHaveBeenCalledTimes(4)
  })

  it('only reuses a full legacy snapshot when explicitly requested and for its existing 60s TTL', async () => {
    let now = 0
    const { discovery, calls } = providerDiscoveryFixture({ now: () => now })
    await discovery.refreshMetadata()
    expect(calls).toHaveLength(0)
    expect(await discovery.legacy()).toHaveLength(3)
    expect(calls).toHaveLength(3)
    now = 59_999
    await discovery.legacy()
    expect(calls).toHaveLength(3)
    now = 60_000
    await discovery.legacy()
    expect(calls).toHaveLength(6)
  })
})
