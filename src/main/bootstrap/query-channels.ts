import type { IpcMainInvokeEvent } from 'electron'
import type { ActiveRun, UsageAnalyticsRangeDays } from '../../shared/trace'
import type { ProviderContext } from '../../shared/provider'
import { summarizeRunningLlmSessions } from '../../shared/llm-performance'
import { statsQuery, usageAnalyticsQuery, usageAnalyticsWithCreditsQuery } from '../db'
import { readUsageStats } from '../usage-jsonl'
import { readLlmPerformanceHistory } from '../llm-performance-history'
import { registerGitDiffIpc } from '../git'
import { readAppTraceContentPage } from '../trace-tool-content'
import { resolveRecorderLocation } from '../../core/turn-recorder/config'
import { readAuthorizedRecorderContentPage } from '../recorder-content-access'
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

/** The Provider's command catalog, queued like Skills; its envelope travels whole. */
export function providerCommandChannelHandlers(deps: {
  providerRegistry: Pick<ProviderRegistry, 'listCommands'>
  withProviderOperation: <T>(providerId: ProviderContext['providerId'], operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
}) {
  return {
    // An unavailable catalog stays `data: null` with its reason, never an empty list.
    'agent:listCommands': (context: ProviderContext) =>
      deps.withProviderOperation(context.providerId, () => deps.providerRegistry.listCommands(context), context.agentProfileId)
  } satisfies ChannelHandlers
}

/**
 * Recorder and App trace content pages for the window's workspace. The renderer never
 * names that workspace: main reads its own selection (agent:setCwd) and ignores any extra
 * argument; the daemon takes the one its App appended and re-validates it against its own
 * project authority. `''` is "no workspace", which app-trace bodies of runs without a cwd
 * still allow, as main always did.
 */
export function recorderContentChannelHandlers(deps: {
  userDataDir: () => string
  /** The workspace to read for; given the argument after the request, which only the daemon trusts. */
  workspace: (appended: unknown) => string
  /** Whether that workspace is still selected. The daemon answers true; its App checks after the reply. */
  stillCurrent: (cwd: string) => boolean
}) {
  return {
    'agent:recorderContentPage': async (request: unknown, appended?: unknown) => {
      const cwd = deps.workspace(appended)
      if (request && typeof request === 'object' && 'source' in request) {
        if (request.source !== 'app-trace') throw new Error('invalid_content_source')
        const page = await readAppTraceContentPage(deps.userDataDir(), cwd, request)
        if (!deps.stillCurrent(cwd)) throw new Error('recorder_workspace_changed')
        return page
      }
      if (!cwd) throw new Error('recorder_workspace_unavailable')
      // Reading is authorized by the selected workspace's validated recorder location and record
      // references, not by the current enablement flag. Existing evidence remains inspectable when
      // capture is disabled or a sentinel is present; no path supplied by the renderer is opened.
      const location = await resolveRecorderLocation(cwd)
      if (!deps.stillCurrent(cwd)) throw new Error('recorder_workspace_changed')
      if (!location.valid) throw new Error(`recorder_unavailable:${location.reason}`)
      return readAuthorizedRecorderContentPage(location.dataRoot, request)
    }
  } satisfies ChannelHandlers
}
