import { describe, expect, it } from 'vitest'
import { capabilityReady, capabilityUnavailable } from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import { remoteProviderEntry } from './remote-provider-snapshot'

const pi = { id: 'pi', label: 'Pi' }
const rotom = { id: 'pi:rotom', label: 'Rotom' }
const context = { providerId: 'pi' as const, agentProfileId: 'pi:rotom' }
const fullAccessOnly: AgentRunControlCatalog = {
  models: [],
  permissions: [{ id: 'full_access', label: '本机完全访问', description: 'Pi 没有内置沙箱' }]
}

describe('remoteProviderEntry', () => {
  it('does not repeat the Provider name when the profile label already includes it', () => {
    const ready = capabilityReady(context, 'read', fullAccessOnly)
    const label = (profileLabel: string) =>
      remoteProviderEntry({ descriptor: pi, profile: { id: 'pi:rotom', label: profileLabel }, controls: ready, previous: [] }).label
    expect(label('Pi · Rotom')).toBe('Pi · Rotom')
    expect(label('pi rotom')).toBe('pi rotom')
    expect(label('Rotom')).toBe('Pi · Rotom')
    // A name that merely starts with the same letters is not the Provider prefix.
    expect(label('Pipeline')).toBe('Pi · Pipeline')
  })

  it('never publishes a failed control probe as an available entry without permissions', () => {
    // The phone treats a missing permission list as "Provider default", so this
    // shape made it submit Pi with `default`, which Pi rejects at run start.
    const failed = capabilityUnavailable<AgentRunControlCatalog>(context, 'unknown', 'probe timed out')
    expect(remoteProviderEntry({ descriptor: pi, profile: rotom, controls: failed, previous: [] }))
      .toEqual({ id: 'pi', label: 'Pi · Rotom', available: false, agentProfileId: 'pi:rotom' })
  })

  it('keeps the last good entry of the same context when a later probe fails', () => {
    const good = remoteProviderEntry({ descriptor: pi, profile: rotom, controls: capabilityReady(context, 'read', fullAccessOnly), previous: [] })
    expect(good.permissions?.map((option) => option.id)).toEqual(['full_access'])
    const otherProfile = { ...good, agentProfileId: 'pi:other' }
    const failed = capabilityUnavailable<AgentRunControlCatalog>(context, 'unknown', 'probe timed out')
    expect(remoteProviderEntry({ descriptor: pi, profile: rotom, controls: failed, previous: [otherProfile, good] })).toBe(good)
  })

  it('still publishes a Provider without a run-control API as available with its native default', () => {
    const unsupported = capabilityUnavailable<AgentRunControlCatalog>({ providerId: 'claude' }, 'unsupported', 'no controls')
    expect(remoteProviderEntry({ descriptor: { id: 'claude', label: 'Claude' }, controls: unsupported, previous: [] }))
      .toEqual({ id: 'claude', label: 'Claude', available: true })
  })
})
