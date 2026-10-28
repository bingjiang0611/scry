import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { createPiAdapter } from './pi'
import { withProbeFixture } from './pi-rpc.fixture'

describe('Pi metering delivery', () => {
  it.each(['completed', 'failed', 'stop', 'missing-cache', 'missing-credit'])(
    'delivers cumulative cache samples and attributed Credits: %s', async (scenario) => {
      await withProbeFixture(async (profile, cwd) => {
        const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
        const events: TraceEvent[] = []
        const handle = adapter.run({ runId: 'metering', prompt: `usage:${scenario}`, cwd, agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event) })
        if (scenario === 'stop') {
          await vi.waitFor(() => expect(events.filter((event) => event.stage === 'usage_snapshot')).toHaveLength(2))
          handle.interrupt()
        }
        if (scenario === 'failed') await expect(handle.promise).rejects.toThrow('fixture failure')
        else await expect(handle.promise).resolves.toMatchObject({ status: scenario === 'stop' ? 'interrupted' : 'completed' })
        const snapshots = events.filter((event) => event.stage === 'usage_snapshot')
        expect(snapshots).toHaveLength(2)
        expect(snapshots[0]).toMatchObject({ tokensIn: 100, cacheReadTokens: 100, cacheCreationTokens: 0 })
        expect(snapshots[1].tokensIn).toBe(100)
        expect(snapshots[1].cacheReadTokens).toBe(scenario === 'missing-cache' ? undefined : 300)
        expect(events.indexOf(snapshots[1])).toBeLessThan(events.findIndex((event) => event.stage === 'result'))
        const result = events.find((event) => event.stage === 'result')!
        expect(result.tokensIn).toBe(100)
        expect(result.cacheReadTokens).toBe(scenario === 'missing-cache' ? undefined : 300)
        expect(result.costUsd).toBeUndefined()
        const credits = events.filter((event) => event.stage === 'credit_usage')
        expect(credits).toHaveLength(1)
        expect(credits[0].creditUsage).toMatchObject({ source: ['pi_qoder_credit_observation'],
          status: scenario === 'missing-credit' ? 'unavailable' : 'partial',
          value: { knownRequests: scenario === 'missing-credit' ? 0 : 2, missingRequests: scenario === 'missing-credit' ? 2 : 0 } })
        expect(credits[0].creditUsage!.value!.amount).toBe(scenario === 'missing-credit' ? undefined : 5)
        const evidence = aggregateTurnEvidence({ userText: 'metering', events, source: 'scry_provider_adapter' })
        expect(evidence.usage.value?.credits).toEqual(credits[0].creditUsage)
        expect(evidence.usage.value?.inputTokens).toBe(100)
        await adapter.dispose?.()
      })
    }, 15_000)

  it('resuming resets cumulative counters and never bills the previous turn again', async () => {
    await withProbeFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      for (let turn = 0; turn < 2; turn++) {
        const events: TraceEvent[] = []
        await adapter.run({ runId: `run-${turn}`, prompt: 'usage:completed', cwd, agentProfileId: profile.id,
          ...(turn ? { resume: 'fixture-session' } : {}), attachments: [], permissionMode: 'full_access', emit: event => events.push(event) }).promise
        expect(events.filter(event => event.stage === 'usage_snapshot').map(event => event.cacheReadTokens)).toEqual([100, 300])
        expect(events.find(event => event.stage === 'credit_usage')!.creditUsage!.value!.amount).toBe(5)
      }
      await adapter.dispose?.()
    })
  }, 15_000)
})
