import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BillingGuardianState } from '@shared/billing'
import type { CapabilityEnvelope, McpSnapshot, ProviderContext, ProviderId } from '@shared/provider'
import type { DbStats, Diagnostics, DiffFile, McpLiveStatus } from '@shared/trace'
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
const modelKey = (model: AgentModelRef): string => `${model.providerId ?? ''}\0${model.id}`

const fallbackRunControlCatalog = (permissionMode: AgentPermissionMode): AgentRunControlCatalog => ({
  models: [],
  permissions: [{
    id: permissionMode,
    label: permissionMode === 'full_access' ? '完全访问' : '默认审批',
    description: permissionMode === 'full_access' ? '兼容旧版运行控制' : '危险操作会暂停并请求你的确认'
  }]
})

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
      'full_access'
  return { model, effort, permissionMode }
}

export async function authoritativeRefreshAfterToggle<T>(
  result: CapabilityEnvelope<boolean>,
  refresh: () => Promise<T>
): Promise<T | null> {
  return result.data === true ? refresh() : null
}

export function useIntegrations(cwd: string | null) {
  const [agents, setAgents] = useState<DetectedAgent[]>([])
  const [agentsHydrated, setAgentsHydrated] = useState(false)
  const [agentsScanning, setAgentsScanning] = useState(true)
  const [selectedId, setSelectedId] = useState('claude')
  const [backend, setBackend] = useState<'local' | 'api'>('local')
  const [runControls, setRunControls] = useState<AgentRunControls>({ permissionMode: 'default' })
  const [runControlCatalog, setRunControlCatalog] = useState<AgentRunControlCatalog>(
    fallbackRunControlCatalog('default')
  )
  const [runControlCapability, setRunControlCapability] =
    useState<CapabilityEnvelope<AgentRunControlCatalog> | null>(null)
  const [runControlsLoading, setRunControlsLoading] = useState(false)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [skillCapability, setSkillCapability] = useState<CapabilityEnvelope<SkillMeta[]> | null>(null)
  const [mcps, setMcps] = useState<McpMeta[]>([])
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatus>>({})
  const [mcpLive, setMcpLive] = useState<McpLiveStatus[]>([])
  const [mcpCapability, setMcpCapability] = useState<CapabilityEnvelope<McpSnapshot> | null>(null)
  const [mcpRefreshing, setMcpRefreshing] = useState(false)
  const [usage, setUsage] = useState<{ cost: number | null; tin: number | null; tout: number | null; turns: number } | null>(null)
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
  const runControlRequestSeq = useRef(0)
  const runControlsByProvider = useRef(new Map<ProviderId, AgentRunControls>())

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
    window.scry.usageStats(providerContextRef.current).then(setUsage)
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
    const result = await window.scry.listSkills(context)
    if (contextKey(context) !== contextKey(providerContextRef.current)) return
    setSkillCapability(result)
    if (result.data) setSkills(result.data)
  }, [])

  const applyMcpSnapshot = useCallback((result: CapabilityEnvelope<McpSnapshot>): McpLiveStatus[] => {
    setMcpCapability(result)
    if (!result.data) return []
    setMcps(result.data.configured)
    setMcpLive(result.data.runtime ?? [])
    return result.data.runtime ?? []
  }, [])

  const loadMcpLive = useCallback(async (): Promise<McpLiveStatus[]> => {
    const context = providerContextRef.current
    const result = await window.scry.mcpSnapshot(context)
    return contextKey(context) === contextKey(providerContextRef.current) ? applyMcpSnapshot(result) : []
  }, [applyMcpSnapshot])

  const refreshMcp = useCallback(async (): Promise<McpLiveStatus[]> => loadMcpLive(), [loadMcpLive])

  const pullMcpLive = useCallback(async (): Promise<void> => {
    const context = providerContextRef.current
    setMcpRefreshing(true)
    try {
      const result = await window.scry.mcpSnapshot(context, true)
      if (contextKey(context) === contextKey(providerContextRef.current)) applyMcpSnapshot(result)
    } finally {
      setMcpRefreshing(false)
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
      const result = await window.scry.toggleMcp(context, name, enabled)
      if (contextKey(context) !== contextKey(providerContextRef.current)) return
      if (result.data !== true) return
      setMcps((prev) => prev.map((mcp) => (mcp.name === name ? { ...mcp, enabled } : mcp)))
      setMcpLive((prev) => updateMcpLiveAfterToggle(prev, name, enabled))
      const refreshed = await authoritativeRefreshAfterToggle(result, () => window.scry.mcpSnapshot(context, true))
      if (refreshed && contextKey(context) === contextKey(providerContextRef.current)) applyMcpSnapshot(refreshed)
    },
    [applyMcpSnapshot]
  )

  const testMcp = useCallback(async (name: string): Promise<void> => {
    setMcpStatus((prev) => ({ ...prev, [name]: { testing: true } }))
    const result = await window.scry.testMcp(providerContextRef.current, name)
    setMcpStatus((prev) => ({
      ...prev,
      [name]: { ...(result.data ?? { ok: false, error: result.reason ?? '当前 Provider 不支持 MCP 测试' }), testing: false }
    }))
  }, [])

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
    void loadMcpLive()
  }, [loadBillingState, loadDiag, loadGitDiff, loadMcpLive, loadStats, loadUsage])

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
    const providerId = providerIdForAgentId(agentId) ?? 'claude'
    const stored = runControlsByProvider.current.get(providerId) ?? { permissionMode: 'default' as const }
    const loadingCatalog = fallbackRunControlCatalog('default')
    setSelectedId(agentId)
    setRunControlCatalog(loadingCatalog)
    setRunControls(resolveRunControlSelection(loadingCatalog, stored))
    setRunControlsLoading(true)
  }, [])

  useEffect(() => {
    cwdRef.current = cwd
    providerContextRef.current = providerContext
    const seq = ++integrationRequestSeq.current
    setSkills([])
    setMcps([])
    setMcpLive([])
    setSkillCapability(null)
    setMcpCapability(null)
    loadGitDiff(cwd)
    if (!cwd) return
    Promise.all([window.scry.listSkills(providerContext), window.scry.mcpSnapshot(providerContext), window.scry.usageStats(providerContext)])
      .then(([skillResult, mcpResult, nextUsage]) => {
        if (seq !== integrationRequestSeq.current || contextKey(providerContext) !== contextKey(providerContextRef.current)) return
        setSkillCapability(skillResult)
        if (skillResult.data) setSkills(skillResult.data)
        applyMcpSnapshot(mcpResult)
        setUsage(nextUsage)
      })
      .catch(() => {})
  }, [applyMcpSnapshot, cwd, loadGitDiff, providerContext])

  useEffect(() => {
    const seq = ++runControlRequestSeq.current
    const context = providerContext
    const stored = runControlsByProvider.current.get(selectedProviderId) ?? { permissionMode: 'default' as const }
    const fn = window.scry.runControls
    setRunControlsLoading(true)
    setRunControlCapability(null)
    if (!cwd || typeof fn !== 'function') {
      const fallback = fallbackRunControlCatalog(typeof fn === 'function' ? 'default' : 'full_access')
      const next = resolveRunControlSelection(fallback, stored)
      runControlsByProvider.current.set(selectedProviderId, next)
      setRunControlCatalog(fallback)
      setRunControls(next)
      setRunControlsLoading(false)
      return
    }
    void fn(context)
      .then((result) => {
        if (
          seq !== runControlRequestSeq.current ||
          contextKey(context) !== contextKey(providerContextRef.current)
        ) return
        const catalog = result.data ?? fallbackRunControlCatalog('full_access')
        const next = resolveRunControlSelection(catalog, stored)
        runControlsByProvider.current.set(selectedProviderId, next)
        setRunControlCapability(result)
        setRunControlCatalog(catalog)
        setRunControls(next)
      })
      .catch(() => {
        if (seq !== runControlRequestSeq.current) return
        const fallback = fallbackRunControlCatalog('full_access')
        const next = resolveRunControlSelection(fallback, stored)
        runControlsByProvider.current.set(selectedProviderId, next)
        setRunControlCatalog(fallback)
        setRunControls(next)
      })
      .finally(() => {
        if (seq === runControlRequestSeq.current) setRunControlsLoading(false)
      })
  }, [cwd, providerContext, selectedProviderId])

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
    backend,
    setBackend,
    runControls,
    runControlCatalog,
    runControlCapability,
    runControlsLoading,
    setRunModel,
    setRunEffort,
    setPermissionMode,
    skills,
    skillCapability,
    mcps,
    mcpStatus,
    mcpLive,
    mcpCapability,
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
    loadMcpLive,
    refreshMcp,
    pullMcpLive,
    toggleSkill,
    toggleMcp,
    testMcp,
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
