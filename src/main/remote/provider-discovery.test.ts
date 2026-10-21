import { describe, expect, it, vi } from 'vitest'
import { capabilityReady, capabilityUnavailable, type ProviderContext } from '../../shared/provider'
import { providerDiscoveryFixture } from './provider-discovery.fixture'

const pi = { detail: 'selected' as const, providerId: 'pi', agentProfileId: 'pi:fixture', cwd: '/workspace' }
const ready = (context: ProviderContext) => capabilityReady(context, 'read', { models: [], permissions: [] })

describe('selected Provider discovery production path', () => {
  it('refreshes metadata without initializing any Provider, then only reads the selected context', async () => {
    const { discovery, calls } = providerDiscoveryFixture()
    await discovery.refreshMetadata()
    expect(discovery.metadata().map((row) => row.id)).toEqual(['pi', 'qoder', 'opencode'])
    expect(discovery.metadata().every((row) => !row.models && !row.permissions)).toBe(true)
    expect(calls).toEqual([])
    expect(await discovery.selected(pi)).toMatchObject({ id: 'pi', agentProfileId: 'pi:fixture', available: true })
    expect(calls).toEqual([{ providerId: 'pi', agentProfileId: 'pi:fixture', cwd: '/workspace' }])
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
