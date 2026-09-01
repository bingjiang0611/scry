import { basename } from 'node:path'
import type { ProviderDescriptor, ProviderHealth } from '../shared/provider'
import { providerIdForAgentId } from '../shared/runtime'
import type { DetectedAgent } from './claude-locate'
import type { PiAgentProfile } from './pi-agent-profiles'

export type ProviderDetectionResult = DetectedAgent & {
  agentProfileId?: string
  runtimeProvider?: ProviderDescriptor['runtimeProvider']
  transport?: string
  capabilities?: ProviderDescriptor['capabilities']
  health?: ProviderHealth
}

interface VersionProbeResult {
  version?: string
  health: ProviderHealth
}

interface ComposeProviderDetectionOptions {
  detected: DetectedAgent[]
  descriptors: ProviderDescriptor[]
  storedPiProfiles: PiAgentProfile[]
  probeStoredPiProfile: (profile: PiAgentProfile) => Promise<VersionProbeResult>
}

export async function composeProviderDetectionResults({
  detected,
  descriptors,
  storedPiProfiles,
  probeStoredPiProfile
}: ComposeProviderDetectionOptions): Promise<ProviderDetectionResult[]> {
  const descriptorByProvider = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]))
  const agents = detected.flatMap((agent): ProviderDetectionResult[] => {
    const providerId = providerIdForAgentId(agent.id)
    const descriptor = providerId ? descriptorByProvider.get(providerId) : undefined
    if (!descriptor) return []
    return [{
      id: agent.id,
      name: providerId === 'pi' ? agent.name : descriptor.label,
      bin: agent.bin,
      path: agent.path,
      version: agent.version ?? descriptor.version,
      runtimeProvider: descriptor.runtimeProvider,
      transport: descriptor.transport,
      capabilities: descriptor.capabilities,
      health: agent.health?.state === 'unavailable'
        ? {
            ...descriptor.health,
            ...agent.health,
            transport: descriptor.transport
          }
        : descriptor.health ?? agent.health,
      ...(providerId === 'pi' ? { agentProfileId: agent.id } : {})
    }]
  })
  const found = new Set(agents.map((agent) => agent.id))
  for (const profile of storedPiProfiles) {
    if (found.has(profile.id)) continue
    const versionProbe = await probeStoredPiProfile(profile)
    const descriptor = descriptorByProvider.get('pi')
    if (!descriptor) continue
    agents.push({
      id: profile.id,
      name: profile.label,
      bin: basename(profile.executable),
      path: profile.executable,
      version: versionProbe.version ?? descriptor.version,
      runtimeProvider: descriptor.runtimeProvider,
      transport: descriptor.transport,
      capabilities: descriptor.capabilities,
      health: versionProbe.health.state === 'unavailable'
        ? { ...descriptor.health, ...versionProbe.health, transport: descriptor.transport }
        : descriptor.health ?? versionProbe.health,
      agentProfileId: profile.id
    })
  }
  return agents
}
