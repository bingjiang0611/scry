import type { IpcMainInvokeEvent } from 'electron'
import type { ActiveRun, UsageAnalyticsRangeDays } from '../../shared/trace'
import type { ProviderContext } from '../../shared/provider'
import { summarizeRunningLlmSessions } from '../../shared/llm-performance'
import { statsQuery, usageAnalyticsQuery, usageAnalyticsWithCreditsQuery } from '../db'
import { readUsageStats } from '../usage-jsonl'
import { readLlmPerformanceHistory } from '../llm-performance-history'
import { registerGitDiffIpc } from '../git'
import type { ProviderRegistry } from '../providers/registry'
import type { ChannelHandler, ChannelHandlers } from './startup-channels'

// Read-only query channels that both Electron main and the daemon serve (B4-L4): main
// registers them for the in-process App, the daemon answers them as local ops for an
// App whose runs and userData it owns. One implementation per channel, so the two
// answers cannot drift. No Electron values are used here: userData is passed in, and
// the run list is whichever registry owns the runs in this process.

/**
 * Usage totals (usage JSONL) and the SQLite ledger's analytics. Whatever the source
 * cannot answer stays explicit (`unavailable` / `query_error`, null totals) in the
 * query functions themselves; nothing here turns an absence into zeros.
 */
export function usageChannelHandlers(deps: { userDataDir: () => string }) {
  // Two-part answer: the SQLite ledger returns first (milliseconds); the Credit projection
  // reads native transcripts and can take seconds, so the renderer asks for it afterwards.
  const usageRange = (rangeDays: unknown): UsageAnalyticsRangeDays => {
    if (rangeDays !== 7 && rangeDays !== 30 && rangeDays !== 90) throw new Error('分析时间范围无效')
    return rangeDays
  }
  return {
    // B2-lite: cumulative usage aggregated from usage.jsonl.
    'agent:usageStats': (context?: ProviderContext) =>
      readUsageStats(deps.userDataDir(), context ? {
        providerId: context.providerId,
        agentProfileId: context.agentProfileId,
        cwd: context.cwd ?? ''
      } : {}),
    // B2: cross-session SQLite analysis (tool frequency, spend per directory).
    'agent:stats': () => statsQuery(),
    'agent:usageAnalytics': (rangeDays: unknown) => usageAnalyticsQuery(usageRange(rangeDays)),
    'agent:usageCredits': (rangeDays: unknown) => usageAnalyticsWithCreditsQuery(usageRange(rangeDays))
  } satisfies ChannelHandlers
}

/** LLM performance: recorded samples, and a summary of the runs this process owns. */
export function llmPerformanceChannelHandlers(deps: { userDataDir: () => string; activeRuns: () => ActiveRun[] }) {
  return {
    'agent:llmPerformanceHistory': () => readLlmPerformanceHistory(deps.userDataDir()),
    'agent:llmPerformanceSummary': () => summarizeRunningLlmSessions(deps.activeRuns())
  } satisfies ChannelHandlers
}

/**
 * The workspace's final git diff (vs HEAD) and its commit history, each read authorized
 * by `authorizeDirectory` on every call. The table keeps registerGitDiffIpc's per-table
 * in-flight sharing: one table per process, so main and the daemon never share reads.
 */
export function workspaceDiffChannelHandlers(authorizeDirectory: (cwd: string) => string): ChannelHandlers {
  const handlers: Record<string, ChannelHandler> = {}
  registerGitDiffIpc((channel, listener) => {
    // The listeners never read the IPC event; trust was checked before this table is reached.
    handlers[channel] = ((...args: unknown[]) =>
      (listener as (event: IpcMainInvokeEvent | undefined, ...values: unknown[]) => unknown)(undefined, ...args)) as ChannelHandler
  }, authorizeDirectory)
  return handlers
}

/** Installed Skills for one Provider context, queued with that Provider's auth operations. */
export function skillChannelHandlers(deps: {
  providerRegistry: Pick<ProviderRegistry, 'listSkills'>
  withProviderOperation: <T>(providerId: ProviderContext['providerId'], operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
}) {
  return {
    'agent:listSkills': (context: ProviderContext) =>
      deps.withProviderOperation(context.providerId, () => deps.providerRegistry.listSkills(context), context.agentProfileId)
  } satisfies ChannelHandlers
}
