import { INTEGRATION_COPY } from '../constants/integration-copy'
import type { CapabilityEnvelope, ProviderContext, ProviderId } from '@shared/provider'
import {
  isAgentPermissionMode,
  providerIdForAgentId,
  type AgentModelRef,
  type AgentPermissionMode,
  type AgentRunControlCatalog,
  type AgentRunControls
} from '@shared/runtime'

export const contextKey = (context: ProviderContext): string =>
  `${context.providerId}\0${context.agentProfileId ?? ''}\0${context.cwd ?? ''}`
export const capabilityMatchesContext = <T>(
  capability: CapabilityEnvelope<T> | null,
  context: ProviderContext
): capability is CapabilityEnvelope<T> =>
  capability !== null && contextKey(capability) === contextKey(context)
export const capabilityRows = <T>(capability: CapabilityEnvelope<T[]>): T[] => capability.data ?? []
export const modelKey = (model: AgentModelRef): string => `${model.providerId ?? ''}\0${model.id}`
export const RUN_CONTROL_PREFERENCES_KEY = 'scry:run-control-preferences:v1'
export const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'qoder', 'opencode', 'pi']

export interface RunControlPreferences {
  selectedAgentId: string
  controlsByProvider: Partial<Record<ProviderId, AgentRunControls>>
}

const boundedPreferenceValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= 240 ? trimmed : undefined
}

export const parseStoredRunControls = (value: unknown): AgentRunControls | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const permissionMode: AgentPermissionMode =
    isAgentPermissionMode(record.permissionMode) ? record.permissionMode : 'default'
  const storedModel = record.model
  const modelId = storedModel && typeof storedModel === 'object' && !Array.isArray(storedModel)
    ? boundedPreferenceValue((storedModel as Record<string, unknown>).id)
    : undefined
  const modelProviderId = storedModel && typeof storedModel === 'object' && !Array.isArray(storedModel)
    ? boundedPreferenceValue((storedModel as Record<string, unknown>).providerId)
    : undefined
  const effort = boundedPreferenceValue(record.effort)
  return {
    ...(modelId ? { model: { id: modelId, ...(modelProviderId ? { providerId: modelProviderId } : {}) } } : {}),
    ...(effort ? { effort } : {}),
    permissionMode
  }
}

export function parseRunControlPreferences(raw: string | null): RunControlPreferences {
  const fallback: RunControlPreferences = { selectedAgentId: 'claude', controlsByProvider: {} }
  if (!raw) return fallback
  try {
    const stored = JSON.parse(raw) as unknown
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fallback
    const record = stored as Record<string, unknown>
    const selectedAgentId = boundedPreferenceValue(record.selectedAgentId)
    const controlsRecord = record.controlsByProvider
    const controlsByProvider: Partial<Record<ProviderId, AgentRunControls>> = {}
    if (controlsRecord && typeof controlsRecord === 'object' && !Array.isArray(controlsRecord)) {
      for (const providerId of PROVIDER_IDS) {
        const controls = parseStoredRunControls((controlsRecord as Record<string, unknown>)[providerId])
        if (controls) controlsByProvider[providerId] = controls
      }
    }
    return {
      selectedAgentId: selectedAgentId && providerIdForAgentId(selectedAgentId) ? selectedAgentId : 'claude',
      controlsByProvider
    }
  } catch {
    return fallback
  }
}

export function readRunControlPreferences(): RunControlPreferences {
  if (typeof window === 'undefined') return parseRunControlPreferences(null)
  try {
    return parseRunControlPreferences(window.localStorage.getItem(RUN_CONTROL_PREFERENCES_KEY))
  } catch {
    return parseRunControlPreferences(null)
  }
}

export function writeRunControlPreferences(
  selectedAgentId: string,
  controlsByProvider: Map<ProviderId, AgentRunControls>
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RUN_CONTROL_PREFERENCES_KEY, JSON.stringify({
      selectedAgentId,
      controlsByProvider: Object.fromEntries(controlsByProvider)
    }))
  } catch {
    // localStorage 不可用时仅退化为当前进程内记忆，不阻断会话发送。
  }
}

