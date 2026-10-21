import { describe, expect, it } from 'vitest'
import { providerDiscoveryFixture } from '../../src/main/remote/provider-discovery.fixture'
import { defaultRepeats, measured, writeCollector } from '../performance-counters.mjs'

const selected = { detail: 'selected' as const, providerId: 'pi', agentProfileId: 'pi:fixture', cwd: '/workspace' }

describe('Provider discovery production orchestration counters', () => {
  it('counts adapter reads for the same three-context picker, without claiming process or model timing', async () => {
    const metadataReads: number[] = []
    const selectedReads: number[] = []
    const legacyReads: number[] = []
    for (let index = 0; index < defaultRepeats; index++) {
      const fixture = providerDiscoveryFixture()
      await fixture.discovery.refreshMetadata()
      expect(fixture.discovery.metadata()).toHaveLength(3)
      metadataReads.push(fixture.calls.length)
      const [first, second] = await Promise.all([fixture.discovery.selected(selected), fixture.discovery.selected(selected)])
      expect(first).toEqual(second)
      expect(first).toMatchObject({ id: 'pi', agentProfileId: 'pi:fixture', available: true })
      expect(fixture.calls.every((context) => context.cwd === '/workspace' && context.agentProfileId === 'pi:fixture')).toBe(true)
      selectedReads.push(fixture.calls.length)
      const legacy = providerDiscoveryFixture()
      expect(await legacy.discovery.legacy()).toHaveLength(3)
      legacyReads.push(legacy.calls.length)
    }
    expect(metadataReads).toEqual(Array(defaultRepeats).fill(0))
    expect(selectedReads).toEqual(Array(defaultRepeats).fill(1))
    expect(legacyReads).toEqual(Array(defaultRepeats).fill(3))
    const meta = { scenario: 'providers.discovery', layer: 'main' as const, unit: 'count', workload: '3available-contexts;open-picker-and-select-pi;2overlapping-selected-reads', source: 'production ProviderDiscovery orchestration; adapter-entry callbacks, not CLI processes' }
    writeCollector('provider-discovery', [
      measured({ ...meta, metric: 'metadata.controlReads' }, metadataReads),
      measured({ ...meta, metric: 'selected.controlReads' }, selectedReads),
      measured({ ...meta, metric: 'legacy.controlReads' }, legacyReads)
    ])
  })
})
