import { useEffect, useRef, useState } from 'react'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '@shared/llm-performance'

export type LlmPerformanceData = {
  summary: LlmPerformanceSummary | null
  summaryError: boolean
  history: LlmPerformanceHistory | null
  historyError: boolean
  summaryRetrying: boolean
  historyRetrying: boolean
  retrySummary: () => void
  retryHistory: () => void
}

/**
 * 性能样本来自使用记录而不是账本：实时摘要每秒刷新，历史只在页面可见时读取，
 * 页面隐藏就停止轮询，避免后台空转。
 */
export function useLlmPerformanceData(active: boolean): LlmPerformanceData {
  const [summary, setSummary] = useState<LlmPerformanceSummary | null>(null)
  const [summaryError, setSummaryError] = useState(false)
  const [history, setHistory] = useState<LlmPerformanceHistory | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [summaryRetrying, setSummaryRetrying] = useState(false)
  const [historyRetrying, setHistoryRetrying] = useState(false)
  const retrySummary = useRef<(() => void) | null>(null)
  const retryHistory = useRef<(() => void) | null>(null)
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : !document.hidden)
  useEffect(() => {
    const changed = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  useEffect(() => {
    if (!active || !visible) return
    let current = true
    let timer: number | undefined
    let historyRequest = 0
    let summaryPending = false
    let summaryFailed = false
    const loadSummary = async (): Promise<void> => {
      if (summaryPending) return
      window.clearTimeout(timer)
      summaryPending = true
      try {
        const next = await window.scry.llmPerformanceSummary()
        if (current) { setSummary(next); setSummaryError(false) }
      } catch (error) {
        if (current) {
          if (!summaryFailed) console.error('[scry] performance summary read failed', error)
          summaryFailed = true
          setSummaryError(true)
        }
      } finally {
        summaryPending = false
        if (current) {
          setSummaryRetrying(false)
          timer = window.setTimeout(() => { void loadSummary() }, 1000)
        }
      }
    }
    const loadHistory = async (): Promise<void> => {
      const request = ++historyRequest
      try {
        const next = await window.scry.llmPerformanceHistory()
        if (current && request === historyRequest) { setHistory(next); setHistoryError(false) }
      } catch (error) {
        if (current && request === historyRequest) {
          console.error('[scry] performance history read failed', error)
          setHistoryError(true)
        }
      } finally {
        if (current && request === historyRequest) setHistoryRetrying(false)
      }
    }
    retrySummary.current = () => { setSummaryRetrying(true); void loadSummary() }
    retryHistory.current = () => { setHistoryRetrying(true); void loadHistory() }
    void loadSummary()
    void loadHistory()
    const unsubscribe = window.scry.onDataUpdated?.(() => { void loadHistory() })
    return () => {
      current = false; window.clearTimeout(timer); unsubscribe?.()
      retrySummary.current = null; retryHistory.current = null
    }
  }, [active, visible])
  return {
    summary, summaryError, history, historyError, summaryRetrying, historyRetrying,
    retrySummary: () => retrySummary.current?.(), retryHistory: () => retryHistory.current?.()
  }
}
