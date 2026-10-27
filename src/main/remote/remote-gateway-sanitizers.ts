import { isRemoteProviderObservationTime, isRemoteSessionOutcome } from '../../shared/desktop-remote'
import type { RemoteCommandCatalog, RemoteCommandRef, RemoteControlOption, RemoteModelOption, RemoteProjectRef, RemoteProviderRef, RemoteSessionRef } from '../../shared/desktop-remote'
import { RemoteGatewayError } from './remote-gateway-types'

export const MAX_PROJECTS = 200
export const MAX_PATH = 4_096
export const MAX_PROVIDERS = 32
export const MAX_COMMANDS = 256
export const MAX_SESSIONS = 300
export const MAX_CATALOG_PAGE = 100
export const MAX_CATALOG_ITEMS = 100_000

export function projectRefs(raw: RemoteProjectRef[], limit = MAX_PROJECTS): RemoteProjectRef[] {
  const seen = new Set<string>()
  const out: RemoteProjectRef[] = []
  for (const entry of raw) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.label !== 'string') continue
    if (entry.path.length === 0 || entry.path.length > MAX_PATH || seen.has(entry.path)) continue
    seen.add(entry.path)
    out.push({ path: entry.path, label: entry.label.slice(0, 256) })
    if (out.length >= limit) break
  }
  return out
}

export function controlOptions(value: unknown): RemoteControlOption[] {
  if (!Array.isArray(value)) return []
  const out: RemoteControlOption[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const option = raw as Record<string, unknown>
    if (typeof option.id !== 'string' || option.id.length === 0 || option.id.length > 64 || seen.has(option.id)) continue
    if (typeof option.label !== 'string' || option.label.length === 0) continue
    seen.add(option.id)
    out.push({
      id: option.id,
      label: option.label.slice(0, 64),
      ...(typeof option.description === 'string' ? { description: option.description.slice(0, 256) } : {}),
      ...(option.isDefault === true ? { isDefault: true } : {})
    })
    if (out.length >= 16) break
  }
  return out
}

export function modelOptions(value: unknown): RemoteModelOption[] {
  if (!Array.isArray(value)) return []
  const out: RemoteModelOption[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const option = raw as Record<string, unknown>
    if (typeof option.id !== 'string' || option.id.length === 0 || option.id.length > 128) continue
    if (typeof option.label !== 'string' || option.label.length === 0) continue
    const providerId = typeof option.providerId === 'string' && option.providerId.length > 0 && option.providerId.length <= 128
      ? option.providerId : undefined
    const modelKey = `${providerId ?? ''}\0${option.id}`
    if (seen.has(modelKey)) continue
    seen.add(modelKey)
    const efforts = controlOptions(option.efforts)
    out.push({
      id: option.id,
      ...(providerId ? { providerId } : {}),
      label: option.label.slice(0, 128),
      ...(typeof option.description === 'string' ? { description: option.description.slice(0, 256) } : {}),
      ...(option.isDefault === true ? { isDefault: true } : {}),
      ...(efforts.length > 0 ? { efforts } : {})
    })
    if (out.length >= 128) break
  }
  return out
}

export function providerRefs(raw: RemoteProviderRef[]): RemoteProviderRef[] {
  const seen = new Set<string>()
  const out: RemoteProviderRef[] = []
  for (const entry of raw) {
    const ref = providerRef(entry)
    const contextKey = `${ref.id}\0${ref.agentProfileId ?? ''}`
    if (seen.has(contextKey)) continue
    seen.add(contextKey)
    out.push(ref)
    if (out.length >= MAX_PROVIDERS) break
  }
  return out
}

