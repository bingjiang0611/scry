import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { ParsedTurn } from '../normalize'
import type { ProviderContext, ProviderId } from '../../shared/provider'
import type { ActiveRun } from '../../shared/trace'
import type { createAppSessionStore } from '../app-store'
import type { ProviderRegistry } from '../providers/registry'
import type { DockBadgeState } from '../dock-badge'
import type { SessionHistoryPageRequest, SessionHistoryPage, LoadedSessionTurn } from '../session-history'
import type { TraceArchive } from '../transcript-archive'
import type { PiNativeHistorySnapshot } from '../pi-native-history'
import type { SessionHistoryCache } from './history-older'
import { PerformanceTrace as PerformanceTraceImpl } from '../performance-timing'
import { readTraceArchiveAsync, readTraceArchiveMetadataAsync, readTraceArchivePageAsync, readTraceArchiveTurnsAsync } from '../transcript-archive'
import { readCachedTranscript } from '../transcript-parser'
import { readPiNativeHistorySnapshot, reconcilePiNativeHistory } from '../pi-native-history'
import { readCompleteArchiveForNativeReconciliation, mergeSessionTurns, hydrateSessionHistoryPage, sessionHistoryPage, readSessionHistoryAfterCompletedRuns, sessionArchiveIsPageable } from '../session-history'
import { persistTraceToolEvents } from '../trace-tool-content'
import { sessionLoadMatchesRun } from '../session-diff'
import { appSessionCanResume } from '../app-store'
import { historyCopy } from '../../shared/constants/copy'
import { loadClaudeHookConfig, loadCodexHookConfig } from '../hook-config'
import { resolveTranscriptPath } from '../transcript-archive'

export interface LoadSessionDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  getLoadSessionAbortController: () => AbortController | null
  setLoadSessionAbortController: (controller: AbortController | null) => void
  nextLoadSessionRevision: () => number
  getLoadSessionRevision: () => number
  getSessionHistoryCache: () => SessionHistoryCache | null
  setSessionHistoryCache: (cache: SessionHistoryCache | null) => void
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string) => string
  resolveKnownProjectDirectory: (cwd: string) => string
  providerRegistry: Pick<ProviderRegistry, 'enrichSession'>
  getRuns: () => { unsettledStates: () => ActiveRun[]; get: (runId: string) => { control: { settled: Promise<void> } } | undefined }
  dockBadge: Pick<DockBadgeState, 'view'>
  setCurrentCwd: (cwd: string | undefined) => void
  rememberProject: (cwd: string) => void
  homeDir: string
  userDataDir: string
  isShuttingDown: () => boolean
  getWindow: () => { isFocused: () => boolean } | null
  bumpSessionRevision: (key: string) => void
  pageWithHookCommands: (page: SessionHistoryPage, hookConfig: ReturnType<typeof loadClaudeHookConfig> | null) => SessionHistoryPage
  markIncompleteArchivePage: (page: SessionHistoryPage, issue: string | undefined) => SessionHistoryPage
  sessionHistoryCacheKey: (payload: ProviderContext, cwd: string) => string
}

