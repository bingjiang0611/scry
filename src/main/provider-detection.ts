import { basename } from 'node:path'
import { unavailableProviderDescriptor, type ProviderDescriptor, type ProviderHealth } from '../shared/provider'
import { providerIdForAgentId } from '../shared/runtime'
import type { DetectedAgent } from './claude-locate'
import type { PiAgentProfile } from './pi-agent-profiles'

export type ProviderDetectionResult = DetectedAgent & {
  agentProfileId?: string
  runtimeProvider?: ProviderDescriptor['runtimeProvider']
  transport?: string
  capabilities?: ProviderDescriptor['capabilities']
  health?: ProviderHealth
  /** Provider 已装但不可用时的原因，与 descriptor 语义一致。 */
  unavailableReason?: string
  compatibility?: ProviderDescriptor['compatibility']
}

interface VersionProbeResult {
  version?: string
  health: ProviderHealth
}

export interface CachedAsyncLoader<T> {
  load(): Promise<T>
  invalidate(): void
}

/**
 * Shares one in-flight discovery and briefly reuses its last successful result.
 * Failures are never cached, so a transient CLI/probe error can be retried immediately.
 */
export function createCachedAsyncLoader<T>(
  loader: () => Promise<T>,
  options: { ttlMs: number; now?: () => number }
): CachedAsyncLoader<T> {
  const now = options.now ?? Date.now
  const ttlMs = Math.max(0, options.ttlMs)
  let cached: { value: T; observedAt: number } | undefined
  let pending: Promise<T> | undefined

  return {
    load(): Promise<T> {
      if (cached && now() - cached.observedAt < ttlMs) return Promise.resolve(cached.value)
      if (pending) return pending
      const request = Promise.resolve()
        .then(loader)
        .then((value) => {
          cached = { value, observedAt: now() }
          return value
        })
        .finally(() => {
          if (pending === request) pending = undefined
        })
      pending = request
      return request
    },
    invalidate(): void {
      cached = undefined
    }
  }
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
    if (!providerId) return []
    if (!descriptor) {
      // 本机确实装了这个 Agent，却没有对应的 Provider adapter（构建裁剪、注册失败等）。
      // 从列表里静默丢掉它等于告诉用户「没装」，所以改成带原因的影子快照。
      const shadow = unavailableProviderDescriptor({
        id: providerId,
        label: agent.name,
        path: agent.path,
        ...(agent.version ? { version: agent.version } : {}),
        reason: `本构建未注册 ${providerId} Provider adapter`
      })
      return [{
        id: agent.id,
        name: shadow.label,
        bin: agent.bin,
        path: agent.path,
        ...(agent.version ? { version: agent.version } : {}),
        runtimeProvider: shadow.runtimeProvider,
        transport: shadow.transport,
        capabilities: shadow.capabilities,
        health: shadow.health!,
        unavailableReason: shadow.unavailableReason!
      }]
    }
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
      ...(descriptor.unavailableReason ? { unavailableReason: descriptor.unavailableReason } : {}),
      ...(descriptor.compatibility ? { compatibility: descriptor.compatibility } : {}),
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
      ...(descriptor.unavailableReason ? { unavailableReason: descriptor.unavailableReason } : {}),
      ...(descriptor.compatibility ? { compatibility: descriptor.compatibility } : {}),
      agentProfileId: profile.id
    })
  }
  return agents
}
