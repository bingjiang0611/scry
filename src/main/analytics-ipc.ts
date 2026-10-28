import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderContext } from '../shared/provider'
import type { ActiveRun } from '../shared/trace'
import { analyticsCopy } from '../shared/constants/analytics-copy'
import { summarizeRunningLlmSessions } from '../shared/llm-performance'
import { billingStateQuery, importBillingFixture, statsQuery, syncBillingAdmin, usageAnalyticsWithCreditsQuery } from './db'
import { warmShellEnv } from './claude-locate'
import { readLlmPerformanceHistory } from './llm-performance-history'
import { readUsageStats } from './usage-jsonl'

export function registerAnalyticsIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  userDataDir: () => string
  activeRuns: () => ActiveRun[]
}) {
  deps.handleTrusted('agent:stats', () => statsQuery())
  deps.handleTrusted('agent:llmPerformanceHistory', () => readLlmPerformanceHistory(deps.userDataDir()))
  deps.handleTrusted('agent:llmPerformanceSummary', () => summarizeRunningLlmSessions(deps.activeRuns()))
  deps.handleTrusted('agent:usageAnalytics', (_event, rangeDays: unknown) => {
    if (rangeDays !== 7 && rangeDays !== 30 && rangeDays !== 90) throw new Error(analyticsCopy.invalidRange)
    return usageAnalyticsWithCreditsQuery(rangeDays)
  })
  deps.handleTrusted('agent:billingState', async () => {
    await warmShellEnv()
    return billingStateQuery()
  })
  deps.handleTrusted('agent:syncBillingAdmin', async () => {
    await warmShellEnv()
    return syncBillingAdmin()
  })
  deps.handleTrusted('agent:importBillingFixture', async () => {
    await warmShellEnv()
    return importBillingFixture()
  })
  deps.handleTrusted('agent:usageStats', (_event, context?: ProviderContext) =>
    readUsageStats(deps.userDataDir(), context ? {
      providerId: context.providerId,
      agentProfileId: context.agentProfileId,
      cwd: context.cwd ?? ''
    } : {})
  )
}
