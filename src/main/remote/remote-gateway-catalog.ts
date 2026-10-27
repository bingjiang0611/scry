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
  return providerRef(await context.providers.selected(query))
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
  const raw = await context.commands.list({
    providerId: query.providerId,
    cwd: query.cwd,
    ...(typeof query.agentProfileId === 'string' && query.agentProfileId.length <= 128 ? { agentProfileId: query.agentProfileId } : {})
  })
  return commandCatalog(raw)
}
