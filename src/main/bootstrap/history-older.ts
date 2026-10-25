import type { IpcMainInvokeEvent } from 'electron'
import type { ParsedTurn } from '../normalize'
import type { ProviderContext, ProviderId } from '../../shared/provider'
import type { TraceArchive } from '../transcript-archive'
import type { LoadedSessionTurn, SessionHistoryPage, SessionHistoryPageRequest } from '../session-history'
import { readTraceArchivePageAsync, readTraceArchiveTurnsAsync } from '../transcript-archive'
import { mergeSessionTurns, hydrateSessionHistoryPage, sessionHistoryPage } from '../session-history'
import { persistTraceToolEvents } from '../trace-tool-content'
import type { ProviderRegistry } from '../providers/registry'
import { PerformanceTrace } from '../performance-timing'
import { historyCopy } from '../../shared/constants/copy'
import { loadClaudeHookConfig } from '../hook-config'

export type SessionHistoryCache = {
  revision: number
  key: string
  turns: LoadedSessionTurn[]
  transcriptTurns: ParsedTurn[]
  archive: TraceArchive | null
  context: { userDataDir: string }
  archiveSource?: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId }
  archiveProfileId?: string | null
  archiveSnapshotTotalTurns?: number
  archiveSourceComplete?: boolean
  archiveSourceIssue?: string
  nativeHydrator?: (runIds: readonly string[]) => Promise<LoadedSessionTurn[]>
  hookConfig: ReturnType<typeof loadClaudeHookConfig> | null
}

export interface OlderHistoryDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  getSessionHistoryCache: () => SessionHistoryCache | null
  setSessionHistoryCache: (cache: SessionHistoryCache | null) => void
  getLoadSessionRevision: () => number
  resolveKnownProjectDirectory: (cwd: string) => string
  providerRegistry: Pick<ProviderRegistry, 'enrichSession'>
  pageWithHookCommands: (page: SessionHistoryPage, hookConfig: ReturnType<typeof loadClaudeHookConfig> | null) => SessionHistoryPage
  markIncompleteArchivePage: (page: SessionHistoryPage, issue: string | undefined) => SessionHistoryPage
  sessionHistoryCacheKey: (payload: ProviderContext, cwd: string) => string
}

