import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { BillingGuardianState } from '@shared/billing'
import type { ProviderContext } from '@shared/provider'
import type { DbStats, UsageAnalytics, UsageAnalyticsRangeDays, UsageStats } from '@shared/trace'
import { contextKey } from './integration-model'
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

export function useUsageInsights(providerContextRef: MutableRefObject<ProviderContext>) {
  const [usage, setUsage] = useState<UsageStats | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null)
  const [analyticsRange, setAnalyticsRangeState] = useState<UsageAnalyticsRangeDays>(30)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [billingState, setBillingState] = useState<BillingGuardianState | null>(null)
  const [billingSyncing, setBillingSyncing] = useState(false)
  const [billingFixtureLoading, setBillingFixtureLoading] = useState(false)
  const usageRequestSeq = useRef(0)
  const analyticsRequestSeq = useRef(0)
  const analyticsRangeRef = useRef<UsageAnalyticsRangeDays>(30)
  const analyticsActiveRef = useRef(false)
  const analyticsQueryInFlightRef = useRef(false)
  const analyticsRefreshQueuedRef = useRef(false)
  const loadUsage = useCallback((): void => {
    const context = providerContextRef.current
    const seq = ++usageRequestSeq.current
    window.scry.usageStats(context)
      .then((next) => {
        if (seq === usageRequestSeq.current && contextKey(context) === contextKey(providerContextRef.current)) setUsage(next)
      })
      .catch(() => { })
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
    if (typeof window.scry.billingState === 'function') window.scry.billingState().then(setBillingState).catch(() => { })
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


  const resetUsageContext = useCallback((): void => {
    ++usageRequestSeq.current
    setUsage(null)
  }, [])
  const refreshAfterDataUpdate = useCallback((): void => {
    applyDataUpdatedEffects({
      loadStats, loadBillingState, loadAnalytics, analyticsActive: analyticsActiveRef.current
    })
  }, [loadAnalytics, loadBillingState, loadStats])

  return {
    usage, stats, analytics, analyticsRange, analyticsLoading, analyticsError,
    billingState, billingSyncing, billingFixtureLoading,
    loadUsage, loadStats, loadAnalytics, setAnalyticsRange, loadBillingState,
    syncBillingAdmin, importBillingFixture, resetUsageContext, refreshAfterDataUpdate
  }
}
