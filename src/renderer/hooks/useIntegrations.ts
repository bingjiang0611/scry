import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BillingGuardianState } from '@shared/billing'
import type { CapabilityEnvelope, McpSnapshot, ProviderContext, ProviderId } from '@shared/provider'
import type {
  DbStats,
  DiffFile,
  McpLiveStatus,
  UsageAnalytics,
  UsageAnalyticsRangeDays,
  UsageStats,
  TraceEvent
} from '@shared/trace'
import {
  providerIdForAgentId,
  runtimeProviderForAgentId,
  type AgentModelRef,
  type AgentPermissionMode,
  type AgentRunControlCatalog,
  type AgentRunControls
} from '@shared/runtime'
import type { DetectedAgent, McpMeta, ProjectMeta, SkillMeta } from '../env'
import type { McpStatus } from '../format'
import type { McpGuardReport } from '../components/McpTrustPanel'
import { getMcpGuardReportForCwd, setMcpGuardReportForCwd } from '../mcp-trust-state'
import { composerDraftKey } from '../composer-drafts'
import { selectedExternalSessionId } from '../session-selection'

const contextKey = (context: ProviderContext): string =>
  `${context.providerId}\0${context.agentProfileId ?? ''}\0${context.cwd ?? ''}`
export const capabilityMatchesContext = <T>(
  capability: CapabilityEnvelope<T> | null,
  context: ProviderContext
): capability is CapabilityEnvelope<T> =>
  capability !== null && contextKey(capability) === contextKey(context)
export const capabilityRows = <T>(capability: CapabilityEnvelope<T[]>): T[] => capability.data ?? []
const modelKey = (model: AgentModelRef): string => `${model.providerId ?? ''}\0${model.id}`
const RUN_CONTROL_PREFERENCES_KEY = 'scry:run-control-preferences:v1'
const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'qoder', 'opencode', 'pi']

export interface RunControlPreferences {
  selectedAgentId: string
  controlsByProvider: Partial<Record<ProviderId, AgentRunControls>>
}

const boundedPreferenceValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= 240 ? trimmed : undefined
}

const parseStoredRunControls = (value: unknown): AgentRunControls | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const permissionMode: AgentPermissionMode =
    record.permissionMode === 'auto_review' || record.permissionMode === 'full_access'
      ? record.permissionMode
      : 'default'
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

function readRunControlPreferences(): RunControlPreferences {
  if (typeof window === 'undefined') return parseRunControlPreferences(null)
  try {
    return parseRunControlPreferences(window.localStorage.getItem(RUN_CONTROL_PREFERENCES_KEY))
  } catch {
    return parseRunControlPreferences(null)
  }
}

