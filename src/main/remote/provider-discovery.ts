import type { CapabilityEnvelope, ProviderContext, ProviderDescriptor, ProviderId } from '../../shared/provider'
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
  supportsForkSession?: (providerId: ProviderId) => boolean
  onError: (error: unknown) => void
  now?: () => number
}) {
  const now = options.now ?? Date.now
  let metadata: RemoteProviderRef[] = []
  let metadataRevision = 0
  let metadataInvalidation = 0
  const contextRevisions = new Map<ProviderId, number>()
  const pending = new Map<string, { revision: number; request: Promise<RemoteProviderRef> }>()
  const forkSession = (providerId: ProviderId): boolean => options.supportsForkSession?.(providerId) === true

  const contexts = async () => {
    const descriptors = await options.descriptors()
    const profiles = descriptors.some((descriptor) => descriptor.id === 'pi' && descriptor.available)
      ? await options.profiles() : []
    return descriptors.flatMap<{ descriptor: ProviderDescriptor; profile?: PiAgentProfile }>((descriptor) => descriptor.id === 'pi' && descriptor.available && profiles.length
      ? profiles.map((profile) => ({ descriptor, profile }))
      : [{ descriptor, profile: undefined }])
  }

  const refreshMetadata = async (): Promise<void> => {
    const startedInvalidation = metadataInvalidation
    try {
      const entries = await contexts()
      if (startedInvalidation !== metadataInvalidation) return
      const observedAt = now()
      metadataRevision += 1
      metadata = entries.map((context) => ({ ...remoteProviderMetadata({ ...context, forkSession: forkSession(context.descriptor.id) }), observedAt, metadataRevision }))
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
    const key = JSON.stringify([descriptor.id, profile?.id, profile?.executable, cwd, permissionOverride])
    const revision = contextRevisions.get(descriptor.id) ?? 0
    const existing = pending.get(key)
    if (existing) {
      if (existing.revision === revision) return existing.request
      // Let the adapter finish and remove its own in-flight entry before a fresh
      // read. Revalidate profile and workspace authority after this await.
      await existing.request
      return selected(query)
    }
    const request = Promise.resolve().then(async () => {
      try {
        const controls = await options.controls({ providerId: descriptor.id, cwd, ...(profile ? { agentProfileId: profile.id } : {}) })
        if ((contextRevisions.get(descriptor.id) ?? 0) !== revision) {
          return { ...remoteProviderMetadata({ descriptor, ...(profile ? { profile } : {}), forkSession: forkSession(descriptor.id) }), available: false, observedAt: now() }
        }
        return { ...remoteProviderEntry({ descriptor, ...(profile ? { profile } : {}), controls, previous: [], permissionOverride, forkSession: forkSession(descriptor.id) }), observedAt: now() }
      } catch (error) {
        options.onError(error)
        return { ...remoteProviderMetadata({ descriptor, ...(profile ? { profile } : {}), forkSession: forkSession(descriptor.id) }), available: false, observedAt: now() }
      }
    }).finally(() => { if (pending.get(key)?.request === request) pending.delete(key) })
    pending.set(key, { revision, request })
    return request
  }

  // Older clients explicitly request the full snapshot. Preserve their existing 60s
  // reuse, but never start this work from a timer or the metadata path.
  const legacy = createCachedAsyncLoader(async () => {
    const cwd = options.defaultWorkspace()
    const entries = await contexts()
    return Promise.all(entries.map(async ({ descriptor, profile }) => {
      if (!descriptor.available || !cwd) return remoteProviderMetadata({ descriptor, ...(profile ? { profile } : {}), forkSession: forkSession(descriptor.id) })
      return selected({ detail: 'selected', providerId: descriptor.id, cwd, ...(profile ? { agentProfileId: profile.id } : {}) })
    }))
  }, { ttlMs: 60_000, now: options.now })

  return {
    metadata: () => metadata,
    refreshMetadata,
    selected,
    invalidate: (providerId: ProviderId) => {
      metadataInvalidation += 1
      contextRevisions.set(providerId, (contextRevisions.get(providerId) ?? 0) + 1)
      legacy.invalidate()
    },
    legacy: () => legacy.load()
  }
}
