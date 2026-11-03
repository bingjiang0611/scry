import type { RemoteCommandCatalog, RemoteProviderRef } from '../../shared/desktop-remote'
import type { RemoteCommandQuery, RemoteCommandSource, RemoteProviderSource } from './remote-gateway-types'
import { RemoteGatewayError } from './remote-gateway-types'
import type { RemoteProviderQuery } from '../../shared/desktop-remote'
import { MAX_PATH, commandCatalog, providerList, providerRef, providerRefs } from './remote-gateway-sanitizers'

export interface RemoteGatewayCatalogContext {
  authorize(peerCertSHA256: string): void
  providers?: RemoteProviderSource
  commands?: RemoteCommandSource
}

// Capability reads are the slowest user-visible remote path (Pi catalog p50 1888 ms,
// Provider controls 1304 ms) and several clients ask for the same context at once:
// the sidebar refresh, the composer and a second device all land on one selection.
// Sharing only the request that is still in flight removes that duplicate work
// without ever answering a later refresh from a settled result - a read that
// arrives after settlement starts its own Provider query.
//
// The map is keyed by the source object, so two hosts in one process (tests, a
// second profile) never share a capability read, and entries are deleted as soon
// as the request settles.
const providerControlsInFlight = new WeakMap<object, Map<string, Promise<RemoteProviderRef>>>()
const commandsInFlight = new WeakMap<object, Map<string, Promise<RemoteCommandCatalog>>>()

function singleFlight<T>(store: WeakMap<object, Map<string, Promise<T>>>, owner: object, key: string, read: () => Promise<T>): Promise<T> {
  const pending = store.get(owner)
  const existing = pending?.get(key)
  if (existing) return existing
  const map = pending ?? new Map<string, Promise<T>>()
  store.set(owner, map)
  // Every caller authorizes before it reaches this function; the shared read only
  // removes duplicate Provider work, never an authorization check.
  const created = read().finally(() => { map.delete(key) })
  map.set(key, created)
  return created
}

function contextKey(parts: ReadonlyArray<string | undefined>): string {
  return parts.map(part => part ?? '').join('\u0000')
}

export function listProviders(context: RemoteGatewayCatalogContext, peerCertSHA256: string): RemoteProviderRef[] {
  context.authorize(peerCertSHA256)
  return providerList(context.providers?.list?.() ?? [])
}

export async function listProviderControls(context: RemoteGatewayCatalogContext, peerCertSHA256: string, query: Extract<RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef> {
  context.authorize(peerCertSHA256)
  if (!query || query.detail !== 'selected' || typeof query.providerId !== 'string' || query.providerId.length === 0 || query.providerId.length > 64 ||
      typeof query.cwd !== 'string' || query.cwd.length === 0 || query.cwd.length > MAX_PATH ||
      (query.agentProfileId !== undefined && (typeof query.agentProfileId !== 'string' || query.agentProfileId.length === 0 || query.agentProfileId.length > 128))) {
    throw new RemoteGatewayError('invalid_provider_context')
  }
  if (!context.providers?.selected) throw new RemoteGatewayError('provider_controls_unavailable')
  const listed = context.providers.list?.() ?? []
  const selected = listed.find((entry) => entry.id === query.providerId && (entry.agentProfileId ?? '') === (query.agentProfileId ?? ''))
  if (!selected || selected.available !== true) throw new RemoteGatewayError('provider_not_authorized')
  const providers = context.providers
  return singleFlight(providerControlsInFlight, providers, contextKey([query.providerId, query.agentProfileId, query.cwd]), () => providers.selected!(query).then(providerRef))
}

export async function listProvidersFull(context: RemoteGatewayCatalogContext, peerCertSHA256: string): Promise<RemoteProviderRef[]> {
  context.authorize(peerCertSHA256)
  const raw = context.providers?.listFull ? await context.providers.listFull() : context.providers?.list?.() ?? []
  return providerRefs(raw)
}

export async function listCommands(context: RemoteGatewayCatalogContext, peerCertSHA256: string, query: RemoteCommandQuery): Promise<RemoteCommandCatalog> {
  context.authorize(peerCertSHA256)
  if (!query || typeof query.providerId !== 'string' || query.providerId.length === 0 || query.providerId.length > 64 ||
      typeof query.cwd !== 'string' || query.cwd.length === 0 || query.cwd.length > MAX_PATH) {
    return { commands: [], reason: 'invalid_context' }
  }
  if (!context.commands) return { commands: [], reason: 'unsupported' }
  const commands = context.commands
  const agentProfileId = typeof query.agentProfileId === 'string' && query.agentProfileId.length <= 128 ? query.agentProfileId : undefined
  return singleFlight(commandsInFlight, commands, contextKey([query.providerId, agentProfileId, query.cwd]), () => commands
    .list({ providerId: query.providerId, cwd: query.cwd, ...(agentProfileId ? { agentProfileId } : {}) })
    .then(commandCatalog))
}