export const fallbackRunControlCatalog = (permissionMode: AgentPermissionMode): AgentRunControlCatalog => ({
  models: [],
  permissions: [{
    id: permissionMode,
    label: permissionMode === 'full_access' ? INTEGRATION_COPY.fullAccess : INTEGRATION_COPY.defaultApproval,
    description: permissionMode === 'full_access' ? INTEGRATION_COPY.legacyControls : INTEGRATION_COPY.approvalDescription
  }]
})

const RUN_CONTROL_CATALOG_KEY = 'scry:run-control-catalog:v1'
const RUN_CONTROL_CATALOG_MAX_CONTEXTS = 8
const RUN_CONTROL_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const parseEffortOption = (value: unknown): AgentRunControlCatalog['models'][number]['efforts'][number] | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = boundedPreferenceValue(record.id)
  if (!id) return undefined
  return {
    id,
    label: boundedPreferenceValue(record.label) ?? id,
    ...(boundedPreferenceValue(record.description) ? { description: boundedPreferenceValue(record.description) } : {}),
    ...(record.isDefault === true ? { isDefault: true } : {})
  }
}

const parseModelOption = (value: unknown): AgentRunControlCatalog['models'][number] | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const model = record.model
  if (!model || typeof model !== 'object' || Array.isArray(model)) return undefined
  const id = boundedPreferenceValue((model as Record<string, unknown>).id)
  if (!id) return undefined
  const providerId = boundedPreferenceValue((model as Record<string, unknown>).providerId)
  return {
    model: { id, ...(providerId ? { providerId } : {}) },
    label: boundedPreferenceValue(record.label) ?? id,
    ...(boundedPreferenceValue(record.description) ? { description: boundedPreferenceValue(record.description) } : {}),
    ...(record.isDefault === true ? { isDefault: true } : {}),
    efforts: (Array.isArray(record.efforts) ? record.efforts : []).flatMap((effort) => {
      const parsed = parseEffortOption(effort)
      return parsed ? [parsed] : []
    })
  }
}

const parsePermissionOption = (value: unknown): AgentRunControlCatalog['permissions'][number] | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = record.id
  if (!isAgentPermissionMode(id)) return undefined
  const label = boundedPreferenceValue(record.label)
  const description = boundedPreferenceValue(record.description)
  return label && description ? { id, label, description } : undefined
}

export function parseRunControlCatalogCache(
  raw: string | null,
  now = Date.now()
): Map<string, CapabilityEnvelope<AgentRunControlCatalog>> {
  const cache = new Map<string, CapabilityEnvelope<AgentRunControlCatalog>>()
  if (!raw) return cache
  try {
    const stored = JSON.parse(raw) as unknown
    const entries = stored && typeof stored === 'object' && Array.isArray((stored as Record<string, unknown>).entries)
      ? ((stored as Record<string, unknown>).entries as unknown[])
      : []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const providerId = PROVIDER_IDS.find((candidate) => candidate === record.providerId)
      const observedAt = typeof record.observedAt === 'number' && Number.isFinite(record.observedAt)
        ? record.observedAt
        : undefined
      if (!providerId || observedAt === undefined) continue
      if (observedAt > now || now - observedAt > RUN_CONTROL_CATALOG_MAX_AGE_MS) continue
      const cwd = typeof record.cwd === 'string' && record.cwd.length <= 4_096
        ? record.cwd
        : undefined
      if (record.cwd !== undefined && cwd === undefined) continue
      const agentProfileId = typeof record.agentProfileId === 'string' && record.agentProfileId.length <= 240
        ? record.agentProfileId
        : undefined
      if (record.agentProfileId !== undefined && agentProfileId === undefined) continue
      const models = (Array.isArray(record.models) ? record.models : []).flatMap((model) => {
        const parsed = parseModelOption(model)
        return parsed ? [parsed] : []
      })
      const permissions = (Array.isArray(record.permissions) ? record.permissions : []).flatMap((permission) => {
        const parsed = parsePermissionOption(permission)
        return parsed ? [parsed] : []
      })
      if (models.length === 0 || permissions.length === 0) continue
      const context: ProviderContext = {
        providerId,
        ...(agentProfileId ? { agentProfileId } : {}),
        ...(cwd ? { cwd } : {})
      }
      cache.set(contextKey(context), {
        ...context,
        mode: 'read',
        // 缓存按 Provider + profile + cwd 隔离并有时效；只允许继续使用目录中可精确证明的既有选项。
        state: 'unknown',
        data: { models, permissions },
        reason: INTEGRATION_COPY.cachedCatalogRead(observedAt),
        observedAt
      })
      if (cache.size >= RUN_CONTROL_CATALOG_MAX_CONTEXTS) break
    }
  } catch {
    return new Map()
  }
  return cache
}