export function providerRef(entry: RemoteProviderRef): RemoteProviderRef {
  if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string') throw new RemoteGatewayError('invalid_provider_response')
  if (entry.id.length === 0 || entry.id.length > 64) throw new RemoteGatewayError('invalid_provider_response')
  const agentProfileId = typeof entry.agentProfileId === 'string' && entry.agentProfileId.length > 0 && entry.agentProfileId.length <= 128 ? entry.agentProfileId : undefined
  const models = modelOptions(entry.models)
  const efforts = controlOptions(entry.efforts)
  const permissions = controlOptions(entry.permissions)
  return {
    id: entry.id,
    label: entry.label.slice(0, 128),
    available: entry.available === true,
    ...(agentProfileId ? { agentProfileId } : {}),
    ...(entry.forkSession === true ? { forkSession: true as const } : {}),
    ...(typeof entry.modelId === 'string' && entry.modelId.length > 0 && entry.modelId.length <= 128 ? { modelId: entry.modelId } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(permissions.length > 0 ? { permissions } : {}),
    ...(isRemoteProviderObservationTime(entry.observedAt) ? { observedAt: entry.observedAt } : {}),
    ...(typeof entry.metadataRevision === 'number' && Number.isSafeInteger(entry.metadataRevision) && entry.metadataRevision >= 0 ? { metadataRevision: entry.metadataRevision } : {})
  }
}

export function providerList(raw: RemoteProviderRef[]): RemoteProviderRef[] {
  const seen = new Set<string>()
  const out: RemoteProviderRef[] = []
  for (const entry of raw) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string') continue
    if (entry.id.length === 0 || entry.id.length > 64) continue
    const agentProfileId = typeof entry.agentProfileId === 'string' && entry.agentProfileId.length > 0 && entry.agentProfileId.length <= 128
      ? entry.agentProfileId : undefined
    const contextKey = `${entry.id}\0${agentProfileId ?? ''}`
    if (seen.has(contextKey)) continue
    seen.add(contextKey)
    out.push({
      id: entry.id,
      label: entry.label.slice(0, 128),
      available: entry.available === true,
      ...(agentProfileId ? { agentProfileId } : {}),
      ...(entry.forkSession === true ? { forkSession: true as const } : {}),
      ...(isRemoteProviderObservationTime(entry.observedAt) ? { observedAt: entry.observedAt } : {}),
      ...(typeof entry.metadataRevision === 'number' && Number.isSafeInteger(entry.metadataRevision) && entry.metadataRevision >= 0 ? { metadataRevision: entry.metadataRevision } : {})
    })
    if (out.length >= MAX_PROVIDERS) break
  }
  return out
}

export function commandCatalog(raw: RemoteCommandCatalog): RemoteCommandCatalog {
  const seen = new Set<string>()
  const commands: RemoteCommandRef[] = []
  for (const entry of raw.commands ?? []) {
    const name = typeof entry?.name === 'string' ? entry.name.replace(/^\/+/, '').trim() : ''
    if (!name || name.length > 128 || /\s/.test(name) || seen.has(name)) continue
    seen.add(name)
    commands.push({
      name,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 512) : '',
      ...(typeof entry.argumentHint === 'string' && entry.argumentHint.length > 0 ? { argumentHint: entry.argumentHint.slice(0, 256) } : {}),
      ...(['builtin', 'skill', 'mcp', 'custom'].includes(String(entry.source)) ? { source: entry.source } : {})
    })
    if (commands.length >= MAX_COMMANDS) break
  }
  return { commands, ...(typeof raw.reason === 'string' && raw.reason.length > 0 ? { reason: raw.reason.slice(0, 512) } : {}) }
}

export function sessionRefs(raw: RemoteSessionRef[], limit = MAX_SESSIONS): RemoteSessionRef[] {
  const seen = new Set<string>()
  const out: RemoteSessionRef[] = []
  for (const entry of raw) {
    if (!entry || typeof entry.sessionId !== 'string' || typeof entry.providerId !== 'string') continue
    if (entry.sessionId.length === 0 || entry.sessionId.length > 128 || seen.has(entry.sessionId)) continue
    seen.add(entry.sessionId)
    out.push({
      sessionId: entry.sessionId,
      ...(typeof entry.externalSessionId === 'string' && entry.externalSessionId.length > 0 ? { externalSessionId: entry.externalSessionId } : {}),
      providerId: entry.providerId.slice(0, 64),
      ...(typeof entry.agentProfileId === 'string' && entry.agentProfileId.length > 0 && entry.agentProfileId.length <= 128 ? { agentProfileId: entry.agentProfileId } : {}),
      cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, MAX_PATH) : '',
      label: typeof entry.label === 'string' ? entry.label.slice(0, 256) : '',
      ts: Number.isFinite(entry.ts) ? entry.ts : 0,
      ...(typeof entry.pinnedAt === 'number' && Number.isFinite(entry.pinnedAt) && entry.pinnedAt > 0 ? { pinnedAt: entry.pinnedAt } : {}),
      ...(typeof entry.archivedAt === 'number' && Number.isFinite(entry.archivedAt) && entry.archivedAt > 0 ? { archivedAt: entry.archivedAt } : {}),
      ...(entry.isActive === true ? { isActive: true } : {}),
      ...(Number.isSafeInteger(entry.pendingQuestions) && Number(entry.pendingQuestions) > 0
        ? { pendingQuestions: Math.min(Number(entry.pendingQuestions), 99) } : {}),
      ...(typeof entry.lastRunId === 'string' && entry.lastRunId.length > 0 && entry.lastRunId.length <= 128 ? { lastRunId: entry.lastRunId } : {}),
      ...(isRemoteSessionOutcome(entry.lastRunOutcome) ? { lastRunOutcome: entry.lastRunOutcome } : {})
    })
    if (out.length >= limit) break
  }
  return out
}
