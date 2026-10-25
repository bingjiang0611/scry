import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { CapabilityEnvelope, McpSnapshot, ProviderContext } from '@shared/provider'
import type { McpLiveStatus } from '@shared/trace'
import type { McpMeta, SkillMeta } from '../env'
import type { McpStatus } from '../format'
import type { McpGuardReport } from '../components/McpTrustPanel'
import { getMcpGuardReportForCwd, setMcpGuardReportForCwd } from '../mcp-trust-state'
import { capabilityMatchesContext, capabilityRows, contextKey } from './integration-model'
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

export function useProviderCapabilities(
  cwd: string | null,
  providerContext: ProviderContext,
  providerContextRef: MutableRefObject<ProviderContext>
) {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [skillCapability, setSkillCapability] = useState<CapabilityEnvelope<SkillMeta[]> | null>(null)
  const [skillsRefreshing, setSkillsRefreshing] = useState(false)
  const [mcps, setMcps] = useState<McpMeta[]>([])
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatus>>({})
  const [mcpLive, setMcpLive] = useState<McpLiveStatus[]>([])
  const [mcpCapability, setMcpCapability] = useState<CapabilityEnvelope<McpSnapshot> | null>(null)
  const [mcpConfigRefreshing, setMcpConfigRefreshing] = useState(false)
  const [mcpRefreshing, setMcpRefreshing] = useState(false)
  const [mcpGuardReportsByCwd, setMcpGuardReportsByCwd] = useState<Record<string, McpGuardReport>>({})
  const [mcpGuardScanning, setMcpGuardScanning] = useState(false)
  const skillRefreshRequestSeq = useRef(0)
  const mcpConfigRequestSeq = useRef(0)
  const mcpLiveRequestSeq = useRef(0)
  const mcpTestCounter = useRef(0)
  const mcpTestRequests = useRef(new Map<string, number>())
  const mcpAuthCounter = useRef(0)
  const mcpAuthRequests = useRef(new Map<string, number>())
  const mcpConfigPromiseRef = useRef<Promise<McpLiveStatus[]> | null>(null)
  const trustKey = `${providerContext.providerId}:${providerContext.agentProfileId ?? ''}:${cwd ?? ''}`
  const mcpGuardReport = useMemo(
    () => getMcpGuardReportForCwd(mcpGuardReportsByCwd, trustKey),
    [mcpGuardReportsByCwd, trustKey]
  )

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


  // The coordinator invokes this after updating the shared context ref, before loading visible evidence.
  const resetCapabilityContext = useCallback((): void => {
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
  }, [])

  const currentSkillCapability = capabilityMatchesContext(skillCapability, providerContext)
    ? skillCapability
    : null

  return {
    skills: currentSkillCapability ? skills : [],
    skillCapability: currentSkillCapability,
    skillsRefreshing, mcps, mcpStatus, mcpLive, mcpCapability,
    mcpConfigRefreshing, mcpRefreshing, mcpGuardReport, mcpGuardScanning,
    refreshSkills, loadMcpLive, refreshMcp, pullMcpLive, testMcp, reauthenticateMcp,
    setCurrentMcpGuardReport, scanMcpGuard, resetCapabilityContext
  }
}
