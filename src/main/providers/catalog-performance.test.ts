import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPerformanceRecordingSink, type PerformanceSample } from '../performance-timing'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { createPiAdapter } from './pi'
import { disposePiCatalog } from './pi-catalog'
import { withProbeFixture } from './pi-rpc.fixture'
import { ProviderRegistry } from './registry'

const samples: PerformanceSample[] = []
// A started probe reports its own spawn and exit; a reused probe process reports only the reads it
// performed on an already-running child, so no spawn/exit stage belongs to that later operation.
const coldProbeStages = ['environment_ready', 'spawned', 'first_response', 'responses_received']
const reusedProbeStages = ['environment_ready', 'first_response', 'responses_received']

function record(): void {
  samples.length = 0
  vi.stubEnv('SCRY_PERF_LOG', '')
  setPerformanceRecordingSink(sample => samples.push(sample))
}

function assertPrivate(values: string[]): void {
  const encoded = JSON.stringify(samples)
  for (const value of values) expect(encoded).not.toContain(value)
  for (const sample of samples) {
    expect(sample.dimensions).toEqual({ provider: 'pi' })
    for (const point of sample.checkpoints) {
      expect(point.deltaMs).toBeGreaterThanOrEqual(0)
      expect(Object.values(point.counters ?? {}).every(Number.isFinite)).toBe(true)
    }
  }
}

afterEach(() => {
  setPerformanceRecordingSink(null)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('content-free catalog performance', () => {
  it('attributes three reads, isolates profile time, and measures only one shared cold process through exit', async () => {
    record()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    await withProbeFixture(async (profile, cwd, starts) => {
      let resolve!: (profile: PiAgentProfile) => void
      const pending = new Promise<PiAgentProfile>(done => { resolve = done })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: () => pending })
      const registry = new ProviderRegistry([adapter])
      const context = { providerId: 'pi' as const, agentProfileId: profile.id, cwd }
      const result = Promise.all([registry.listCommands(context), registry.runControls(context), registry.listSkills(context)])
      expect(starts()).toHaveLength(0)
      clock = 40
      resolve(profile)
      expect((await result).map(r => r.state)).toEqual(['ready', 'ready', 'ready'])
      expect(starts()).toHaveLength(1)
      expect(samples.filter(s => s.name.startsWith('provider.catalog.')).map(s => s.name).sort()).toEqual([
        'provider.catalog.commands', 'provider.catalog.run_controls', 'provider.catalog.skills'
      ])
      const reads = samples.filter(s => s.name === 'pi.catalog.read')
      expect(reads).toHaveLength(3)
      for (const read of reads) {
        expect(read.checkpoints.map(p => p.stage)).toEqual(['profile_resolved', 'probe_settled'])
        expect(read.checkpoints[0].deltaMs).toBe(40)
      }
      const probes = samples.filter(s => s.name === 'pi.catalog.probe')
      expect(probes).toHaveLength(1)
      expect(probes[0].checkpoints.map(p => p.stage)).toEqual(coldProbeStages)
      expect(probes[0].checkpoints.find(p => p.stage === 'responses_received')?.counters).toEqual({ rpcResponses: 4 })
      expect(samples.every(s => s.outcome === 'completed')).toBe(true)
      const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).not.toThrow()
      assertPrivate([profile.id, profile.executable, cwd, 'fixture-menu'])
      // The parked process answers the next catalog read without a second spawn.
      await registry.listCommands(context)
      expect(starts()).toHaveLength(1)
      expect(samples.filter(s => s.name === 'pi.catalog.probe')).toHaveLength(2)
      expect(samples.filter(s => s.name === 'pi.catalog.probe')[1].checkpoints.map(p => p.stage)).toEqual(reusedProbeStages)
      await adapter.dispose?.()
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
    })
  })

  it('records failed profile resolution without publishing its error or inventing a process stage', async () => {
    record()
    await withProbeFixture(async (profile, cwd, starts) => {
      const secret = 'private-profile-error-secret'
      const registry = new ProviderRegistry([createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => { throw new Error(secret) } })])
      const result = await registry.listCommands({ providerId: 'pi', agentProfileId: profile.id, cwd })
      expect(result.state).toBe('unknown')
      expect(result.reason).toContain(secret)
      expect(starts()).toHaveLength(0)
      expect(samples.map(s => [s.name, s.outcome])).toEqual([
        ['pi.catalog.read', 'error'], ['provider.catalog.commands', 'unavailable']
      ])
      expect(samples.flatMap(s => s.checkpoints)).toEqual([])
      assertPrivate([secret, profile.id, profile.executable, cwd])
    })
  })

  it('observes real RPC error responses and a bounded exit while keeping unavailable capability semantics', async () => {
    record()
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'fail-probe'), '')
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const registry = new ProviderRegistry([adapter])
      expect((await registry.runControls({ providerId: 'pi', agentProfileId: profile.id, cwd })).state).toBe('unknown')
      const probe = samples.find(s => s.name === 'pi.catalog.probe')!
      expect(probe.outcome).toBe('error')
      expect(probe.checkpoints.map(p => p.stage)).toContain('first_response')
      expect(probe.checkpoints.map(p => p.stage)).toEqual(['environment_ready', 'spawned', 'first_response'])
      expect(samples.find(s => s.name === 'provider.catalog.run_controls')?.outcome).toBe('unavailable')
      const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
      await disposePiCatalog()
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
      assertPrivate(['fixture probe failed', profile.id, profile.executable, cwd])
    })
  })

  it('tags disabled Providers and sanitizes malformed identity without logging context or thrown errors', async () => {
    record()
    const registry = new ProviderRegistry([], { disabledProviders: new Set(['codex']) })
    expect((await registry.listCommands({ providerId: 'codex', cwd: 'private-workspace-secret' })).state).toBe('unsupported')
    expect(samples[0]).toMatchObject({ name: 'provider.catalog.commands', dimensions: { provider: 'codex' }, outcome: 'unavailable' })
    expect(() => registry.listCommands({ providerId: 'private-provider-secret' as 'pi', cwd: 'private-workspace-secret' })).toThrow('provider adapter not registered')
    expect(samples[1]).toMatchObject({ dimensions: { provider: 'unknown' }, outcome: 'error' })
    expect(JSON.stringify(samples)).not.toMatch(/private-provider-secret|private-workspace-secret|not registered/)
  })

  it('keeps discovery functional without a recording sink', async () => {
    record()
    setPerformanceRecordingSink(null)
    await withProbeFixture(async (profile, cwd, starts) => {
      const registry = new ProviderRegistry([createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })])
      expect((await registry.listCommands({ providerId: 'pi', agentProfileId: profile.id, cwd })).state).toBe('ready')
      expect(starts()).toHaveLength(1)
      expect(samples).toEqual([])
    })
  })

  it('does not fabricate response timing when the process exits before any response', async () => {
    record()
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(profile.executable, '#!/usr/bin/env node\nprocess.stderr.write("private-startup-secret"); process.exit(7)\n')
      const registry = new ProviderRegistry([createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })])
      expect((await registry.listSkills({ providerId: 'pi', agentProfileId: profile.id, cwd })).state).toBe('unknown')
      const probe = samples.find(s => s.name === 'pi.catalog.probe')!
      expect(probe.outcome).toBe('error')
      expect(probe.checkpoints.map(p => p.stage)).toEqual(['environment_ready', 'spawned', 'closed'])
      assertPrivate(['private-startup-secret', profile.id, profile.executable, cwd])
    })
  })
})