export function registerOlderHistoryHandler(deps: OlderHistoryDependencies): void {
  const { handleTrusted, getSessionHistoryCache, setSessionHistoryCache, getLoadSessionRevision, resolveKnownProjectDirectory, providerRegistry, pageWithHookCommands, markIncompleteArchivePage, sessionHistoryCacheKey } = deps
  // 更早轮次的纯读取：不重做任何会话切换副作用（cwd / baseline / dock badge / resume）。
  // revision 或 session 身份不匹配时返回 null：renderer 将它当作过期请求丢弃，而不是拼上错会话的轮次。
  handleTrusted('agent:loadSessionOlder', async (_e, payload: ProviderContext, request: SessionHistoryPageRequest) => {
    if (!payload.externalSessionId) return null
    const perf = new PerformanceTrace('session_history.load_older', { provider: payload.providerId })
    try {
      const cache = getSessionHistoryCache()
      if (!cache || cache.revision !== getLoadSessionRevision()) return null
      const cwd = payload.cwd?.trim() ? resolveKnownProjectDirectory(payload.cwd) : ''
      if (cache.key !== sessionHistoryCacheKey(payload, cwd)) return null
      if (request?.before == null || !Number.isFinite(request.before) || request.before <= 0) return null
      if (cache.archiveSource) {
        const sourcePage = await readTraceArchivePageAsync(cache.archiveSource, {
          ...(cache.archiveProfileId !== undefined ? { agentProfileId: cache.archiveProfileId } : {}),
          ...request,
          snapshotTotalTurns: cache.archiveSnapshotTotalTurns
        })
        if (cache !== getSessionHistoryCache() || cache.revision !== getLoadSessionRevision()) return null
        if (sourcePage.archive) {
          for (const turn of sourcePage.archive.turns) {
            turn.items = await persistTraceToolEvents(cache.context.userDataDir, cwd, turn.items)
          }
          if (cache !== getSessionHistoryCache() || cache.revision !== getLoadSessionRevision()) return null
        }
        const archiveLoaded = mergeSessionTurns([], sourcePage.archive, cache.context, { hydrateAttachments: false })
        const turns = await providerRegistry.enrichSession(
          { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
          archiveLoaded
        )
        if (cache !== getSessionHistoryCache() || cache.revision !== getLoadSessionRevision()) return null
        const page = markIncompleteArchivePage(hydrateSessionHistoryPage({
          turns: turns as LoadedSessionTurn[],
          offset: sourcePage.offset,
          totalTurns: sourcePage.totalTurns,
          hasOlder: sourcePage.hasOlder,
          sourceComplete: sourcePage.sourceComplete,
          completeness: sourcePage.hasOlder || !sourcePage.sourceComplete ? 'partial' : 'complete'
        }, [], sourcePage.archive, cache.context), sourcePage.sourceComplete ? undefined : sourcePage.sourceIssue)
        perf.mark('indexed_archive', {
          returnedTurns: page.turns.length,
          archiveTurnFilesRead: sourcePage.turnFilesRead,
          sourceComplete: sourcePage.sourceComplete ? 1 : 0
        })
        const result = pageWithHookCommands(page, cache.hookConfig)
        perf.finish({ totalTurns: page.totalTurns, returnedTurns: result.turns.length })
        return result

      }
      let cachedPage = sessionHistoryPage(cache.turns, request)
      if (cache.archiveSourceComplete === false) {
        cachedPage = markIncompleteArchivePage({ ...cachedPage, sourceComplete: false }, cache.archiveSourceIssue)
      }
      let pageArchive = cache.archive
      if (cache.nativeHydrator) {
        const runIds = cachedPage.turns.map((turn) => turn.runId!).filter((runId): runId is string => !!runId)
        const archiveArgs = {
          cwd,
          sessionId: payload.externalSessionId,
          providerId: payload.providerId,
          userDataDir: cache.context.userDataDir
        }
        const selectedArchiveTurns = await readTraceArchiveTurnsAsync(archiveArgs, runIds)
        if (cache !== getSessionHistoryCache() || cache.revision !== getLoadSessionRevision()) return null
        const selectedArchive = selectedArchiveTurns.length > 0 ? {
          version: 3 as const,
          cwd,
          sessionId: payload.externalSessionId,
          providerId: payload.providerId,
          turns: selectedArchiveTurns
        } : null
        const selectedArchiveLoaded = mergeSessionTurns([], selectedArchive, cache.context, { hydrateAttachments: false })
        pageArchive = selectedArchive
        const archiveByRunId = new Map(selectedArchiveLoaded.map((turn) => [turn.runId!, turn]))
        let hydratedNative: LoadedSessionTurn[] = []
        try {
          hydratedNative = await cache.nativeHydrator(runIds)
          if (cache !== getSessionHistoryCache() || cache.revision !== getLoadSessionRevision()) return null
        } catch (error) {
          if (cache !== getSessionHistoryCache() || cache.revision !== getLoadSessionRevision()) return null
          setSessionHistoryCache(null)
          throw new Error(historyCopy.nativePageReload, { cause: error })
        }
        const hydratedByRunId = new Map(hydratedNative.map((turn) => [turn.runId!, turn]))
        cachedPage = {
          ...cachedPage,
          turns: cachedPage.turns.map((turn) => archiveByRunId.get(turn.runId!) ?? hydratedByRunId.get(turn.runId!) ?? turn)
        }
        const enriched = await providerRegistry.enrichSession(
          { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
          cachedPage.turns as ParsedTurn[]
        )
        if (cache !== getSessionHistoryCache() || cache.revision !== getLoadSessionRevision()) return null
        cachedPage = { ...cachedPage, turns: enriched as LoadedSessionTurn[] }
      }
      const page = hydrateSessionHistoryPage(
        cachedPage,
        cache.transcriptTurns,
        pageArchive,
        cache.context
      )
      perf.mark('cached_history', { returnedTurns: page.turns.length })
      const result = pageWithHookCommands(page, cache.hookConfig)
      perf.finish({ totalTurns: page.totalTurns, returnedTurns: result.turns.length })
      return result
    } catch (error) {
      perf.finish(undefined, 'error')
      throw error
    } finally {
      perf.finish(undefined, 'unavailable')
    }
  })

}
