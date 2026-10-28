import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { ParsedTurn } from './normalize'
import { readCachedTranscript } from './transcript-parser'
import {
  readTraceArchiveAsync,
  readTraceArchivePageAsync,
  resolveTranscriptPath,
  type TraceArchive
} from './transcript-archive'
import { readPiNativeHistory, reconcilePiNativeHistory } from './pi-native-history'
import {
  hydrateSessionHistoryPage,
  mergeSessionTurns,
  readSessionHistoryAfterCompletedRuns,
  sessionHistoryPage,
  sessionArchiveIsPageable,
  type LoadedSessionTurn,
  type SessionHistoryPage,
  type SessionHistoryPageRequest
} from './session-history'
import { appSessionCanResume, createAppSessionStore } from './app-store'
import type { ProviderContext, ProviderId } from '../shared/provider'
import type { ActiveRun } from '../shared/trace'
import type { ProviderRegistry } from './providers/registry'
import { persistTraceToolEvents } from './trace-tool-content'
import { attachConfiguredHookCommands, loadClaudeHookConfig, loadCodexHookConfig } from './hook-config'
import { PerformanceTrace } from './performance-timing'
import { sessionLoadMatchesRun } from './session-diff'

export type SessionHistoryIpcRegister = <TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
) => void

export interface SessionHistoryCache {
  revision: number
  key: string
  turns: LoadedSessionTurn[]
  transcriptTurns: ParsedTurn[]
  archive: TraceArchive | null
  context: { userDataDir: string }
  archiveSource?: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId }
  archiveSnapshotTotalTurns?: number
  hookConfig: ReturnType<typeof loadClaudeHookConfig> | null
}

export interface SessionHistoryIpcDeps {
  register: SessionHistoryIpcRegister
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  userDataDir: () => string
  resolveKnownProjectDirectory: (cwd: string) => string
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string) => string
  providerRegistry: Pick<ProviderRegistry, 'enrichSession'>
  runs: () => {
    unsettledStates: () => ActiveRun[]
    get: (runId: string) => { control: { settled: Promise<void> } } | undefined
  }
  homeDir: string
  isShuttingDown: () => boolean
  dockBadge: { view: (key: string | null, focused: boolean) => void }
  isWindowFocused: () => boolean
  setCurrentCwd: (cwd: string | undefined) => void
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  bumpSessionRevision: (key: string) => void
  rememberProject: (cwd: string) => void
}

export type SessionHistoryState = {
  revision: number
  abortController: AbortController | null
  cache: SessionHistoryCache | null
}

export function invalidateSessionHistoryLoad(state: SessionHistoryState, reason: string): void {
  state.revision += 1
  state.abortController?.abort(new Error(reason))
  state.abortController = null
  state.cache = null
}

export function sessionHistoryCacheKey(
  payload: ProviderContext,
  cwd: string,
  providerContextKey: SessionHistoryIpcDeps['providerContextKey']
): string {
  return `${providerContextKey(payload.providerId, cwd, payload.agentProfileId)}\u0000${payload.externalSessionId ?? ''}`
}

// Hook 命令附写只对当前页的事件做，而不是对整个会话的全部事件做。
export function pageWithHookCommands(
  page: SessionHistoryPage,
  hookConfig: ReturnType<typeof loadClaudeHookConfig> | null
): SessionHistoryPage {
  if (!hookConfig) return page
  return {
    ...page,
    turns: page.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((event) => attachConfiguredHookCommands(event, hookConfig))
    }))
  }
}

