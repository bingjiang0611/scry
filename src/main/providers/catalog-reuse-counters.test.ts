import { afterEach, describe, expect, it } from 'vitest'
import { setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'
import { disposePiCatalog } from './pi-catalog'
import { probePiAgent } from './pi'
import { withProbeFixture } from './pi-rpc.fixture'

const samples: PerformanceSample[] = []

afterEach(() => { setPerformanceRecordingSink(null); samples.length = 0 })

// The warm-pool benefit is invisible while every probe is one number: a cold probe
// pays Provider startup, a reused one answers from a running child. These counters
// are what an active-session hit rate is computed from.
describe('pi catalog probe reuse counters', () => {
  it('marks the first probe cold and the parked-process probe reused', async () => {
    setPerformanceRecordingSink(sample => samples.push(sample))
    await withProbeFixture(async (profile, cwd, starts) => {
      await probePiAgent(profile, cwd)
      await probePiAgent(profile, cwd)
      expect(starts()).toHaveLength(1)
      const probes = samples.filter(sample => sample.name === 'pi.catalog.probe')
      expect(probes.map(probe => probe.counters)).toEqual([{ catalogCold: 1 }, { catalogReused: 1 }])
      expect(probes.every(probe => probe.outcome === 'completed')).toBe(true)
      await disposePiCatalog()
    })
  })
})
