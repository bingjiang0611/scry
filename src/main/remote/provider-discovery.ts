import type { CapabilityEnvelope, ProviderContext, ProviderDescriptor } from '../../shared/provider'
import type { AgentPermissionMode, AgentRunControlCatalog } from '../../shared/runtime'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { createCachedAsyncLoader } from '../provider-detection'
import type { RemoteProviderQuery, RemoteProviderRef } from './remote-gateway'
import { remoteProviderEntry, remoteProviderMetadata } from './remote-provider-snapshot'

type SelectedQuery = Extract<RemoteProviderQuery, { detail: 'selected' }>

/** Metadata is display-only. Only an authorized selected context may initialize a runtime. */
export function createProviderDiscovery(options: {
  descriptors: () => Promise<ProviderDescriptor[]>
  profiles: () => Promise<PiAgentProfile[]>
  resolveProfile: (id: string) => Promise<PiAgentProfile | undefined>
  authorizeWorkspace: (cwd: string) => string
  controls: (context: ProviderContext) => Promise<CapabilityEnvelope<AgentRunControlCatalog>>
  defaultWorkspace: () => string | undefined
  permissionOverride: () => AgentPermissionMode | undefined
  onError: (error: unknown) => void
  now?: () => number
}) {
  let metadata: RemoteProviderRef[] = []
  const pending = new Map<string, Promise<RemoteProviderRef>>()

  const contexts = async () => {
    const descriptors = await options.descriptors()
    const profiles = descriptors.some((descriptor) => descriptor.id === 'pi' && descriptor.available)
      ? await options.profiles() : []
    return descriptors.flatMap<{ descriptor: ProviderDescriptor; profile?: PiAgentProfile }>((descriptor) => descriptor.id === 'pi' && descriptor.available && profiles.length
      ? profiles.map((profile) => ({ descriptor, profile }))
      : [{ descriptor, profile: undefined }])
  }

  const refreshMetadata = async (): Promise<void> => {
    try {
      metadata = (await contexts()).map((context) => remoteProviderMetadata(context))
    } catch (error) {
      // Metadata is an observational snapshot, not execution authority. Retain its
      // last value while a selected request still performs fresh validation.
      options.onError(error)
    }
  }

  const selected = async (query: SelectedQuery): Promise<RemoteProviderRef> => {
    // Revalidate authorization even when another request already owns this runtime read.
    const cwd = options.authorizeWorkspace(query.cwd)
    const descriptor = (await options.descriptors()).find((entry) => entry.id === query.providerId && entry.available)
    if (!descriptor) throw new Error('invalid_provider_context')
    const profile = descriptor.id === 'pi' && query.agentProfileId ? await options.resolveProfile(query.agentProfileId) : undefined
    if ((descriptor.id === 'pi' && (!profile || profile.id !== query.agentProfileId)) ||
        (descriptor.id !== 'pi' && query.agentProfileId !== undefined)) throw new Error('invalid_provider_context')
    const permissionOverride = options.permissionOverride()
    const key = JSON.stringify([descriptor.id, profile, cwd, permissionOverride])
    const existing = pending.get(key)
    if (existing) return existing
    const request = Promise.resolve().then(async () => {
      try {
        const controls = await options.controls({ providerId: descriptor.id, cwd, ...(profile ? { agentProfileId: profile.id } : {}) })
        return remoteProviderEntry({ descriptor, ...(profile ? { profile } : {}), controls, previous: [], permissionOverride })
      } catch (error) {
        options.onError(error)
        return { ...remoteProviderMetadata({ descriptor, ...(profile ? { profile } : {}) }), available: false }
      }
    }).finally(() => { if (pending.get(key) === request) pending.delete(key) })
    pending.set(key, request)
    return request
  }

  // Older clients explicitly request the full snapshot. Preserve their existing 60s
  // reuse, but never start this work from a timer or the metadata path.
  const legacy = createCachedAsyncLoader(async () => {
    const cwd = options.defaultWorkspace()
    const entries = await contexts()
    return Promise.all(entries.map(async ({ descriptor, profile }) => {
      if (!descriptor.available || !cwd) return remoteProviderMetadata({ descriptor, ...(profile ? { profile } : {}) })
      return selected({ detail: 'selected', providerId: descriptor.id, cwd, ...(profile ? { agentProfileId: profile.id } : {}) })
    }))
  }, { ttlMs: 60_000, now: options.now })

  return {
    metadata: () => metadata,
    refreshMetadata,
    selected,
    legacy: () => legacy.load()
  }
}
