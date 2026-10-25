import { INTEGRATION_COPY } from '../constants/integration-copy'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BillingGuardianState } from '@shared/billing'
import type { ProviderContext } from '@shared/provider'
import type { UsageAnalytics, UsageAnalyticsRangeDays, UsageStats, DbStats, WorkspaceDiffResult } from '@shared/trace'
import { contextKey } from './integration-controls'

export function useIntegrationMetrics(
  cwd: string | null,
  providerContext: ProviderContext,
  providerContextRef: { current: ProviderContext }
) {
  const [usage, setUsage] = useState<UsageStats | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null)
  const [analyticsRange, setAnalyticsRangeState] = useState<UsageAnalyticsRangeDays>(30)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [billingState, setBillingState] = useState<BillingGuardianState | null>(null)
  const [billingSyncing, setBillingSyncing] = useState(false)
  const [billingFixtureLoading, setBillingFixtureLoading] = useState(false)
  const [gitDiff, setGitDiff] = useState<WorkspaceDiffResult | null>()
  const [gitDiffRefreshing, setGitDiffRefreshing] = useState(false)
  const gitDiffCwdRef = useRef<string | null>(null)
  const gitDiffRequestSeq = useRef(0)
  const usageRequestSeq = useRef(0)
  const analyticsRequestSeq = useRef(0)
  const analyticsRangeRef = useRef<UsageAnalyticsRangeDays>(30)
  const analyticsQueryInFlightRef = useRef(false)
  const analyticsActiveRef = useRef(false)
  const analyticsRefreshQueuedRef = useRef(false)
  const cwdRef = useRef(cwd)

  const loadUsage = useCallback((): void => {
    const context = providerContextRef.current
    const seq = ++usageRequestSeq.current
    window.scry.usageStats(context).then((next) => {
      if (seq === usageRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) setUsage(next)
    }).catch(() => {})
  }, [providerContextRef])

  const loadStats = useCallback((): void => {
    window.scry.stats().then(setStats)
  }, [])

  const loadAnalytics = useCallback((rangeDays = analyticsRangeRef.current): void => {
    analyticsActiveRef.current = true
    const query = window.scry.usageAnalytics
    if (typeof query !== 'function') {
      setAnalyticsError(INTEGRATION_COPY.analyticsUnavailable)
      return
    }
    if (analyticsQueryInFlightRef.current) {
      analyticsRefreshQueuedRef.current = true
      analyticsRequestSeq.current += 1
      return
    }
    analyticsQueryInFlightRef.current = true
    analyticsRefreshQueuedRef.current = false
    const seq = ++analyticsRequestSeq.current
    setAnalyticsLoading(true)
    setAnalyticsError(null)
    void query(rangeDays).then((result) => {
      if (seq !== analyticsRequestSeq.current) return
      setAnalytics(result)
      if (result.status === 'query_error') setAnalyticsError(INTEGRATION_COPY.analyticsQueryError)
      else if (result.status === 'unavailable') setAnalyticsError(INTEGRATION_COPY.sqliteUnavailable)
    }).catch((error) => {
      if (seq === analyticsRequestSeq.current) setAnalyticsError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
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
    try { setBillingState((await window.scry.syncBillingAdmin()).state) } finally { setBillingSyncing(false) }
  }, [])

  const importBillingFixture = useCallback(async (): Promise<void> => {
    if (typeof window.scry.importBillingFixture !== 'function') return
    setBillingFixtureLoading(true)
    try { setBillingState((await window.scry.importBillingFixture()).state) } finally { setBillingFixtureLoading(false) }
  }, [])

  const loadGitDiff = useCallback((dir = cwdRef.current): void => {
    const seq = ++gitDiffRequestSeq.current
    const sameWorkspace = gitDiffCwdRef.current === dir
    gitDiffCwdRef.current = dir
    if (dir && typeof window.scry.gitDiff === 'function') {
      if (!sameWorkspace) setGitDiff(null)
      setGitDiffRefreshing(true)
      window.scry.gitDiff(dir).then((diff) => {
        if (seq === gitDiffRequestSeq.current && cwdRef.current === dir) { setGitDiff(diff); setGitDiffRefreshing(false) }
      }).catch(() => {
        if (seq === gitDiffRequestSeq.current && cwdRef.current === dir) { setGitDiff({ status: 'failed', reason: 'request_failed', files: [] }); setGitDiffRefreshing(false) }
      })
    } else {
      setGitDiff(dir ? { status: 'unavailable', reason: 'request_failed', files: [] } : undefined)
      setGitDiffRefreshing(false)
    }
  }, [])

  useEffect(() => {
    cwdRef.current = cwd
    providerContextRef.current = providerContext
    ++usageRequestSeq.current
    setUsage(null)
    loadGitDiff(cwd)
    if (cwd) loadUsage()
  }, [cwd, loadGitDiff, loadUsage, providerContext, providerContextRef])

  useEffect(() => {
    const timers = [window.setTimeout(loadUsage, 260), window.setTimeout(loadStats, 900), window.setTimeout(loadBillingState, 980)]
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [loadAnalytics, loadBillingState, loadStats, loadUsage])

  return {
    usage,
    stats,
    analytics,
    analyticsRange,
    analyticsLoading,
    analyticsError,
    analyticsActiveRef,
    billingState,
    billingSyncing,
    billingFixtureLoading,
    gitDiff: gitDiffCwdRef.current === cwd ? gitDiff : undefined,
    gitDiffRefreshing: gitDiffCwdRef.current === cwd && gitDiffRefreshing,
    loadUsage,
    loadStats,
    loadAnalytics,
    setAnalyticsRange,
    loadBillingState,
    syncBillingAdmin,
    importBillingFixture,
    loadGitDiff
  }
}