export function registerLoadSessionHandler(deps: LoadSessionDependencies): void {
  const {
    handleTrusted,
    appSessionStore,
    getLoadSessionAbortController,
    setLoadSessionAbortController,
    nextLoadSessionRevision,
    getLoadSessionRevision,
    getSessionHistoryCache,
    setSessionHistoryCache,
    sessionByContext,
    sessionAliasesByContext,
    providerContextKey,
    providerSessionKey,
    resolveKnownProjectDirectory,
    providerRegistry,
    getRuns,
    dockBadge,
    setCurrentCwd,
    rememberProject,
    homeDir,
    userDataDir,
    isShuttingDown,
    getWindow,
    bumpSessionRevision,
    pageWithHookCommands,
    markIncompleteArchivePage,
    sessionHistoryCacheKey
  } = deps
  handleTrusted('agent:loadSession', async (_e, payload: ProviderContext, request?: SessionHistoryPageRequest) => {
    if (!payload.externalSessionId) return null
    const perf = new PerformanceTraceImpl('session_history.load', { provider: payload.providerId })
    getLoadSessionAbortController()?.abort(new Error('session history request superseded'))
    const requestController = new AbortController()
    setLoadSessionAbortController(requestController)
    const { signal } = requestController
    try {
      const requestRevision = nextLoadSessionRevision()
      const catalogMatches = appSessionStore().load().filter((session) =>
        session.providerId === payload.providerId && session.agentProfileId === payload.agentProfileId &&
        (session.sessionId === payload.externalSessionId || session.externalSessionId === payload.externalSessionId)
      )
      const requestedCwd = payload.cwd?.trim()
        ? resolveKnownProjectDirectory(payload.cwd)
        : payload.cwd === '' ? '' : undefined
      const catalogSession = catalogMatches.length === 1
        ? catalogMatches[0]
        : catalogMatches.find((session) => session.cwd === requestedCwd)
      if (!catalogSession) throw new Error('会话不属于当前 Scry catalog 或身份不唯一')
      perf.mark('catalog', { matches: catalogMatches.length })
      const cwd = catalogSession.cwd ? resolveKnownProjectDirectory(catalogSession.cwd) : ''
      if (requestedCwd !== undefined && requestedCwd !== cwd) throw new Error('会话工作目录与 catalog 不一致')
      const archiveArgs = { cwd, sessionId: payload.externalSessionId, providerId: payload.providerId, userDataDir }
      const archiveProfile = payload.providerId !== 'pi' && typeof payload.agentProfileId === 'string'
        ? { agentProfileId: payload.agentProfileId }
        : {}
      const fp =
        payload.providerId === 'claude' && cwd
          ? resolveTranscriptPath({ cwd, sessionId: payload.externalSessionId, userDataDir })
          : null
      const archivePaged = sessionArchiveIsPageable(payload.providerId, fp)
      let archivePage: Awaited<ReturnType<typeof readTraceArchivePageAsync>> | null
      let archived: TraceArchive | null
      const matchingRuns = getRuns().unsettledStates()
        .filter((run) => sessionLoadMatchesRun(run, {
          providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd,
          externalSessionId: payload.externalSessionId
        }))
        .map((run) => ({ done: run.done, settled: getRuns().get(run.runId)!.control.settled }))
      try {
        [archivePage, archived] = await readSessionHistoryAfterCompletedRuns(matchingRuns, signal, async () => {
          const page = archivePaged
            ? await readTraceArchivePageAsync(archiveArgs, { ...archiveProfile, limit: request?.limit }, signal)
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
          if (isShuttingDown()) throw new Error('transcript parser disposed')
          const parsed = await readCachedTranscript({
            path: fp,
            runId: payload.externalSessionId,
            contextKey: providerContextKey(payload.providerId, cwd, payload.agentProfileId),
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
      perf.mark('transcript', {
        transcriptTurns: turns.length, transcriptBytes, transcriptParsedBytes,
        transcriptCacheHit: transcriptCache === 'hit' ? 1 : 0,
        transcriptIncremental: transcriptCache === 'incremental' ? 1 : 0
      })
      signal.throwIfAborted()
      let nativeTurns: LoadedSessionTurn[] | null = null
      let nativeSnapshot: PiNativeHistorySnapshot | null = null
      let nativeReadNotice: string | undefined
      if (payload.providerId === 'pi' && matchingRuns.length === 0) {
        let native: LoadedSessionTurn[] | null = null
        try {
          nativeSnapshot = await readPiNativeHistorySnapshot({
            sessionRoot: join(homeDir, '.pi', 'agent', 'sessions'),
            cwd, sessionId: payload.externalSessionId, signal
          })
          native = nativeSnapshot?.turns ?? null
        } catch (error) {
          signal.throwIfAborted()
          if (!archived) throw error
          nativeReadNotice = historyCopy.nativeArchiveFallback(error instanceof Error ? error.message : String(error))
        }
        if (native && !archived) nativeTurns = native
        else if (native) {
          const completeArchive = await readTraceArchiveMetadataAsync(archiveArgs, signal) ??
            await readCompleteArchiveForNativeReconciliation(
              archivePage,
              () => readTraceArchiveAsync(archiveArgs, signal)
            )
          if (requestRevision !== getLoadSessionRevision()) return null
          nativeTurns = reconcilePiNativeHistory(native, mergeSessionTurns([], completeArchive,
            { userDataDir }, { hydrateAttachments: false }))
        }
        if (nativeSnapshot && nativeTurns === null) nativeTurns = nativeSnapshot.turns
        if (nativeSnapshot && nativeTurns) {
          const nativeByRunId = new Map(nativeSnapshot.turns.map((turn) => [turn.runId!, turn]))
          const reconciledByRunId = new Map(nativeTurns.map((turn) => [turn.runId!, turn]))
          const hydrateNative = nativeSnapshot.hydrate
          nativeSnapshot = {
            ...nativeSnapshot,
            hydrate: async (runIds, hydrateSignal) => {
              const nativeIds = runIds.filter((runId) => nativeByRunId.has(runId) && reconciledByRunId.get(runId) === nativeByRunId.get(runId))
              return nativeIds.length ? hydrateNative(nativeIds, hydrateSignal) : []
            }
          }
        }
      }
      signal.throwIfAborted()
      perf.mark('native_history', { nativeTurns: nativeTurns?.length ?? 0 })
      if (!fp && !archived && !nativeTurns) {
        perf.finish({ returnedTurns: 0 })
        return null
      }
      dockBadge.view(
        providerSessionKey(payload.providerId, cwd, payload.externalSessionId, payload.agentProfileId),
        Boolean(getWindow()?.isFocused())
      )
      setCurrentCwd(cwd || undefined)
      const key = providerContextKey(payload.providerId, cwd, payload.agentProfileId)
      const loadingUnsettledRun = getRuns().unsettledStates().some((run) => sessionLoadMatchesRun(run, {
        providerId: payload.providerId,
        agentProfileId: payload.agentProfileId,
        cwd,
        externalSessionId: payload.externalSessionId
      }))
      if (!loadingUnsettledRun) {
        bumpSessionRevision(key)
        sessionAliasesByContext.delete(key)
      }
      if (appSessionCanResume(catalogSession)) sessionByContext.set(key, payload.externalSessionId)
      else sessionByContext.delete(key)
      perf.mark('selection')
      if (cwd) rememberProject(cwd)
      perf.mark('project_remember')
      const historyContext = { userDataDir }
      const mergedHistory = nativeTurns ?? mergeSessionTurns(turns, archived, historyContext, { hydrateAttachments: false })
      perf.mark('merge_turns', { mergedTurns: mergedHistory.length })
      const merged: LoadedSessionTurn[] = nativeTurns ?? await providerRegistry.enrichSession(
        { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
        mergedHistory
      )
      if (archivePage && !archivePage.sourceComplete && merged.length) {
        const last = merged[merged.length - 1]
        last.errorHint = [last.errorHint, historyCopy.incompleteArchive]
          .filter(Boolean).join('\n')
      }
      if (nativeReadNotice && merged.length) {
        const last = merged[merged.length - 1]
        last.errorHint = [last.errorHint, nativeReadNotice].filter(Boolean).join('\n')
      }
      perf.mark('merge', { mergedTurns: merged.length })
      signal.throwIfAborted()
      const hookConfig =
        cwd && payload.providerId === 'claude'
          ? loadClaudeHookConfig(cwd, homeDir)
          : payload.providerId === 'codex'
            ? cwd ? loadCodexHookConfig(cwd, homeDir) : null
            : null
      setSessionHistoryCache({
        revision: requestRevision,
        key: sessionHistoryCacheKey(payload, cwd),
        turns: merged,
        transcriptTurns: turns,
        archive: archived,
        context: historyContext,
        archiveSourceComplete: archivePage?.sourceComplete ?? true,
        archiveSourceIssue: archivePage?.sourceIssue,
        ...(archiveProfile.agentProfileId !== undefined ? { archiveProfileId: archiveProfile.agentProfileId } : {}),
        ...(!nativeSnapshot && archivePaged ? {
          archiveSource: archiveArgs,
          archiveSnapshotTotalTurns: archivePage?.totalTurns ?? archived?.turns.length ?? 0
        } : {}),
        ...(nativeSnapshot ? { nativeHydrator: (runIds) => nativeSnapshot!.hydrate(runIds) } : {}),
        hookConfig
      })
      const unhydratedPage: SessionHistoryPage = archivePage && !nativeTurns
        ? {
          turns: merged,
          offset: archivePage.offset,
          totalTurns: archivePage.totalTurns,
          hasOlder: archivePage.hasOlder,
          sourceComplete: archivePage.sourceComplete,
          completeness: archivePage.hasOlder || !archivePage.sourceComplete ? 'partial' : 'complete'
        }
        : sessionHistoryPage(merged, { before: undefined, limit: request?.limit })
      let selectedPage = unhydratedPage
      let selectedArchive: TraceArchive | null = archived
      if (nativeSnapshot) {
        const selectedRunIds = unhydratedPage.turns.map((turn) => turn.runId!).filter((runId): runId is string => !!runId)
        const selectedArchiveTurns = await readTraceArchiveTurnsAsync(archiveArgs, selectedRunIds, signal)
        if (requestRevision !== getLoadSessionRevision()) return null
        const selectedArchiveLoaded = mergeSessionTurns([], selectedArchiveTurns.length > 0 ? {
          version: 3,
          cwd,
          sessionId: payload.externalSessionId,
          providerId: payload.providerId,
          turns: selectedArchiveTurns
        } : null, historyContext, { hydrateAttachments: false })
        const hydratedArchiveByRunId = new Map(selectedArchiveLoaded.map((turn) => [turn.runId!, turn]))
        let hydratedNative: LoadedSessionTurn[] = []
        let nativeHydrationFailed = false
        try {
          hydratedNative = await nativeSnapshot.hydrate(selectedRunIds, signal)
          if (requestRevision !== getLoadSessionRevision()) return null
        } catch (error) {
          signal.throwIfAborted()
          if (!archived) throw error
          nativeHydrationFailed = true
          nativeReadNotice = [nativeReadNotice, historyCopy.nativeBodyFallback(error instanceof Error ? error.message : String(error))]
            .filter(Boolean).join('\n')
        }
        const hydratedByRunId = new Map(hydratedNative.map((turn) => [turn.runId!, turn]))
        const canonicalFallbackArchive = archivePage?.archive ?? archived
        const canonicalFallbackLoaded = mergeSessionTurns([], canonicalFallbackArchive, historyContext, { hydrateAttachments: false })
        selectedPage = nativeHydrationFailed
          ? {
            turns: canonicalFallbackLoaded,
            offset: archivePage?.offset ?? 0,
            totalTurns: archivePage?.totalTurns ?? canonicalFallbackLoaded.length,
            hasOlder: Boolean(archivePage?.hasOlder),
            sourceComplete: archivePage?.sourceComplete,
            completeness: archivePage?.hasOlder || archivePage?.sourceComplete === false ? 'partial' : 'complete'
          }
          : {
            ...unhydratedPage,
            turns: unhydratedPage.turns.map((turn) =>
              hydratedArchiveByRunId.get(turn.runId!) ?? hydratedByRunId.get(turn.runId!) ?? turn)
          }
        selectedArchive = nativeHydrationFailed
          ? canonicalFallbackArchive
          : selectedArchiveTurns.length > 0 ? {
            version: 3,
            cwd,
            sessionId: payload.externalSessionId,
            providerId: payload.providerId,
            turns: selectedArchiveTurns
          } : archived
        if (archivePage && !archivePage.sourceComplete) {
          selectedPage = markIncompleteArchivePage(selectedPage, archivePage.sourceIssue)
        }
        if (nativeHydrationFailed) {
          if (requestRevision !== getLoadSessionRevision() || getSessionHistoryCache()?.revision !== requestRevision) return null
          setSessionHistoryCache({
            ...getSessionHistoryCache()!,
            turns: canonicalFallbackLoaded,
            archive: canonicalFallbackArchive,
            nativeHydrator: undefined,
            archiveSource: archiveArgs,
            archiveSnapshotTotalTurns: selectedPage.totalTurns
          })
          if (selectedPage.turns.length && nativeReadNotice) {
            const last = selectedPage.turns[selectedPage.turns.length - 1]
            selectedPage.turns[selectedPage.turns.length - 1] = {
              ...last,
              errorHint: [last.errorHint, nativeReadNotice].filter(Boolean).join('\n')
            }
          }
        }
        const enriched = await providerRegistry.enrichSession(
          { providerId: payload.providerId, agentProfileId: payload.agentProfileId, cwd, externalSessionId: payload.externalSessionId },
          selectedPage.turns as ParsedTurn[]
        )
        if (requestRevision !== getLoadSessionRevision()) return null
        selectedPage = { ...selectedPage, turns: enriched as LoadedSessionTurn[] }
      }
      signal.throwIfAborted()
      if (requestRevision !== getLoadSessionRevision() || getSessionHistoryCache()?.revision !== requestRevision) return null
      const page = hydrateSessionHistoryPage(
        selectedPage,
        turns,
        selectedArchive,
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
