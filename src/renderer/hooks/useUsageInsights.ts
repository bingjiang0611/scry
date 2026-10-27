import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { BillingGuardianState } from '@shared/billing'
import type { ProviderContext } from '@shared/provider'
import type { DbStats, UsageAnalytics, UsageAnalyticsRangeDays, UsageStats } from '@shared/trace'
import { contextKey } from './integration-model'
import { INTEGRATION_COPY } from '../constants/integration-copy'
export function applyDataUpdatedEffects(effects: {
  loadAnalytics: () => void
  analyticsActive: boolean
}): void {
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
  const [analyticsCreditsLoading, setAnalyticsCreditsLoading] = useState(false)
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

  const loadAnalyticsCredits = useCallback((ledger: UsageAnalytics, rangeDays: UsageAnalyticsRangeDays, seq: number): void => {
    const query = window.scry.usageCredits
    // 账本快照已经可以显示；Credit 投影需要读原生 transcript，慢得多，只用于后续刷新，
    // 失败或跨域时保留账本快照，不把缺失的 Credit 伪造成已知值。
    if (typeof query !== 'function') return
    setAnalyticsCreditsLoading(true)
    void query(rangeDays)
      .then((enriched) => {
        if (seq !== analyticsRequestSeq.current) return
        if (enriched.status === 'ready' && enriched.rangeDays === ledger.rangeDays) setAnalytics(enriched)
      })
      .catch(() => { })
      .finally(() => {
        if (seq === analyticsRequestSeq.current) setAnalyticsCreditsLoading(false)
      })
  }, [])

  const loadAnalytics = useCallback((rangeDays = analyticsRangeRef.current): void => {
    analyticsActiveRef.current = true
    const query = window.scry.usageAnalytics
    if (typeof query !== 'function') {
      setAnalyticsError(INTEGRATION_COPY.analyticsUnavailable)
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
        if (result.status === 'query_error') setAnalyticsError(INTEGRATION_COPY.analyticsQueryError)
        else if (result.status === 'unavailable') setAnalyticsError(INTEGRATION_COPY.sqliteUnavailable)
        else loadAnalyticsCredits(result, rangeDays, seq)
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
    setAnalyticsCreditsLoading(false)
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
      loadAnalytics, analyticsActive: analyticsActiveRef.current
    })
  }, [loadAnalytics])

  return {
    usage, stats, analytics, analyticsRange, analyticsLoading, analyticsCreditsLoading, analyticsError,
    billingState, billingSyncing, billingFixtureLoading,
    loadUsage, loadStats, loadAnalytics, setAnalyticsRange, loadBillingState,
    syncBillingAdmin, importBillingFixture, resetUsageContext, refreshAfterDataUpdate
  }
}