function writeRunControlPreferences(
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

const fallbackRunControlCatalog = (permissionMode: AgentPermissionMode): AgentRunControlCatalog => ({
  models: [],
  permissions: [{
    id: permissionMode,
    label: permissionMode === 'full_access' ? '完全访问' : '默认审批',
    description: permissionMode === 'full_access' ? '兼容旧版运行控制' : '危险操作会暂停并请求你的确认'
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
  if (id !== 'default' && id !== 'auto_review' && id !== 'full_access') return undefined
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
        reason: `最后已知模型目录（${new Date(observedAt).toLocaleString()} 读取）；正在向 Provider 复核运行权限`,
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

function readRunControlCatalogCache(): Map<string, CapabilityEnvelope<AgentRunControlCatalog>> {
  if (typeof window === 'undefined') return new Map()
  try {
    return parseRunControlCatalogCache(window.localStorage.getItem(RUN_CONTROL_CATALOG_KEY))
  } catch {
    return new Map()
  }
}

function writeRunControlCatalogCache(cache: Map<string, CapabilityEnvelope<AgentRunControlCatalog>>): void {
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
      ? `当前显示最后已知模型目录；${result.reason}`
      : cached.reason ?? '当前显示最后已知模型目录；Provider 尚未确认本次运行权限'
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
    : catalog.permissions.find((option) => option.id === 'default')?.id ?? 'default'
  return { model, effort, permissionMode }
}

export async function authoritativeRefreshAfterToggle<T>(
  result: CapabilityEnvelope<boolean>,
  refresh: () => Promise<T>
): Promise<T | null> {
  return result.data === true ? refresh() : null
}

export function applyDataUpdatedEffects(effects: {
  loadStats: () => void
  loadBillingState: () => void
  loadAnalytics: () => void
  analyticsActive: boolean
}): void {
  effects.loadStats()
  effects.loadBillingState()
  // Analytics is a comparatively expensive, optional SQLite projection. Keep it fresh once the
  // user has opened the surface, but do not query it during every chat-only application launch.
  if (effects.analyticsActive) effects.loadAnalytics()
}

export function mergeMcpLiveSnapshot(
  current: McpLiveStatus[],
  runtime: McpLiveStatus[] | null | undefined,
  clearUnknownRuntime = false
): McpLiveStatus[] {
  return runtime ?? (clearUnknownRuntime ? [] : current)
}

export function reconcileMcpAuthStatus(
  current: Record<string, McpStatus>,
  configured: McpMeta[],
  runtime: McpLiveStatus[]
): Record<string, McpStatus> {
  const configuredByTarget = new Map(configured.map((item) => [item.targetId ?? item.name, item]))
  const runtimeByName = new Map(runtime.map((item) => [item.name, item]))
  return Object.fromEntries(Object.entries(current).flatMap(([targetId, state]) => {
    const target = configuredByTarget.get(targetId)
    if (!target) return []
    const live = runtimeByName.get(target.name)
    if (state.authenticating || live?.status !== 'connected') return [[targetId, state]]
    const next = { ...state }
    delete next.authOk
    delete next.authError
    return [[targetId, next]]
  }))
}

export function mcpAuthVerificationError(snapshot: McpSnapshot, targetId: string): string | undefined {
  const target = snapshot.configured.find((item) => (item.targetId ?? item.name) === targetId)
  const live = target && snapshot.runtime?.find((item) => item.name === target.name)
  return live?.status === 'connected' ? undefined : `刷新后运行状态为 ${live?.status ?? '未返回'}`
}

export function shouldResetRunControlCatalog(currentAgentId: string, nextAgentId: string): boolean {
  return currentAgentId !== nextAgentId
}

export function runControlSendBlockedReason(
  providerId: ProviderId,
  capability: CapabilityEnvelope<AgentRunControlCatalog> | null,
  loading: boolean,
  controls: AgentRunControls
): string | null {
  const usesProviderDefaults =
    controls.permissionMode === 'default' &&
    controls.model == null &&
    controls.effort == null
  // Pi has no default approval mode. A cold catalog temporarily resets the selection to
  // default, even when full_access is saved; never send that placeholder to the adapter.
  if (providerId !== 'pi' && usesProviderDefaults && capability === null && loading) return null

  const selectedModel = controls.model && capability?.data
    ? capability.data.models.find((option) => modelKey(option.model) === modelKey(controls.model!))
    : undefined
  const selectionIsKnown = capability?.data != null &&
    (controls.model == null || selectedModel != null) &&
    (controls.effort == null || selectedModel?.efforts.some((option) => option.id === controls.effort) === true) &&
    capability.data.permissions.some((option) => option.id === controls.permissionMode)
  const cachedCatalog = capability?.state === 'unknown' &&
    capability.reason?.includes('最后已知模型目录') === true
  if (cachedCatalog && selectionIsKnown) return null
  if (capability?.data != null && !selectionIsKnown) {
    return cachedCatalog
      ? '最后已知模型目录不包含当前模型、推理强度或权限，请重新选择'
      : '当前 Provider 不支持所选模型、推理强度或权限，请重新选择'
  }
  return !capability || capability.data == null ||
    (capability.state !== 'ready' && capability.state !== 'degraded')
    ? capability?.reason ?? '运行权限能力尚未确认，暂不能发送'
    : null
}

export function requestRunControlsForSelectedProvider<T>(
  providerId: ProviderId,
  cwd: string | null,
  request: (context: ProviderContext) => Promise<T>,
  agentProfileId?: string
): Promise<T> {
  return request({ providerId, ...(agentProfileId ? { agentProfileId } : {}), cwd: cwd ?? undefined })
}

export function reconcileSelectedAgentId(current: string, detected: DetectedAgent[]): string {
  if (detected.length === 0) return current
  const available = (agent: DetectedAgent): boolean => agent.health?.state !== 'unavailable'
  const currentProviderId = providerIdForAgentId(current)
  const sameProviderFallback = currentProviderId
    ? detected.find((agent) => providerIdForAgentId(agent.id) === currentProviderId && available(agent))
    : undefined
  const selected = detected.find((agent) => agent.id === current)
  if (!selected) return sameProviderFallback?.id ?? detected.find(available)?.id ?? detected[0].id
  if (available(selected)) return current
  // 不跨 Provider 静默切换；但同一 Provider 的可用 Profile 应替代失效 Profile。
  return sameProviderFallback?.id ?? current
}

type SessionModelSelection = Pick<AgentRunControls, 'model' | 'effort'>

export function recordedSessionModel(turns: { items: TraceEvent[] }[]): SessionModelSelection | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex].items
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const event = items[index]
      if (event.kind !== 'harness' || event.stage !== 'runtime:controls') continue
      const controls = parseStoredRunControls(event.input)
      return controls ? { model: controls.model, effort: controls.effort } : undefined
    }
  }
  return undefined
}
const SESSION_MODELS_KEY = 'scry:session-models:v1'

export function parseSessionModels(raw: string | null): Map<string, SessionModelSelection> {
  if (!raw) return new Map()
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) return new Map()
    return new Map(rows.flatMap((row) => {
      if (!Array.isArray(row) || typeof row[0] !== 'string') return []
      const controls = parseStoredRunControls(row[1])
      return controls ? [[row[0], { model: controls.model, effort: controls.effort }]] : []
    }))
  } catch {
    return new Map()
  }
}

