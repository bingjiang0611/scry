import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BillingGuardianState } from '@shared/billing'
import type { AccountSnapshot, CapabilityEnvelope, McpSnapshot, ProviderContext, ProviderId } from '@shared/provider'
import type { DbStats, Diagnostics, DiffFile, McpLiveStatus, UsageStats } from '@shared/trace'
import {
  providerIdForAgentId,
  runtimeProviderForAgentId,
  type AgentModelRef,
  type AgentPermissionMode,
  type AgentRunControlCatalog,
  type AgentRunControls
} from '@shared/runtime'
import type { DetectedAgent, McpMeta, SkillMeta } from '../env'
import { updateMcpLiveAfterToggle } from '../format'
import type { McpStatus } from '../format'
import type { McpGuardReport } from '../components/McpTrustPanel'
import { getMcpGuardReportForCwd, setMcpGuardReportForCwd } from '../mcp-trust-state'

const contextKey = (context: ProviderContext): string => `${context.providerId}\0${context.cwd ?? ''}`
export const capabilityMatchesContext = <T>(
  capability: CapabilityEnvelope<T> | null,
  context: ProviderContext
): capability is CapabilityEnvelope<T> =>
  capability !== null && contextKey(capability) === contextKey(context)
const modelKey = (model: AgentModelRef): string => `${model.providerId ?? ''}\0${model.id}`
const RUN_CONTROL_PREFERENCES_KEY = 'scry:run-control-preferences:v1'
const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'qoder', 'opencode']

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
      const models = (Array.isArray(record.models) ? record.models : []).flatMap((model) => {
        const parsed = parseModelOption(model)
        return parsed ? [parsed] : []
      })
      const permissions = (Array.isArray(record.permissions) ? record.permissions : []).flatMap((permission) => {
        const parsed = parsePermissionOption(permission)
        return parsed ? [parsed] : []
      })
      if (models.length === 0 || permissions.length === 0) continue
      const context: ProviderContext = { providerId, ...(cwd ? { cwd } : {}) }
      cache.set(contextKey(context), {
        ...context,
        mode: 'read',
        // 上一次运行留下的目录只用于立刻渲染选项；运行权限仍要等本次 Provider 探测确认，保持 fail closed。
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
    : catalog.permissions.find((option) => option.id === 'default')?.id ??
      catalog.permissions[0]?.id ??
      'default'
  return { model, effort, permissionMode }
}

export async function authoritativeRefreshAfterToggle<T>(
  result: CapabilityEnvelope<boolean>,
  refresh: () => Promise<T>
): Promise<T | null> {
  return result.data === true ? refresh() : null
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
  return providerIdForAgentId(currentAgentId) !== providerIdForAgentId(nextAgentId)
}

export function runControlSendBlockedReason(
  capability: CapabilityEnvelope<AgentRunControlCatalog> | null,
  loading: boolean,
  controls: AgentRunControls
): string | null {
  const usesProviderDefaults =
    controls.permissionMode === 'default' &&
    controls.model == null &&
    controls.effort == null
  if (usesProviderDefaults && (
    (capability === null && loading) ||
    (capability?.state === 'unknown' && (capability.data?.models.length ?? 0) > 0)
  )) return null
  return !capability || capability.data == null ||
    (capability.state !== 'ready' && capability.state !== 'degraded')
    ? capability?.reason ?? '运行权限能力尚未确认，暂不能发送'
    : null
}

export function requestRunControlsForSelectedProvider<T>(
  providerId: ProviderId,
  cwd: string | null,
  request: (context: ProviderContext) => Promise<T>
): Promise<T> {
  return request({ providerId, cwd: cwd ?? undefined })
}

export function useIntegrations(cwd: string | null) {
  const storedRunControlPreferences = useMemo(readRunControlPreferences, [])
  const initialProviderId = providerIdForAgentId(storedRunControlPreferences.selectedAgentId) ?? 'claude'
  const storedRunControlCatalogs = useMemo(readRunControlCatalogCache, [])
  const initialRunControlCatalog = storedRunControlCatalogs.get(
    contextKey({ providerId: initialProviderId, cwd: cwd ?? undefined })
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
  const [accountCapability, setAccountCapability] = useState<CapabilityEnvelope<AccountSnapshot> | null>(null)
  const [accountRefreshing, setAccountRefreshing] = useState(false)
  const [mcps, setMcps] = useState<McpMeta[]>([])
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatus>>({})
  const [mcpLive, setMcpLive] = useState<McpLiveStatus[]>([])
  const [mcpCapability, setMcpCapability] = useState<CapabilityEnvelope<McpSnapshot> | null>(null)
  const [mcpConfigRefreshing, setMcpConfigRefreshing] = useState(false)
  const [mcpRefreshing, setMcpRefreshing] = useState(false)
  const [usage, setUsage] = useState<UsageStats | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [billingState, setBillingState] = useState<BillingGuardianState | null>(null)
  const [billingSyncing, setBillingSyncing] = useState(false)
  const [billingFixtureLoading, setBillingFixtureLoading] = useState(false)
  const [mcpGuardReportsByCwd, setMcpGuardReportsByCwd] = useState<Record<string, McpGuardReport>>({})
  const [mcpGuardScanning, setMcpGuardScanning] = useState(false)
  const [gitDiff, setGitDiff] = useState<DiffFile[]>([])
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const cwdRef = useRef(cwd)
  const gitDiffRequestSeq = useRef(0)
  const integrationRequestSeq = useRef(0)
  const usageRequestSeq = useRef(0)
  const skillRefreshRequestSeq = useRef(0)
  const accountRequestSeq = useRef(0)
  const mcpConfigRequestSeq = useRef(0)
  const mcpLiveRequestSeq = useRef(0)
  const mcpTestCounter = useRef(0)
  const mcpTestRequests = useRef(new Map<string, number>())
  const mcpAuthCounter = useRef(0)
  const mcpAuthRequests = useRef(new Map<string, number>())
  const mcpToggleCounter = useRef(0)
  const mcpToggleRequests = useRef(new Map<string, number>())
  const mcpConfigPromiseRef = useRef<Promise<McpLiveStatus[]> | null>(null)
  const runControlRequestSeq = useRef(0)
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
            runControlCatalogByContext.current.set(key, result)
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
    () => ({ providerId: selectedProviderId, cwd: cwd ?? undefined }),
    [cwd, selectedProviderId]
  )
  const providerContextRef = useRef(providerContext)
  const trustKey = `${providerContext.providerId}:${cwd ?? ''}`
  const mcpGuardReport = useMemo(
    () => getMcpGuardReportForCwd(mcpGuardReportsByCwd, trustKey),
    [mcpGuardReportsByCwd, trustKey]
  )

  const rescan = useCallback((): void => {
    setAgentsScanning(true)
    window.scry
      .detect()
      .then((detected) => {
        setAgents(detected)
        setSelectedId((current) =>
          detected.length && !detected.find((agent) => agent.id === current) ? detected[0].id : current
        )
      })
      .catch(() => {})
      .finally(() => setAgentsScanning(false))
  }, [])

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

  const loadDiag = useCallback((): void => {
    if (typeof window.scry.diagnostics === 'function') window.scry.diagnostics().then(setDiag).catch(() => {})
  }, [])

  const refreshSkills = useCallback(async (): Promise<void> => {
    const context = providerContextRef.current
    const seq = ++skillRefreshRequestSeq.current
    setSkillsRefreshing(true)
    try {
      const result = await window.scry.listSkills(context)
      if (seq !== skillRefreshRequestSeq.current || contextKey(context) !== contextKey(providerContextRef.current)) return
      setSkillCapability(result)
      if (result.data) setSkills(result.data)
    } catch {
      // 后台刷新失败时保留当前缓存；用户仍可再次点刷新。
    } finally {
      if (seq === skillRefreshRequestSeq.current) setSkillsRefreshing(false)
    }
  }, [])

  const refreshAccount = useCallback(async (): Promise<void> => {
    const context = providerContextRef.current
    const seq = ++accountRequestSeq.current
    setAccountRefreshing(true)
    try {
      const result = await window.scry.providerAccount(context)
      if (seq !== accountRequestSeq.current || contextKey(context) !== contextKey(providerContextRef.current)) return
      setAccountCapability(result)
    } catch (error) {
      if (seq !== accountRequestSeq.current || contextKey(context) !== contextKey(providerContextRef.current)) return
      setAccountCapability({
        providerId: context.providerId,
        cwd: context.cwd,
        mode: 'none',
        state: 'unknown',
        data: null,
        reason: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (seq === accountRequestSeq.current) setAccountRefreshing(false)
    }
  }, [])

  const refreshProviderInventory = useCallback(async (): Promise<void> => {
    await Promise.all([refreshSkills(), refreshAccount()])
  }, [refreshAccount, refreshSkills])

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

  const toggleSkill = useCallback(async (name: string, enabled: boolean): Promise<void> => {
    const context = providerContextRef.current
    const result = await window.scry.toggleSkill(context, name, enabled)
    if (contextKey(context) !== contextKey(providerContextRef.current)) return
    setSkillCapability((current) => (current ? { ...current, state: result.state, reason: result.reason } : current))
    const refreshed = await authoritativeRefreshAfterToggle(result, () => window.scry.listSkills(context))
    if (!refreshed) return
    if (contextKey(context) !== contextKey(providerContextRef.current)) return
    setSkillCapability(refreshed)
    if (refreshed.data) setSkills(refreshed.data)
  }, [])

  const toggleMcp = useCallback(
    async (name: string, enabled: boolean): Promise<void> => {
      const context = providerContextRef.current
      const key = `${contextKey(context)}\0${name}`
      const seq = ++mcpToggleCounter.current
      mcpToggleRequests.current.set(key, seq)
      const result = await window.scry.toggleMcp(context, name, enabled)
      if (mcpToggleRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      if (result.data !== true) return
      setMcps((prev) => prev.map((mcp) => (mcp.name === name ? { ...mcp, enabled } : mcp)))
      setMcpLive((prev) => updateMcpLiveAfterToggle(prev, name, enabled))
      const refreshed = await authoritativeRefreshAfterToggle(result, () => window.scry.mcpSnapshot(context, false))
      if (
        refreshed &&
        mcpToggleRequests.current.get(key) === seq &&
        contextKey(context) === contextKey(providerContextRef.current)
      ) applyMcpSnapshot(refreshed)
    },
    [applyMcpSnapshot]
  )

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
    loadStats()
    loadBillingState()
    loadGitDiff()
    loadDiag()
  }, [loadBillingState, loadDiag, loadGitDiff, loadStats, loadUsage])

  const setRunModel = useCallback((model: AgentModelRef | undefined): void => {
    setRunControls((current) => {
      const next = { ...current, model, effort: undefined }
      runControlsByProvider.current.set(selectedProviderId, next)
      return next
    })
  }, [selectedProviderId])

  const setRunEffort = useCallback((effort: string | undefined): void => {
    setRunControls((current) => {
      const next = { ...current, effort }
      runControlsByProvider.current.set(selectedProviderId, next)
      return next
    })
  }, [selectedProviderId])

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
    const seq = ++integrationRequestSeq.current
    ++usageRequestSeq.current
    setUsage(null)
    const skillSeq = ++skillRefreshRequestSeq.current
    ++accountRequestSeq.current
    ++mcpConfigRequestSeq.current
    ++mcpLiveRequestSeq.current
    mcpTestRequests.current.clear()
    mcpAuthRequests.current.clear()
    mcpToggleRequests.current.clear()
    mcpConfigPromiseRef.current = null
    setSkills([])
    setMcps([])
    setMcpStatus({})
    setMcpLive([])
    setSkillCapability(null)
    setSkillsRefreshing(true)
    setAccountCapability(null)
    setAccountRefreshing(true)
    setMcpCapability(null)
    setMcpConfigRefreshing(false)
    setMcpRefreshing(false)
    loadGitDiff(cwd)
    void window.scry.listSkills(providerContext)
      .then((skillResult) => {
        if (seq !== integrationRequestSeq.current || contextKey(providerContext) !== contextKey(providerContextRef.current)) return
        setSkillCapability(skillResult)
        if (skillResult.data) setSkills(skillResult.data)
      })
      .catch(() => {})
      .finally(() => {
        if (seq === integrationRequestSeq.current && skillSeq === skillRefreshRequestSeq.current) {
          setSkillsRefreshing(false)
        }
      })
    void refreshAccount()
    void refreshMcp().catch(() => {})
    if (cwd) loadUsage()
  }, [cwd, loadGitDiff, loadUsage, providerContext, refreshAccount, refreshMcp])

  useEffect(() => {
    const seq = ++runControlRequestSeq.current
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
      return
    }
    void requestRunControlsForSelectedProvider(selectedProviderId, cwd, requestRunControlCatalog)
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
        if (seq === runControlRequestSeq.current) setRunControlsLoading(false)
      })
  }, [cwd, providerContext, requestRunControlCatalog, selectedProviderId])

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
    let cancelled = false
    const fast = typeof window.scry.detectFast === 'function' ? window.scry.detectFast() : Promise.resolve([])
    void fast
      .then((detected) => {
        if (!cancelled && detected.length > 0) setAgents(detected)
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return
        setAgentsHydrated(true)
        rescan()
      })
    return () => {
      cancelled = true
    }
  }, [rescan])

  useEffect(() => {
    const timers = [
      window.setTimeout(loadUsage, 260),
      window.setTimeout(loadStats, 900),
      window.setTimeout(loadBillingState, 980),
      window.setTimeout(loadDiag, 1100)
    ]
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [loadBillingState, loadDiag, loadStats, loadUsage])

  const currentSkillCapability = capabilityMatchesContext(skillCapability, providerContext)
    ? skillCapability
    : null
  const currentAccountCapability = capabilityMatchesContext(accountCapability, providerContext)
    ? accountCapability
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
    runControls,
    runControlCatalog,
    runControlCapability,
    runControlsLoading,
    setRunModel,
    setRunEffort,
    setPermissionMode,
    skills: currentSkillCapability ? skills : [],
    skillCapability: currentSkillCapability,
    skillsRefreshing,
    accountCapability: currentAccountCapability,
    accountRefreshing,
    mcps,
    mcpStatus,
    mcpLive,
    mcpCapability,
    mcpConfigRefreshing,
    mcpRefreshing,
    usage,
    stats,
    billingState,
    billingSyncing,
    billingFixtureLoading,
    mcpGuardReport,
    mcpGuardScanning,
    gitDiff,
    diag,
    rescan,
    refreshSkills,
    refreshAccount,
    refreshProviderInventory,
    loadMcpLive,
    refreshMcp,
    pullMcpLive,
    toggleSkill,
    toggleMcp,
    testMcp,
    reauthenticateMcp,
    setCurrentMcpGuardReport,
    scanMcpGuard,
    syncBillingAdmin,
    importBillingFixture,
    loadStats,
    loadGitDiff,
    loadDiag,
    refreshAfterTurn
  }
}
