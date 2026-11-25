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

declare global {
  interface Window { setCreditsFixture: (analytics: UsageAnalytics) => void }
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

// 合并后的页面默认打开性能标签；这个 fixture 只关心账本侧，给性能接口一个空桥。
Object.defineProperty(window, 'scry', {
  value: {
    llmPerformanceHistory: async () => ({ rows: [], invalidLines: 0, truncated: false }),
    llmPerformanceSummary: async () => ({ observedAt: new Date().toISOString(), sessions: [] }),
    onDataUpdated: () => () => {}
  }
})
createRoot(document.getElementById('root')!).render(<Fixture />)