export function useIntegrations(
  cwd: string | null,
  sessionId: string | null,
  projects: ProjectMeta[],
  capabilityView: 'skills' | 'mcp' | null
) {
  const [sessionModels, setSessionModels] = useState(() => {
    try {
      return parseSessionModels(window.localStorage.getItem(SESSION_MODELS_KEY))
    } catch {
      return new Map<string, SessionModelSelection>()
    }
  })
  const rememberSessionModel = useCallback((key: string, selection: SessionModelSelection): void => {
    setSessionModels((current) => new Map(current).set(key, { model: selection.model, effort: selection.effort }))
  }, [])
  const restoreSessionModel = useCallback((key: string, selection: SessionModelSelection): void => {
    setSessionModels((current) => current.has(key) ? current : new Map(current).set(key, selection))
  }, [])
  const migrateSessionModel = useCallback((fromKey: string, toKey: string): void => {
    setSessionModels((current) => {
      if (fromKey === toKey || !current.has(fromKey)) return current
      const next = new Map(current)
      next.set(toKey, current.get(fromKey)!)
      next.delete(fromKey)
      return next
    })
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify([...sessionModels]))
    } catch {
      // Like run-control preferences, storage failure keeps the live window's selection.
    }
  }, [sessionModels])
  const storedRunControlPreferences = useMemo(readRunControlPreferences, [])
  const initialProviderId = providerIdForAgentId(storedRunControlPreferences.selectedAgentId) ?? 'claude'
  const initialAgentProfileId = initialProviderId === 'pi' ? storedRunControlPreferences.selectedAgentId : undefined
  const storedRunControlCatalogs = useMemo(readRunControlCatalogCache, [])
  const initialRunControlCatalog = storedRunControlCatalogs.get(
    contextKey({ providerId: initialProviderId, agentProfileId: initialAgentProfileId, cwd: cwd ?? undefined })
  )
  const [agents, setAgents] = useState<DetectedAgent[]>([])
  const [agentsHydrated, setAgentsHydrated] = useState(false)
  const [agentsScanning, setAgentsScanning] = useState(true)
  const [selectedId, setSelectedId] = useState(storedRunControlPreferences.selectedAgentId)
  const [runControls, setRunControls] = useState<AgentRunControls>(() => {
    const stored = storedRunControlPreferences.controlsByProvider[initialProviderId] ??
      { permissionMode: 'default' as const }
    return initialRunControlCatalog?.data
      ? resolveRunControlSelection(initialRunControlCatalog.data, stored)
      : stored
  })
  const [runControlCatalog, setRunControlCatalog] = useState<AgentRunControlCatalog>(
    initialRunControlCatalog?.data ?? fallbackRunControlCatalog('default')
  )
  const [runControlCapability, setRunControlCapability] =
    useState<CapabilityEnvelope<AgentRunControlCatalog> | null>(initialRunControlCatalog ?? null)
  const [runControlsLoading, setRunControlsLoading] = useState(false)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [skillCapability, setSkillCapability] = useState<CapabilityEnvelope<SkillMeta[]> | null>(null)
  const [skillsRefreshing, setSkillsRefreshing] = useState(false)
  const [mcps, setMcps] = useState<McpMeta[]>([])
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatus>>({})
  const [mcpLive, setMcpLive] = useState<McpLiveStatus[]>([])
  const [mcpCapability, setMcpCapability] = useState<CapabilityEnvelope<McpSnapshot> | null>(null)
  const [mcpConfigRefreshing, setMcpConfigRefreshing] = useState(false)
  const [mcpRefreshing, setMcpRefreshing] = useState(false)
  const [usage, setUsage] = useState<UsageStats | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null)
  const [analyticsRange, setAnalyticsRangeState] = useState<UsageAnalyticsRangeDays>(30)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [billingState, setBillingState] = useState<BillingGuardianState | null>(null)
  const [billingSyncing, setBillingSyncing] = useState(false)
  const [billingFixtureLoading, setBillingFixtureLoading] = useState(false)
  const [mcpGuardReportsByCwd, setMcpGuardReportsByCwd] = useState<Record<string, McpGuardReport>>({})
  const [mcpGuardScanning, setMcpGuardScanning] = useState(false)
  const [gitDiff, setGitDiff] = useState<DiffFile[]>([])
  const cwdRef = useRef(cwd)
  const gitDiffRequestSeq = useRef(0)
  const usageRequestSeq = useRef(0)
  const analyticsRequestSeq = useRef(0)
  const analyticsRangeRef = useRef<UsageAnalyticsRangeDays>(30)
  const analyticsActiveRef = useRef(false)
  const analyticsQueryInFlightRef = useRef(false)
  const analyticsRefreshQueuedRef = useRef(false)
  const skillRefreshRequestSeq = useRef(0)
  const mcpConfigRequestSeq = useRef(0)
  const mcpLiveRequestSeq = useRef(0)
  const mcpTestCounter = useRef(0)
  const mcpTestRequests = useRef(new Map<string, number>())
  const mcpAuthCounter = useRef(0)
  const mcpAuthRequests = useRef(new Map<string, number>())
  const mcpConfigPromiseRef = useRef<Promise<McpLiveStatus[]> | null>(null)
  const runControlRequestSeq = useRef(0)
  const [detectionRevision, setDetectionRevision] = useState(0)
  const [runControlsRefreshing, setRunControlsRefreshing] = useState(false)
  const [agentsScanError, setAgentsScanError] = useState<string | null>(null)
  const selectedSessionRef = useRef(sessionId)
  selectedSessionRef.current = sessionId
  const runControlsByProvider = useRef(new Map<ProviderId, AgentRunControls>(
    PROVIDER_IDS.flatMap((providerId) => {
      const controls = storedRunControlPreferences.controlsByProvider[providerId]
      return controls ? [[providerId, controls]] : []
    })
  ))
  const runControlCatalogByContext = useRef(storedRunControlCatalogs)
  const runControlCatalogRequests = useRef(
    new Map<string, Promise<CapabilityEnvelope<AgentRunControlCatalog>>>()
  )

  const requestRunControlCatalog = useCallback(
    (context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>> => {
      const key = contextKey(context)
      const pending = runControlCatalogRequests.current.get(key)
      if (pending) return pending
      const fn = window.scry.runControls
      if (typeof fn !== 'function') return Promise.reject(new Error('运行控制接口不可用'))
      const request = fn(context)
        .then((result) => {
          if (isAuthoritativeRunControlCatalog(result)) {
            runControlCatalogByContext.current.delete(key)
            runControlCatalogByContext.current.set(key, result)
            while (runControlCatalogByContext.current.size > 16) {
              const oldest = runControlCatalogByContext.current.keys().next().value
              if (oldest === undefined) break
              runControlCatalogByContext.current.delete(oldest)
            }
            writeRunControlCatalogCache(runControlCatalogByContext.current)
          }
          return result
        })
        .finally(() => runControlCatalogRequests.current.delete(key))
      runControlCatalogRequests.current.set(key, request)
      return request
    },
    []
  )

  const selectedAgent = agents.find((agent) => agent.id === selectedId)
  const selectedProviderId = providerIdForAgentId(selectedId) ?? 'claude'
  const selectedRuntimeProvider = runtimeProviderForAgentId(selectedId) ?? 'claude_sdk'
  const providerContext = useMemo<ProviderContext>(
    () => ({
      providerId: selectedProviderId,
      ...(selectedProviderId === 'pi' ? { agentProfileId: selectedId } : {}),
      cwd: cwd ?? undefined
    }),
    [cwd, selectedId, selectedProviderId]
  )
  const externalSessionId = selectedExternalSessionId(projects, { ...providerContext, cwd, sessionId })
  const sessionModelKey = composerDraftKey({ ...providerContext, sessionId: externalSessionId ?? sessionId })
  // An unrecorded historical session resumes with Provider-native defaults, never
  // with another conversation's latest explicit model. Missing evidence is not inferred.
  const sessionModel = sessionId == null ? runControls : sessionModels.get(sessionModelKey) ?? {}
  const currentRunControls = { ...runControls, model: sessionModel.model, effort: sessionModel.effort }
  const providerContextRef = useRef(providerContext)
  const trustKey = `${providerContext.providerId}:${providerContext.agentProfileId ?? ''}:${cwd ?? ''}`
  const mcpGuardReport = useMemo(
    () => getMcpGuardReportForCwd(mcpGuardReportsByCwd, trustKey),
    [mcpGuardReportsByCwd, trustKey]
  )

  const rescan = useCallback((): void => {
    setAgentsScanning(true)
    setAgentsScanError(null)
    window.scry
      .detect()
      .then((detected) => {
        setAgents(detected)
        // Refresh health without changing a resumed session's runtime.
        setSelectedId((current) => selectedSessionRef.current == null
          ? reconcileSelectedAgentId(current, detected)
          : current)
      })
      .catch((error: unknown) => setAgentsScanError(error instanceof Error ? error.message : String(error)))
      .finally(() => setAgentsScanning(false))
  }, [])

  const addPiProfile = useCallback(async (): Promise<void> => {
    const added = await window.scry.addPiProfile()
    if (!added) return
    setAgents((current) => [...current.filter((agent) => agent.id !== added.id), added])
    setSelectedId(added.id)
    rescan()
  }, [rescan])

  const removePiProfile = useCallback(async (id: string): Promise<void> => {
    if (id === 'pi:default') return
    await window.scry.removePiProfile(id)
    const remaining = agents.filter((agent) => agent.id !== id)
    setAgents(remaining)
    if (selectedId === id) {
      setSelectedId(remaining.find((agent) => agent.id === 'pi:default')?.id ?? remaining[0]?.id ?? 'claude')
    }
  }, [agents, selectedId])

  const loadUsage = useCallback((): void => {
    const context = providerContextRef.current
    const seq = ++usageRequestSeq.current
    window.scry.usageStats(context)
      .then((next) => {
        if (seq === usageRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) setUsage(next)
      })
      .catch(() => {})
  }, [])

  const loadStats = useCallback((): void => {
    window.scry.stats().then(setStats)
  }, [])

  const loadAnalytics = useCallback((rangeDays = analyticsRangeRef.current): void => {
    analyticsActiveRef.current = true
    const query = window.scry.usageAnalytics
    if (typeof query !== 'function') {
      setAnalyticsError('分析接口不可用，请重启 Scry')
      return
    }
    // Serialize analytics refreshes. A burst of data-updated notifications while one query is
    // running becomes one latest-range refresh instead of concurrent full-range SQLite work.
    if (analyticsQueryInFlightRef.current) {
      analyticsRefreshQueuedRef.current = true
      // The in-flight snapshot may precede this refresh request (or belong to an older range).
      // Invalidate its UI commit; finally will launch exactly one latest-range replacement.
      analyticsRequestSeq.current += 1
      return
    }
    analyticsQueryInFlightRef.current = true
    analyticsRefreshQueuedRef.current = false
    const seq = ++analyticsRequestSeq.current
    setAnalyticsLoading(true)
    setAnalyticsError(null)
    void query(rangeDays)
      .then((result) => {
        if (seq !== analyticsRequestSeq.current) return
        setAnalytics(result)
        if (result.status === 'query_error') setAnalyticsError('SQLite 查询失败，请重试')
        else if (result.status === 'unavailable') setAnalyticsError('SQLite 暂不可用')
      })
      .catch((error) => {
        if (seq === analyticsRequestSeq.current) setAnalyticsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        analyticsQueryInFlightRef.current = false
        if (seq === analyticsRequestSeq.current) setAnalyticsLoading(false)
        if (analyticsRefreshQueuedRef.current) {
          analyticsRefreshQueuedRef.current = false
          loadAnalytics(analyticsRangeRef.current)
        }
      })
  }, [])

  const setAnalyticsRange = useCallback((rangeDays: UsageAnalyticsRangeDays): void => {
    analyticsRangeRef.current = rangeDays
    setAnalyticsRangeState(rangeDays)
    setAnalytics(null)
    loadAnalytics(rangeDays)
  }, [loadAnalytics])

  const loadBillingState = useCallback((): void => {
    if (typeof window.scry.billingState === 'function') window.scry.billingState().then(setBillingState).catch(() => {})
  }, [])

  const syncBillingAdmin = useCallback(async (): Promise<void> => {
    if (typeof window.scry.syncBillingAdmin !== 'function') return
    setBillingSyncing(true)
    try {
      setBillingState((await window.scry.syncBillingAdmin()).state)
    } finally {
      setBillingSyncing(false)
    }
  }, [])

  const importBillingFixture = useCallback(async (): Promise<void> => {
    if (typeof window.scry.importBillingFixture !== 'function') return
    setBillingFixtureLoading(true)
    try {
      setBillingState((await window.scry.importBillingFixture()).state)
    } finally {
      setBillingFixtureLoading(false)
    }
  }, [])

  const loadGitDiff = useCallback((dir = cwdRef.current): void => {
    const seq = ++gitDiffRequestSeq.current
    if (dir && typeof window.scry.gitDiff === 'function') {
      window.scry
        .gitDiff(dir)
        .then((diff) => {
          if (seq === gitDiffRequestSeq.current && cwdRef.current === dir) setGitDiff(diff)
        })
        .catch(() => {
          if (seq === gitDiffRequestSeq.current && cwdRef.current === dir) setGitDiff([])
        })
    } else setGitDiff([])
  }, [])

  const refreshSkills = useCallback(async (): Promise<void> => {
    const context = providerContextRef.current
    const seq = ++skillRefreshRequestSeq.current
    setSkillsRefreshing(true)
    try {
      const result = await window.scry.listSkills(context)
      if (seq !== skillRefreshRequestSeq.current || contextKey(context) !== contextKey(providerContextRef.current)) return
      setSkillCapability(result)
      setSkills(capabilityRows(result))
    } catch {
      if (seq === skillRefreshRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) {
        setSkills([])
        setSkillCapability(null)
      }
    } finally {
      if (seq === skillRefreshRequestSeq.current) setSkillsRefreshing(false)
    }
  }, [])

  const applyMcpSnapshot = useCallback((
    result: CapabilityEnvelope<McpSnapshot>,
    clearUnknownRuntime = false
  ): McpLiveStatus[] => {
    setMcpCapability(result)
    if (!result.data) {
      if (clearUnknownRuntime) setMcpLive([])
      return []
    }
    setMcps(result.data.configured)
    setMcpLive((current) => mergeMcpLiveSnapshot(current, result.data?.runtime, clearUnknownRuntime))
    if (result.data.runtime) {
      setMcpStatus((current) => reconcileMcpAuthStatus(current, result.data!.configured, result.data!.runtime!))
    }
    return result.data.runtime ?? []
  }, [])

  const loadMcpLive = useCallback(async (): Promise<McpLiveStatus[]> => {
    const context = providerContextRef.current
    const result = await window.scry.mcpSnapshot(context)
    return contextKey(context) === contextKey(providerContextRef.current) ? applyMcpSnapshot(result) : []
  }, [applyMcpSnapshot])

  const refreshMcp = useCallback((): Promise<McpLiveStatus[]> => {
    if (mcpConfigPromiseRef.current) return mcpConfigPromiseRef.current
    const seq = ++mcpConfigRequestSeq.current
    setMcpConfigRefreshing(true)
    const request = loadMcpLive()
    mcpConfigPromiseRef.current = request
    return request.finally(() => {
      if (mcpConfigPromiseRef.current === request) mcpConfigPromiseRef.current = null
      if (seq === mcpConfigRequestSeq.current) setMcpConfigRefreshing(false)
    })
  }, [loadMcpLive])

  const pullMcpLive = useCallback(async (): Promise<void> => {
    const context = providerContextRef.current
    const seq = ++mcpLiveRequestSeq.current
    setMcpRefreshing(true)
    try {
      const result = await window.scry.mcpSnapshot(context, true)
      if (seq === mcpLiveRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) {
        applyMcpSnapshot(result, true)
      }
    } catch (error) {
      if (seq === mcpLiveRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) {
        setMcpLive([])
        setMcpCapability((current) => ({
          providerId: context.providerId,
          cwd: context.cwd,
          mode: current?.providerId === context.providerId ? current.mode : 'none',
          state: 'unknown',
          data: current?.providerId === context.providerId && current.data
            ? { ...current.data, runtime: null }
            : null,
          reason: error instanceof Error ? error.message : String(error)
        }))
      }
    } finally {
      if (seq === mcpLiveRequestSeq.current) setMcpRefreshing(false)
    }
  }, [applyMcpSnapshot])

  const testMcp = useCallback(async (targetId: string): Promise<void> => {
    const context = providerContextRef.current
    const key = `${contextKey(context)}\0${targetId}`
    const seq = ++mcpTestCounter.current
    mcpTestRequests.current.set(key, seq)
    setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], testing: true } }))
    try {
      const result = await window.scry.testMcp(context, targetId)
      if (mcpTestRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      setMcpStatus((prev) => ({
        ...prev,
        [targetId]: {
          ...prev[targetId],
          ...(result.data ?? { ok: false, error: result.reason ?? '当前 Provider 不支持 MCP 测试' }),
          testing: false
        }
      }))
    } catch (error) {
      if (mcpTestRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      setMcpStatus((prev) => ({
        ...prev,
        [targetId]: {
          ...prev[targetId],
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          testing: false
        }
      }))
    }
  }, [])

  const reauthenticateMcp = useCallback(async (targetId: string): Promise<void> => {
    const context = providerContextRef.current
    const key = `${contextKey(context)}\0${targetId}`
    const seq = ++mcpAuthCounter.current
    mcpAuthRequests.current.set(key, seq)
    setMcpStatus((prev) => ({
      ...prev,
      [targetId]: {
        ...prev[targetId],
        authenticating: true,
        authOk: undefined,
        authError: undefined
      }
    }))
    try {
      const result = await window.scry.reauthenticateMcp(context, targetId)
      if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      if (!result.data?.ok) {
        const authenticated = result.data?.status === 'authenticated-unverified'
        setMcpStatus((prev) => ({
          ...prev,
          [targetId]: {
            ...prev[targetId],
            authenticating: false,
            authOk: authenticated,
            authError: result.data?.error ?? result.reason ?? 'MCP 认证失败'
          }
        }))
        return
      }
      setMcpStatus((prev) => ({
        ...prev,
        [targetId]: {
          ...prev[targetId],
          authenticating: false,
          authOk: true,
          authError: undefined
        }
      }))
      let refreshed: CapabilityEnvelope<McpSnapshot>
      try {
        refreshed = await window.scry.mcpSnapshot(context, true)
      } catch (error) {
        if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
        setMcpStatus((prev) => ({
          ...prev,
          [targetId]: {
            ...prev[targetId],
            authenticating: false,
            authOk: true,
            authError: error instanceof Error ? error.message : String(error)
          }
        }))
        return
      }
      if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      applyMcpSnapshot(refreshed, true)
      const verificationError = refreshed.data
        ? mcpAuthVerificationError(refreshed.data, targetId)
        : refreshed.reason ?? '运行状态刷新失败'
      setMcpStatus((prev) => ({
        ...prev,
        [targetId]: {
          ...prev[targetId],
          authenticating: false,
          authOk: true,
          authError: verificationError
        }
      }))
    } catch (error) {
      if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      setMcpStatus((prev) => ({
        ...prev,
        [targetId]: {
          ...prev[targetId],
          authenticating: false,
          authOk: false,
          authError: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  }, [applyMcpSnapshot])

  const setCurrentMcpGuardReport = useCallback(
    (report: McpGuardReport): void => {
      setMcpGuardReportsByCwd((reportsByCwd) => setMcpGuardReportForCwd(reportsByCwd, trustKey, report))
    },
    [trustKey]
  )

  const scanMcpGuard = useCallback(async (): Promise<McpGuardReport> => {
    if (!cwd) throw new Error('没有当前工作目录，无法扫描 MCP 配置')
    setMcpGuardScanning(true)
    try {
      const result = await window.scry.mcpGuardScan(providerContextRef.current)
      if (!result.data) throw new Error(result.reason ?? '当前 Provider 不支持 MCP Guard')
      return result.data
    } finally {
      setMcpGuardScanning(false)
    }
  }, [cwd])

  const refreshAfterTurn = useCallback((): void => {
    loadUsage()
    loadGitDiff()
  }, [loadGitDiff, loadUsage])

  const setRunModel = useCallback((model: AgentModelRef | undefined): void => {
    if (sessionId != null) rememberSessionModel(sessionModelKey, { model, effort: undefined })
    setRunControls((current) => {
      const next = { ...current, model, effort: undefined }
      runControlsByProvider.current.set(selectedProviderId, next)
      return next
    })
  }, [rememberSessionModel, selectedProviderId, sessionId, sessionModelKey])

  const setRunEffort = useCallback((effort: string | undefined): void => {
    if (sessionId != null) rememberSessionModel(sessionModelKey, { model: currentRunControls.model, effort })
    setRunControls((current) => {
      const next = { ...current, model: currentRunControls.model, effort }
      runControlsByProvider.current.set(selectedProviderId, next)
      return next
    })
  }, [currentRunControls.model, rememberSessionModel, selectedProviderId, sessionId, sessionModelKey])

  const setPermissionMode = useCallback((permissionMode: AgentPermissionMode): void => {
    setRunControls((current) => {
      const next = { ...current, permissionMode }
      runControlsByProvider.current.set(selectedProviderId, next)
      return next
    })
  }, [selectedProviderId])

  const selectAgent = useCallback((agentId: string): void => {
    if (agentId === selectedId) return
    const providerId = providerIdForAgentId(agentId) ?? 'claude'
    setSelectedId(agentId)
    if (!shouldResetRunControlCatalog(selectedId, agentId)) return
    const stored = runControlsByProvider.current.get(providerId) ?? { permissionMode: 'default' as const }
    const cached = runControlCatalogByContext.current.get(contextKey({
      providerId,
      ...(providerId === 'pi' ? { agentProfileId: agentId } : {}),
      cwd: cwdRef.current ?? undefined
    }))
    if (cached?.data) {
      const next = resolveRunControlSelection(cached.data, stored)
      runControlsByProvider.current.set(providerId, next)
      setRunControlCapability(cached)
      setRunControlCatalog(cached.data)
      setRunControls(next)
      setRunControlsLoading(false)
      return
    }
    const loadingCatalog = fallbackRunControlCatalog('default')
    setRunControlCapability(null)
    setRunControlCatalog(loadingCatalog)
    setRunControls(resolveRunControlSelection(loadingCatalog, stored))
    setRunControlsLoading(true)
  }, [selectedId])

  useEffect(() => {
    cwdRef.current = cwd
    providerContextRef.current = providerContext
    ++usageRequestSeq.current
    setUsage(null)
    ++skillRefreshRequestSeq.current
    ++mcpConfigRequestSeq.current
    ++mcpLiveRequestSeq.current
    mcpTestRequests.current.clear()
    mcpAuthRequests.current.clear()
    mcpConfigPromiseRef.current = null
    setSkills([])
    setMcps([])
    setMcpStatus({})
    setMcpLive([])
    setSkillCapability(null)
    setSkillsRefreshing(false)
    setMcpCapability(null)
    setMcpConfigRefreshing(false)
    setMcpRefreshing(false)
    loadGitDiff(cwd)
    if (cwd) loadUsage()
  }, [cwd, loadGitDiff, loadUsage, providerContext])

  useEffect(() => {
    // Inventory is read for the visible page, not to decorate navigation.
    // Context changes still clear old evidence before loading the active view.
    if (capabilityView === 'skills') void refreshSkills()
    if (capabilityView === 'mcp') void refreshMcp().catch(() => {})
  }, [capabilityView, providerContext, refreshMcp, refreshSkills])

  useEffect(() => {
    const seq = ++runControlRequestSeq.current
    setRunControlsRefreshing(true)
    const context = providerContext
    const key = contextKey(context)
    const stored = runControlsByProvider.current.get(selectedProviderId) ?? { permissionMode: 'default' as const }
    const fn = window.scry.runControls
    const cached = runControlCatalogByContext.current.get(key)
    if (cached?.data) {
      const next = resolveRunControlSelection(cached.data, stored)
      runControlsByProvider.current.set(selectedProviderId, next)
      setRunControlCapability(cached)
      setRunControlCatalog(cached.data)
      setRunControls(next)
      setRunControlsLoading(false)
    } else {
      const loadingCatalog = fallbackRunControlCatalog('default')
      setRunControlCapability(null)
      setRunControlCatalog(loadingCatalog)
      setRunControls(resolveRunControlSelection(loadingCatalog, stored))
      setRunControlsLoading(true)
    }
    if (typeof fn !== 'function') {
      const fallback = fallbackRunControlCatalog('default')
      const next = resolveRunControlSelection(fallback, stored)
      runControlsByProvider.current.set(selectedProviderId, next)
      setRunControlCatalog(fallback)
      setRunControls(next)
      setRunControlsLoading(false)
      setRunControlsRefreshing(false)
      return
    }
    void requestRunControlsForSelectedProvider(
      selectedProviderId,
      cwd,
      requestRunControlCatalog,
      providerContext.agentProfileId
    )
      .then((result) => {
        if (
          seq !== runControlRequestSeq.current ||
          contextKey(context) !== contextKey(providerContextRef.current)
        ) return
        if (shouldKeepCachedRunControlCatalog(cached?.data ?? undefined, result)) {
          setRunControlCapability(retainCachedRunControlCatalog(cached!, result))
          return
        }
        const catalog = result.data ?? fallbackRunControlCatalog('default')
        const next = resolveRunControlSelection(catalog, stored)
        runControlsByProvider.current.set(selectedProviderId, next)
        setRunControlCapability(result)
        setRunControlCatalog(catalog)
        setRunControls(next)
      })
      .catch(() => {
        if (seq !== runControlRequestSeq.current) return
        if (cached?.data) return
        const fallback = fallbackRunControlCatalog('default')
        const next = resolveRunControlSelection(fallback, stored)
        runControlsByProvider.current.set(selectedProviderId, next)
        setRunControlCatalog(fallback)
        setRunControls(next)
      })
      .finally(() => {
        if (seq === runControlRequestSeq.current) {
          setRunControlsLoading(false)
          setRunControlsRefreshing(false)
        }
      })
  }, [cwd, providerContext, requestRunControlCatalog, selectedProviderId, detectionRevision])

  useEffect(() => {
    writeRunControlPreferences(selectedId, runControlsByProvider.current)
  }, [runControls, selectedId])

  useEffect(() => {
    const refreshGitDiff = (): void => {
      if (document.visibilityState === 'visible') loadGitDiff()
    }
    window.addEventListener('focus', refreshGitDiff)
    document.addEventListener('visibilitychange', refreshGitDiff)
    return () => {
      window.removeEventListener('focus', refreshGitDiff)
      document.removeEventListener('visibilitychange', refreshGitDiff)
    }
  }, [loadGitDiff])

  useEffect(() => {
    const subscribe = window.scry.onDataUpdated
    if (typeof subscribe !== 'function') return
    let timer: number | null = null
    const unsubscribe = subscribe(() => {
      // Commit paths may publish several notifications back-to-back. Coalesce them without polling.
      if (timer != null) return
      timer = window.setTimeout(() => {
        timer = null
        applyDataUpdatedEffects({
          loadStats,
          loadBillingState,
          loadAnalytics,
          analyticsActive: analyticsActiveRef.current
        })
      }, 100)
    })
    return () => {
      if (timer != null) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [loadAnalytics, loadBillingState, loadStats])

  useEffect(() => {
    let cancelled = false
    let rescanTimer: number | null = null
    const fast = typeof window.scry.detectFast === 'function' ? window.scry.detectFast() : Promise.resolve([])
    void fast
      .then((detected) => {
        if (cancelled || detected.length === 0) return
        setAgents(detected)
        setSelectedId((current) => reconcileSelectedAgentId(current, detected))
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return
        setAgentsHydrated(true)
        // Full descriptor/version probing launches provider processes. Keep it off the critical first-paint path.
        rescanTimer = window.setTimeout(rescan, 400)
      })
    return () => {
      cancelled = true
      if (rescanTimer != null) window.clearTimeout(rescanTimer)
    }
  }, [rescan])

  useEffect(() => {
    const timers = [
      window.setTimeout(loadUsage, 260),
      window.setTimeout(loadStats, 900),
      window.setTimeout(loadBillingState, 980)
    ]
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [loadAnalytics, loadBillingState, loadStats, loadUsage])

  const currentSkillCapability = capabilityMatchesContext(skillCapability, providerContext)
    ? skillCapability
    : null

  return {
    agents,
    agentsHydrated,
    agentsScanning,
    selectedAgent,
    selectedId,
    selectedProviderId,
    selectedRuntimeProvider,
    providerContext,
    setSelectedId: selectAgent,
    runControls: currentRunControls,
    hasSessionModel: sessionModels.has(sessionModelKey),
    rememberSessionModel,
    restoreSessionModel,
    migrateSessionModel,
    runControlCatalog,
    runControlCapability,
    runControlsLoading,
    setRunModel,
    setRunEffort,
    setPermissionMode,
    skills: currentSkillCapability ? skills : [],
    skillCapability: currentSkillCapability,
    skillsRefreshing,
    mcps,
    mcpStatus,
    mcpLive,
    mcpCapability,
    mcpConfigRefreshing,
    mcpRefreshing,
    usage,
    stats,
    analytics,
    analyticsRange,
    analyticsLoading,
    analyticsError,
    billingState,
    billingSyncing,
    billingFixtureLoading,
    mcpGuardReport,
    mcpGuardScanning,
    gitDiff,
    rescan,
    agentsScanError,
    detectionRetrying: agentsScanning || runControlsRefreshing,
    retryDetection: () => {
      if (agentsScanning || runControlsRefreshing) return
      rescan()
      setDetectionRevision((revision) => revision + 1)
    },
    addPiProfile,
    removePiProfile,
    refreshSkills,
    loadMcpLive,
    refreshMcp,
    pullMcpLive,
    testMcp,
    reauthenticateMcp,
    setCurrentMcpGuardReport,
    scanMcpGuard,
    syncBillingAdmin,
    importBillingFixture,
    loadStats,
    loadAnalytics,
    setAnalyticsRange,
    loadGitDiff,
    refreshAfterTurn
  }
}
