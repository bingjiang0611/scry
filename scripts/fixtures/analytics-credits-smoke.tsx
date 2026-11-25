import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnalyticsView } from '../../src/renderer/components/AnalyticsView'
import type { UsageAnalytics, UsageAnalyticsRangeDays } from '../../src/shared/trace'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/analytics-page.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/codex-alignment.css'

type PerformanceFixture = { history: { rows: unknown[]; invalidLines: number; truncated: boolean }, summary: { observedAt: string, sessions: unknown[] } }

declare global {
  interface Window {
    setCreditsFixture: (analytics: UsageAnalytics) => void
    setPerformanceFixture: (next: PerformanceFixture) => void
  }
}

function Fixture() {
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null)
  const [range, setRange] = useState<UsageAnalyticsRangeDays>(7)
  const [refreshes, setRefreshes] = useState(0)
  window.setCreditsFixture = setAnalytics
  return <div style={{ height: '100vh', width: '100vw', overflow: 'auto' }}>
    <output id="fixture-status" data-range={range} data-refreshes={refreshes} />
    <AnalyticsView analytics={analytics} rangeDays={range} loading={!analytics} error={null}
      onRangeChange={setRange} onRefresh={() => setRefreshes((value) => value + 1)} />
  </div>
}

// 默认给空桥；需要看真实性能数据时用 window.setPerformanceFixture 注入。
let performance: PerformanceFixture = {
  history: { rows: [], invalidLines: 0, truncated: false },
  summary: { observedAt: new Date().toISOString(), sessions: [] }
}
const dataListeners = new Set<() => void>()
// 注入后要像真实数据更新那样通知页面重新读取，否则页面永远停在首屏的空结果。
Object.defineProperty(window, 'setPerformanceFixture', { value: (next: PerformanceFixture) => {
  performance = next
  for (const listener of dataListeners) listener()
} })
Object.defineProperty(window, 'scry', {
  value: {
    llmPerformanceHistory: async () => performance.history,
    llmPerformanceSummary: async () => performance.summary,
    onDataUpdated: (listener: () => void) => { dataListeners.add(listener); return () => { dataListeners.delete(listener) } }
  }
})
createRoot(document.getElementById('root')!).render(<Fixture />)
