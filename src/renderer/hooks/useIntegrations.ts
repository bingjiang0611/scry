import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProviderCapabilities } from './useProviderCapabilities'
import { useUsageInsights } from './useUsageInsights'
import { useSessionModels } from './useSessionModels'
import type { CapabilityEnvelope, ProviderContext, ProviderId } from '@shared/provider'
import { useWorkspaceDiff } from './useWorkspaceDiff'
import {
  providerIdForAgentId,
  runtimeProviderForAgentId,
  type AgentModelRef,
  type AgentPermissionMode,
  type AgentRunControlCatalog,
  type AgentRunControls
} from '@shared/runtime'
import type { DetectedAgent, ProjectMeta } from '../env'
import { composerDraftKey } from '../composer-drafts'
import { selectedExternalSessionId } from '../session-selection'
import {
  contextKey, isAuthoritativeRunControlCatalog,
  resolveRunControlSelection, retainCachedRunControlCatalog, shouldKeepCachedRunControlCatalog,
  fallbackRunControlCatalog, readRunControlCatalogCache, readRunControlPreferences,
  writeRunControlCatalogCache, writeRunControlPreferences, PROVIDER_IDS
} from './integration-model'
import {
  reconcileSelectedAgentId, requestRunControlsForSelectedProvider,
  shouldResetRunControlCatalog
} from './integration-model'

export function useIntegrations(
  cwd: string | null,
  sessionId: string | null,
  projects: ProjectMeta[],
  capabilityView: 'skills' | 'mcp' | null
) {
  const { sessionModels, rememberSessionModel, restoreSessionModel, migrateSessionModel } = useSessionModels()
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
  const cwdRef = useRef(cwd)
  const { gitDiff, gitDiffRefreshing, loadGitDiff } = useWorkspaceDiff(cwd, cwdRef)
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
  const {
    usage, stats, analytics, analyticsRange, analyticsLoading, analyticsError,
    billingState, billingSyncing, billingFixtureLoading,
    loadUsage, loadStats, loadAnalytics, setAnalyticsRange,
    syncBillingAdmin, importBillingFixture, resetUsageContext, refreshAfterDataUpdate
  } = useUsageInsights(providerContextRef)
  const {
    skills, skillCapability, skillsRefreshing, mcps, mcpStatus, mcpLive, mcpCapability,
    mcpConfigRefreshing, mcpRefreshing, mcpGuardReport, mcpGuardScanning,
    refreshSkills, loadMcpLive, refreshMcp, pullMcpLive, testMcp, reauthenticateMcp,
    setCurrentMcpGuardReport, scanMcpGuard, resetCapabilityContext
  } = useProviderCapabilities(cwd, providerContext, providerContextRef)

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
    resetUsageContext()
    resetCapabilityContext()
    loadGitDiff(cwd)
    if (cwd) loadUsage()
  }, [cwd, loadGitDiff, loadUsage, providerContext, resetCapabilityContext, resetUsageContext])

  useEffect(() => {
    // Inventory is read for the visible page, not to decorate navigation.
    // Context changes still clear old evidence before loading the active view.
    if (capabilityView === 'skills') void refreshSkills()
    if (capabilityView === 'mcp') void refreshMcp().catch(() => { })
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
        refreshAfterDataUpdate()
      }, 100)
    })
    return () => {
      if (timer != null) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [refreshAfterDataUpdate])

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
      .catch(() => { })
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
    const timer = window.setTimeout(loadUsage, 260)
    return () => window.clearTimeout(timer)
  }, [loadUsage])

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
    skills,
    skillCapability,
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
    gitDiffRefreshing,
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

export {
  capabilityMatchesContext, capabilityRows, isAuthoritativeRunControlCatalog,
  parseRunControlCatalogCache, parseRunControlPreferences, retainCachedRunControlCatalog,
  resolveRunControlSelection, serializeRunControlCatalogCache, shouldKeepCachedRunControlCatalog,
  authoritativeRefreshAfterToggle, parseStoredRunControls
} from './integration-model'
export {
  providerCompatibilityNotice, reconcileSelectedAgentId, requestRunControlsForSelectedProvider,
  runControlSendBlockedReason, shouldResetRunControlCatalog
} from './integration-model'
export { applyDataUpdatedEffects } from './useUsageInsights'
export { mergeMcpLiveSnapshot, mcpAuthVerificationError, reconcileMcpAuthStatus } from './useProviderCapabilities'
export { parseSessionModels, recordedSessionModel } from './useSessionModels'
