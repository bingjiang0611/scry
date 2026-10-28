import type { ProviderContext } from '../shared/provider'
import { readTraceArchivePageAsync } from './transcript-archive'
import {
  hydrateSessionHistoryPage,
  mergeSessionTurns,
  sessionHistoryPage,
  type SessionHistoryPageRequest
} from './session-history'
import { persistTraceToolEvents } from './trace-tool-content'
import { PerformanceTrace } from './performance-timing'
import type { ProviderRegistry } from './providers/registry'
import {
  pageWithHookCommands,
  sessionHistoryCacheKey,
  type SessionHistoryState,
  type SessionHistoryIpcDeps,
  type SessionHistoryIpcRegister
} from './session-history-ipc'

export interface SessionHistoryOlderIpcDeps {
  register: SessionHistoryIpcRegister
  resolveKnownProjectDirectory: (cwd: string) => string
  providerContextKey: SessionHistoryIpcDeps['providerContextKey']
  providerRegistry: Pick<ProviderRegistry, 'enrichSession'>
}

export function registerSessionHistoryOlderIpc(state: SessionHistoryState, deps: SessionHistoryOlderIpcDeps): void {
  deps.register('agent:loadSessionOlder', async (_e, payload: ProviderContext, request: SessionHistoryPageRequest) => {
    if (!payload.externalSessionId) return null
    const perf = new PerformanceTrace('session_history.load_older', { provider: payload.providerId })
    try {
      const cache = state.cache
      if (!cache || cache.revision !== state.revision) return null
      const cwd = payload.cwd?.trim() ? deps.resolveKnownProjectDirectory(payload.cwd) : ''
      if (cache.key !== sessionHistoryCacheKey(payload, cwd, deps.providerContextKey)) return null
      if (request?.before == null || !Number.isFinite(request.before) || request.before <= 0) return null
      if (cache.archiveSource) {
        const sourcePage = await readTraceArchivePageAsync(cache.archiveSource, {
          ...request,
          snapshotTotalTurns: cache.archiveSnapshotTotalTurns
        })
        if (cache !== state.cache || cache.revision !== state.revision) return null
        if (sourcePage.archive) {
          for (const turn of sourcePage.archive.turns) {
            turn.items = await persistTraceToolEvents(cache.context.userDataDir, cwd, turn.items)
          }
          if (cache !== state.cache || cache.revision !== state.revision) return null
        }
        const turns = await deps.providerRegistry.enrichSession(
          { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
          mergeSessionTurns([], sourcePage.archive, cache.context, { hydrateAttachments: false })
        )
        if (cache !== state.cache || cache.revision !== state.revision) return null
        const page = hydrateSessionHistoryPage({
          turns,
          offset: sourcePage.offset,
          totalTurns: sourcePage.totalTurns,
          hasOlder: sourcePage.hasOlder,
          completeness: sourcePage.hasOlder ? 'partial' : 'complete'
        }, [], sourcePage.archive, cache.context)
        perf.mark('indexed_archive', {
          returnedTurns: page.turns.length,
          archiveTurnFilesRead: sourcePage.turnFilesRead
        })
        const result = pageWithHookCommands(page, cache.hookConfig)
        perf.finish({ totalTurns: page.totalTurns, returnedTurns: result.turns.length })
        return result
      }
      const page = hydrateSessionHistoryPage(
        sessionHistoryPage(cache.turns, request),
        cache.transcriptTurns,
        cache.archive,
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
