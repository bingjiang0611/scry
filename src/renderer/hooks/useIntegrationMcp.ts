import { INTEGRATION_COPY } from '../constants/integration-copy'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CapabilityEnvelope, McpSnapshot, ProviderContext } from '@shared/provider'
import type { McpLiveStatus } from '@shared/trace'
import type { McpMeta } from '../env'
import type { McpStatus } from '../format'
import type { McpGuardReport } from '../components/McpTrustPanel'
import { getMcpGuardReportForCwd, setMcpGuardReportForCwd } from '../mcp-trust-state'
import { contextKey } from './integration-controls'
import { mcpAuthVerificationError, mergeMcpLiveSnapshot, reconcileMcpAuthStatus } from './integration-derived'

export function useIntegrationMcp(
  cwd: string | null,
  providerContext: ProviderContext,
  providerContextRef: { current: ProviderContext },
  trustKey: string
) {
  const [mcps, setMcps] = useState<McpMeta[]>([])
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatus>>({})
  const [mcpLive, setMcpLive] = useState<McpLiveStatus[]>([])
  const [mcpCapability, setMcpCapability] = useState<CapabilityEnvelope<McpSnapshot> | null>(null)
  const [mcpConfigRefreshing, setMcpConfigRefreshing] = useState(false)
  const [mcpRefreshing, setMcpRefreshing] = useState(false)
  const [mcpGuardReportsByCwd, setMcpGuardReportsByCwd] = useState<Record<string, McpGuardReport>>({})
  const [mcpGuardScanning, setMcpGuardScanning] = useState(false)
  const mcpConfigRequestSeq = useRef(0)
  const mcpLiveRequestSeq = useRef(0)
  const mcpTestCounter = useRef(0)
  const mcpTestRequests = useRef(new Map<string, number>())
  const mcpAuthCounter = useRef(0)
  const mcpAuthRequests = useRef(new Map<string, number>())
  const mcpConfigPromiseRef = useRef<Promise<McpLiveStatus[]> | null>(null)

  useEffect(() => {
    ++mcpConfigRequestSeq.current
    ++mcpLiveRequestSeq.current
    mcpTestRequests.current.clear()
    mcpAuthRequests.current.clear()
    mcpConfigPromiseRef.current = null
    setMcps([])
    setMcpStatus({})
    setMcpLive([])
    setMcpCapability(null)
    setMcpConfigRefreshing(false)
    setMcpRefreshing(false)
  }, [providerContext])

  const applyMcpSnapshot = useCallback((result: CapabilityEnvelope<McpSnapshot>, clearUnknownRuntime = false): McpLiveStatus[] => {
    setMcpCapability(result)
    if (!result.data) {
      if (clearUnknownRuntime) setMcpLive([])
      return []
    }
    setMcps(result.data.configured)
    setMcpLive((current) => mergeMcpLiveSnapshot(current, result.data?.runtime, clearUnknownRuntime))
    if (result.data.runtime) setMcpStatus((current) => reconcileMcpAuthStatus(current, result.data!.configured, result.data!.runtime!))
    return result.data.runtime ?? []
  }, [])

  const loadMcpLive = useCallback(async (): Promise<McpLiveStatus[]> => {
    const context = providerContextRef.current
    const result = await window.scry.mcpSnapshot(context)
    return contextKey(context) === contextKey(providerContextRef.current) ? applyMcpSnapshot(result) : []
  }, [applyMcpSnapshot, providerContextRef])

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
      if (seq === mcpLiveRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) applyMcpSnapshot(result, true)
    } catch (error) {
      if (seq === mcpLiveRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) {
        setMcpLive([])
        setMcpCapability((current) => ({
          providerId: context.providerId,
          cwd: context.cwd,
          mode: current?.providerId === context.providerId ? current.mode : 'none',
          state: 'unknown',
          data: current?.providerId === context.providerId && current.data ? { ...current.data, runtime: null } : null,
          reason: error instanceof Error ? error.message : String(error)
        }))
      }
    } finally {
      if (seq === mcpLiveRequestSeq.current) setMcpRefreshing(false)
    }
  }, [applyMcpSnapshot, providerContextRef])

  const testMcp = useCallback(async (targetId: string): Promise<void> => {
    const context = providerContextRef.current
    const key = `${contextKey(context)}\0${targetId}`
    const seq = ++mcpTestCounter.current
    mcpTestRequests.current.set(key, seq)
    setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], testing: true } }))
    try {
      const result = await window.scry.testMcp(context, targetId)
      if (mcpTestRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], ...(result.data ?? { ok: false, error: result.reason ?? INTEGRATION_COPY.mcpTestUnavailable }), testing: false } }))
    } catch (error) {
      if (mcpTestRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], ok: false, error: error instanceof Error ? error.message : String(error), testing: false } }))
    }
  }, [providerContextRef])

  const reauthenticateMcp = useCallback(async (targetId: string): Promise<void> => {
    const context = providerContextRef.current
    const key = `${contextKey(context)}\0${targetId}`
    const seq = ++mcpAuthCounter.current
    mcpAuthRequests.current.set(key, seq)
    setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], authenticating: true, authOk: undefined, authError: undefined } }))
    try {
      const result = await window.scry.reauthenticateMcp(context, targetId)
      if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      if (!result.data?.ok) {
        const authenticated = result.data?.status === 'authenticated-unverified'
        setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], authenticating: false, authOk: authenticated, authError: result.data?.error ?? result.reason ?? INTEGRATION_COPY.mcpAuthFailed } }))
        return
      }
      setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], authenticating: false, authOk: true, authError: undefined } }))
      let refreshed: CapabilityEnvelope<McpSnapshot>
      try {
        refreshed = await window.scry.mcpSnapshot(context, true)
      } catch (error) {
        if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
        setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], authenticating: false, authOk: true, authError: error instanceof Error ? error.message : String(error) } }))
        return
      }
      if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      applyMcpSnapshot(refreshed, true)
      const verificationError = refreshed.data ? mcpAuthVerificationError(refreshed.data, targetId) : refreshed.reason ?? INTEGRATION_COPY.runtimeRefreshFailed
      setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], authenticating: false, authOk: true, authError: verificationError } }))
    } catch (error) {
      if (mcpAuthRequests.current.get(key) !== seq || contextKey(context) !== contextKey(providerContextRef.current)) return
      setMcpStatus((prev) => ({ ...prev, [targetId]: { ...prev[targetId], authenticating: false, authOk: false, authError: error instanceof Error ? error.message : String(error) } }))
    }
  }, [applyMcpSnapshot, providerContextRef])

  const mcpGuardReport = useMemo(() => getMcpGuardReportForCwd(mcpGuardReportsByCwd, trustKey), [mcpGuardReportsByCwd, trustKey])
  const setCurrentMcpGuardReport = useCallback((report: McpGuardReport): void => {
    setMcpGuardReportsByCwd((reportsByCwd) => setMcpGuardReportForCwd(reportsByCwd, trustKey, report))
  }, [trustKey])
  const scanMcpGuard = useCallback(async (): Promise<McpGuardReport> => {
    if (!cwd) throw new Error(INTEGRATION_COPY.mcpWorkspaceMissing)
    setMcpGuardScanning(true)
    try {
      const result = await window.scry.mcpGuardScan(providerContextRef.current)
      if (!result.data) throw new Error(result.reason ?? INTEGRATION_COPY.mcpGuardUnavailable)
      return result.data
    } finally {
      setMcpGuardScanning(false)
    }
  }, [cwd, providerContextRef])

  return {
    mcps,
    mcpStatus,
    mcpLive,
    mcpCapability,
    mcpConfigRefreshing,
    mcpRefreshing,
    mcpGuardReport,
    mcpGuardScanning,
    loadMcpLive,
    refreshMcp,
    pullMcpLive,
    testMcp,
    reauthenticateMcp,
    setCurrentMcpGuardReport,
    scanMcpGuard
  }
}