export function serializeRunControlCatalogCache(
  cache: Map<string, CapabilityEnvelope<AgentRunControlCatalog>>
): string {
  const entries = [...cache.values()]
    .flatMap((envelope) =>
      envelope.data && envelope.data.models.length > 0
        ? [{
            providerId: envelope.providerId,
            ...(envelope.agentProfileId ? { agentProfileId: envelope.agentProfileId } : {}),
            ...(envelope.cwd ? { cwd: envelope.cwd } : {}),
            observedAt: envelope.observedAt ?? Date.now(),
            models: envelope.data.models,
            permissions: envelope.data.permissions
          }]
        : []
    )
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, RUN_CONTROL_CATALOG_MAX_CONTEXTS)
  return JSON.stringify({ entries })
}

export function readRunControlCatalogCache(): Map<string, CapabilityEnvelope<AgentRunControlCatalog>> {
  if (typeof window === 'undefined') return new Map()
  try {
    return parseRunControlCatalogCache(window.localStorage.getItem(RUN_CONTROL_CATALOG_KEY))
  } catch {
    return new Map()
  }
}

export function writeRunControlCatalogCache(cache: Map<string, CapabilityEnvelope<AgentRunControlCatalog>>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RUN_CONTROL_CATALOG_KEY, serializeRunControlCatalogCache(cache))
  } catch {
    // localStorage 不可用时退化为仅进程内缓存，不影响本次会话的模型选择。
  }
}

export function isAuthoritativeRunControlCatalog(
  result: CapabilityEnvelope<AgentRunControlCatalog>
): boolean {
  return result.data != null && (
    result.state === 'ready' ||
    (result.state === 'degraded' && result.data.models.length > 0)
  )
}

export function shouldKeepCachedRunControlCatalog(
  cached: AgentRunControlCatalog | undefined,
  result: CapabilityEnvelope<AgentRunControlCatalog>
): boolean {
  if (!cached || cached.models.length === 0) return false
  return !isAuthoritativeRunControlCatalog(result)
}

export function retainCachedRunControlCatalog(
  cached: CapabilityEnvelope<AgentRunControlCatalog>,
  result: CapabilityEnvelope<AgentRunControlCatalog>
): CapabilityEnvelope<AgentRunControlCatalog> {
  return {
    ...cached,
    state: 'unknown',
    reason: result.reason
      ? INTEGRATION_COPY.cachedCatalogRefresh(result.reason)
      : cached.reason ?? INTEGRATION_COPY.cachedCatalogUnconfirmed
  }
}

export function resolveRunControlSelection(
  catalog: AgentRunControlCatalog,
  current: AgentRunControls
): AgentRunControls {
  const model = current.model
    ? catalog.models.find((option) => modelKey(option.model) === modelKey(current.model!))?.model
    : undefined
  const selectedModel = model
    ? catalog.models.find((option) => modelKey(option.model) === modelKey(model))
    : undefined
  const effort = current.effort && selectedModel?.efforts.some((option) => option.id === current.effort)
    ? current.effort
    : undefined
  const permissionMode = catalog.permissions.some((option) => option.id === current.permissionMode)
    ? current.permissionMode
    : catalog.permissions.find((option) => option.id === 'default')?.id ??
      (catalog.permissions.length === 1 ? catalog.permissions[0].id : 'default')
  return { model, effort, permissionMode }
}