export function registerSessionHistoryLoadIpc(state: SessionHistoryState, deps: SessionHistoryIpcDeps): void {
  deps.register('agent:loadSession', async (_e, payload: ProviderContext, request?: SessionHistoryPageRequest) => {
    if (!payload.externalSessionId) return null
    const perf = new PerformanceTrace('session_history.load', { provider: payload.providerId })
    state.abortController?.abort(new Error('session history request superseded'))
    const requestController = new AbortController()
    state.abortController = requestController
    const { signal } = requestController
    try {
      const requestRevision = ++state.revision
      const catalogMatches = deps.appSessionStore().load().filter((session) =>
        session.providerId === payload.providerId && session.agentProfileId === payload.agentProfileId &&
        (session.sessionId === payload.externalSessionId || session.externalSessionId === payload.externalSessionId)
      )
      const requestedCwd = payload.cwd?.trim()
        ? deps.resolveKnownProjectDirectory(payload.cwd)
        : payload.cwd === '' ? '' : undefined
      const catalogSession = catalogMatches.length === 1
        ? catalogMatches[0]
        : catalogMatches.find((session) => session.cwd === requestedCwd)
      if (!catalogSession) throw new Error('会话不属于当前 Scry catalog 或身份不唯一')
      perf.mark('catalog', { matches: catalogMatches.length })
      const cwd = catalogSession.cwd ? deps.resolveKnownProjectDirectory(catalogSession.cwd) : ''
      if (requestedCwd !== undefined && requestedCwd !== cwd) throw new Error('会话工作目录与 catalog 不一致')
      const userDataDir = deps.userDataDir()
      const archiveArgs = { cwd, sessionId: payload.externalSessionId, providerId: payload.providerId, userDataDir }
      const fp =
        payload.providerId === 'claude' && cwd
          ? resolveTranscriptPath({ cwd, sessionId: payload.externalSessionId, userDataDir })
          : null
      // Pi's model-context enrichment is turn-local, so apply it to each archive page.
      // Qoder's Provider-owned history reconciliation still requires the full source.
      const archivePaged = sessionArchiveIsPageable(payload.providerId, fp)
      let archivePage: Awaited<ReturnType<typeof readTraceArchivePageAsync>> | null
      let archived: TraceArchive | null
      const matchingRuns = deps.runs().unsettledStates()
        .filter((run) => sessionLoadMatchesRun(run, {
          providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd,
          externalSessionId: payload.externalSessionId
        }))
        .map((run) => ({ done: run.done, settled: deps.runs().get(run.runId)!.control.settled }))
      try {
        [archivePage, archived] = await readSessionHistoryAfterCompletedRuns(matchingRuns, signal, async () => {
          const page = archivePaged
            ? await readTraceArchivePageAsync(archiveArgs, { limit: request?.limit }, signal)
            : null
          const archive = page?.archive ?? (archivePaged ? null : await readTraceArchiveAsync(archiveArgs, signal))
          return [page, archive] as const
        })
      } catch (error) {
        signal.throwIfAborted()
        throw error
      }
      if (archived) {
        for (const turn of archived.turns) {
          turn.items = await persistTraceToolEvents(userDataDir, cwd, turn.items)
          signal.throwIfAborted()
        }
      }
      perf.mark('archive', {
        archiveTurns: archived?.turns.length ?? 0,
        archiveTotalTurns: archivePage?.totalTurns ?? archived?.turns.length ?? 0,
        archiveTurnFilesRead: archivePage?.turnFilesRead ?? archived?.turns.length ?? 0
      })
      let turns: ParsedTurn[] = []
      let transcriptBytes = 0
      let transcriptParsedBytes = 0
      let transcriptCache = 'unavailable'
      if (fp) {
        try {
          if (deps.isShuttingDown()) throw new Error('transcript parser disposed')
          const parsed = await readCachedTranscript({
            path: fp,
            runId: payload.externalSessionId,
            contextKey: deps.providerContextKey(payload.providerId, cwd, payload.agentProfileId),
            signal
          })
          turns = parsed.turns
          transcriptBytes = parsed.bytes
          transcriptParsedBytes = parsed.parsedBytes
          transcriptCache = parsed.cache
        } catch (error) {
          signal.throwIfAborted()
          if (!archived) throw error
        }
      }
      for (const turn of turns) {
        turn.items = await persistTraceToolEvents(userDataDir, cwd, turn.items)
        signal.throwIfAborted()
      }
      perf.mark('transcript', { transcriptTurns: turns.length, transcriptBytes, transcriptParsedBytes,
        transcriptCacheHit: transcriptCache === 'hit' ? 1 : 0,
        transcriptIncremental: transcriptCache === 'incremental' ? 1 : 0 })
      // Cancellation is not evidence of an empty session. Reject it so the renderer
      // cannot replace an existing timeline with an empty successful response.
      signal.throwIfAborted()
      // Older phone runs could lose their Scry archive if the host exited before
      // the Provider returned. Pi's native session is independent durable evidence;
      // read it offline rather than treating a missing Scry archive as no messages.
      let nativeTurns: LoadedSessionTurn[] | null = null
      let nativeReadNotice: string | undefined
      // An in-flight native tail has no Scry run ID; the live RunRegistry owns that
      // display. Do not add an unmatchable second copy while the Provider is running.
      if (payload.providerId === 'pi' && matchingRuns.length === 0) {
        let native: LoadedSessionTurn[] | null = null
        try {
          native = await readPiNativeHistory({ sessionRoot: join(deps.homeDir, '.pi', 'agent', 'sessions'),
            cwd, sessionId: payload.externalSessionId, signal })
        } catch (error) {
          signal.throwIfAborted()
          if (!archived) throw error
          // A truncated/unsupported native file must not hide an intact Scry archive.
          nativeReadNotice = `已显示 Scry 归档；Pi 原生历史未能核对：${error instanceof Error ? error.message : String(error)}`
        }
        if (native && !archived) nativeTurns = native
        else if (native) {
          // A successful continuation must not hide the previously recovered prefix.
          // Reconcile only Provider-native turn IDs, never prompts or output text.
          const completeArchive = await readTraceArchiveAsync(archiveArgs, signal)
          nativeTurns = reconcilePiNativeHistory(native, mergeSessionTurns([], completeArchive,
            { userDataDir }, { hydrateAttachments: false }))
        }
      }
      signal.throwIfAborted()
      perf.mark('native_history', { nativeTurns: nativeTurns?.length ?? 0 })
      if (!fp && !archived && !nativeTurns) {
        perf.finish({ returnedTurns: 0 })
        return null
      }
      deps.dockBadge.view(
        deps.providerSessionKey(payload.providerId, cwd, payload.externalSessionId, payload.agentProfileId),
        deps.isWindowFocused()
      )
      deps.setCurrentCwd(cwd || undefined)
      const key = deps.providerContextKey(payload.providerId, cwd, payload.agentProfileId)
      // 恢复当前仍在运行或收口的会话只是读取历史：它不能清掉该 run 正在使用的 session diff baseline。
      // 真正切换到另一条历史会话时递增选择 revision；它不改变任何会话的 baseline。
      const loadingUnsettledRun = deps.runs().unsettledStates().some((run) => sessionLoadMatchesRun(run, {
        providerId: payload.providerId,
        agentProfileId: payload.agentProfileId,
        cwd,
        externalSessionId: payload.externalSessionId
      }))
      if (!loadingUnsettledRun) {
        deps.bumpSessionRevision(key)
        deps.sessionAliasesByContext.delete(key)
      }
      if (appSessionCanResume(catalogSession)) deps.sessionByContext.set(key, payload.externalSessionId)
      else deps.sessionByContext.delete(key)
      perf.mark('selection')
      if (cwd) deps.rememberProject(cwd)
      perf.mark('project_remember')
      const historyContext = { userDataDir }
      const mergedHistory = nativeTurns ?? mergeSessionTurns(turns, archived, historyContext, { hydrateAttachments: false })
      perf.mark('merge_turns', { mergedTurns: mergedHistory.length })
      const merged: LoadedSessionTurn[] = nativeTurns ?? await deps.providerRegistry.enrichSession(
        { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
        mergedHistory
      )
      if (nativeReadNotice && merged.length) {
        const last = merged[merged.length - 1]
        last.errorHint = [last.errorHint, nativeReadNotice].filter(Boolean).join('\n')
      }
      perf.mark('merge', { mergedTurns: merged.length })
      signal.throwIfAborted()
      const hookConfig =
        cwd && payload.providerId === 'claude'
          ? loadClaudeHookConfig(cwd, deps.homeDir)
          : payload.providerId === 'codex'
            ? cwd ? loadCodexHookConfig(cwd, deps.homeDir) : null
            : null
      state.cache = {
        revision: requestRevision,
        key: sessionHistoryCacheKey(payload, cwd, deps.providerContextKey),
        turns: merged,
        transcriptTurns: turns,
        archive: archived,
        context: historyContext,
        ...(archivePaged && !nativeTurns ? {
          archiveSource: archiveArgs,
          archiveSnapshotTotalTurns: archivePage?.totalTurns ?? 0
        } : {}),
        hookConfig
      }
      const unhydratedPage: SessionHistoryPage = archivePage && !nativeTurns
        ? {
            turns: merged,
            offset: archivePage.offset,
            totalTurns: archivePage.totalTurns,
            hasOlder: archivePage.hasOlder,
            completeness: archivePage.hasOlder ? 'partial' : 'complete'
          }
        : sessionHistoryPage(merged, { before: undefined, limit: request?.limit })
      const page = hydrateSessionHistoryPage(
        unhydratedPage,
        turns,
        archived,
        historyContext
      )
      perf.mark('page_hydration', { returnedTurns: page.turns.length })
      const result = pageWithHookCommands(page, hookConfig)
      perf.finish({ totalTurns: page.totalTurns, returnedTurns: result.turns.length })
      return result
    } catch (error) {
      perf.finish(undefined, signal.aborted ? 'cancelled' : 'error')
      throw error
    } finally {
      perf.finish(undefined, 'unavailable')
    }
  })
}
