import assert from 'node:assert/strict'

/** Read-only production IPC in the existing isolated App; no remote billing sync. */
export async function checkAnalyticsIpcApp({ evaluate, readInputs }) {
  const calls = (await readInputs()).length
  const stats = await evaluate('window.scry.stats()')
  assert.equal(stats.status, 'ready')
  assert.ok(Array.isArray(stats.topTools) && Array.isArray(stats.byCwd))
  const analytics = await evaluate('window.scry.usageAnalytics(7)')
  assert.equal(analytics.status, 'ready')
  assert.equal(analytics.rangeDays, 7)
  const invalid = await evaluate(`window.scry.usageAnalytics(99).then(() => null, error => String(error.message))`)
  assert.match(invalid, /分析时间范围无效/)
  const history = await evaluate('window.scry.llmPerformanceHistory()')
  assert.ok(Array.isArray(history.rows))
  const live = await evaluate('window.scry.llmPerformanceSummary()')
  assert.ok(Array.isArray(live.sessions))
  assert.equal((await readInputs()).length, calls, 'analytics reads cannot dispatch a Provider')
  return { stats: stats.status, analytics: analytics.status, invalidRangeRejected: true,
    historyAndLiveShape: true, providerCallsUnchanged: true, remoteBillingSync: 'not exercised' }
}
