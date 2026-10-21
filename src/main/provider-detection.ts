import { basename } from 'node:path'
import { unavailableProviderDescriptor, type ProviderDescriptor, type ProviderHealth, type ProviderId } from '../shared/provider'
import type { ProviderCompatibilityAdvisory } from '../shared/provider-compatibility'
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
  let revision = 0
  let pending: { revision: number; request: Promise<T> } | undefined

  const load = (): Promise<T> => {
    if (cached && now() - cached.observedAt < ttlMs) return Promise.resolve(cached.value)
    if (pending) {
      // A caller explicitly requesting a new generation must not receive or
      // cache the superseded read, even when that older read fails.
      return pending.revision === revision ? pending.request : pending.request.then(load, load)
    }
    const startedRevision = revision
    const request = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (revision === startedRevision) cached = { value, observedAt: now() }
        return value
      })
      .finally(() => {
        if (pending?.request === request) pending = undefined
      })
    pending = { revision: startedRevision, request }
    return request
  }

  return {
    load,
    invalidate(): void {
      revision += 1
      cached = undefined
    }
  }
}

interface ComposeProviderDetectionOptions {
  detected: DetectedAgent[]
  descriptors: ProviderDescriptor[]
  storedPiProfiles: PiAgentProfile[]
  probeStoredPiProfile: (profile: PiAgentProfile) => Promise<VersionProbeResult>
  /**
   * 版本兼容性判定器。descriptor 上的 advisory 来自 adapter 自己知道的版本，而本机真实
   * 版本往往只有 CLI 定位/探测这一步才有，所以这里用最终生效的版本重算一次；缺少判定器
   * 时沿用 descriptor 的结论，不编造。
   */
  compatibility?: (providerId: ProviderId, version: string | undefined) => ProviderCompatibilityAdvisory
}

export async function composeProviderDetectionResults({
  detected,
  descriptors,
  storedPiProfiles,
  probeStoredPiProfile,
  compatibility
}: ComposeProviderDetectionOptions): Promise<ProviderDetectionResult[]> {
  const descriptorByProvider = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]))
  const advisoryFor = (
    providerId: ProviderId,
    version: string | undefined,
    descriptor: ProviderDescriptor | undefined
  ): ProviderCompatibilityAdvisory | undefined => {
    if (!compatibility) return descriptor?.compatibility
    if (version === undefined) return descriptor?.compatibility
    return compatibility(providerId, version)
  }
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
        unavailableReason: shadow.unavailableReason!,
        ...((): { compatibility?: ProviderCompatibilityAdvisory } => {
          const advisory = advisoryFor(providerId, agent.version, undefined)
          return advisory ? { compatibility: advisory } : {}
        })()
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
      ...((): { compatibility?: ProviderCompatibilityAdvisory } => {
        const advisory = advisoryFor(providerId, agent.version ?? descriptor.version, descriptor)
        return advisory ? { compatibility: advisory } : {}
      })(),
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
      ...((): { compatibility?: ProviderCompatibilityAdvisory } => {
        const advisory = advisoryFor('pi', versionProbe.version ?? descriptor.version, descriptor)
        return advisory ? { compatibility: advisory } : {}
      })(),
      agentProfileId: profile.id
    })
  }
  return agents
}
