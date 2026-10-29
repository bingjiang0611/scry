import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'
import { withProbeFixture } from '../../src/main/providers/pi-rpc.fixture'
import { createPiAdapter, probePiAgent } from '../../src/main/providers/pi'

const workload = 'workspaces=2;probes=3;invalidate-workspace-a=1;revisit-workspace-b=1'
const source = 'production Pi adapter invalidation and catalog probe lifecycle with real offline RPC children'

describe('Pi catalog invalidation isolation work', () => {
  it('measures whether refreshing one workspace restarts an unrelated warm probe', async () => {
    const runs = await repeatCounters(defaultRepeats, async () => {
      let processes = 0
      await withProbeFixture(async (profile, cwd, starts) => {
        const otherCwd = join(cwd, 'other')
        mkdirSync(otherCwd)
        const adapter = createPiAdapter({
          listProfiles: async () => [profile],
          resolveProfile: async () => profile
        })
        const context = { providerId: 'pi' as const, agentProfileId: profile.id, cwd }
        try {
          await expect(probePiAgent(profile, cwd)).resolves.toMatchObject({ state: { cwd } })
          await expect(probePiAgent(profile, otherCwd)).resolves.toMatchObject({ state: { cwd: otherCwd } })
          await adapter.invalidateContext?.(context)
          await expect(probePiAgent(profile, otherCwd)).resolves.toMatchObject({ state: { cwd: otherCwd } })
          expect(new Set(starts())).toEqual(new Set([cwd, otherCwd]))
          processes = starts().length
        } finally {
          await adapter.dispose?.()
        }
      })
      return { processes }
    })
    writeCollector('pi-probe-isolated-invalidation', [
      measured({
        scenario: 'providers.pi-probe-isolated-invalidation',
        metric: 'subprocess.rpc',
        layer: 'main',
        unit: 'count',
        workload,
        source
      }, runs.processes)
    ])
  }, 120_000)
})
