import { app } from 'electron'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider'
import type { ParsedTurn } from '../normalize'
import { bindRemoteHistoryContext } from '../remote/history-context'
import { readRemoteHistoryTurnsPage, readRemoteHistoryVersion, readRemoteProfileHistory, readRemoteProfilePreview } from '../remote/history-reader'
import { readTraceArchiveAsync, readTraceArchivePageAsync, resolveTranscriptPath } from '../transcript-archive'
import { readCachedTranscript } from '../transcript-parser'
import { mergeSessionTurns } from '../session-history'
import { flattenTraceItems, previewTraceItems } from '../remote/trace-output'
import type { RemoteHostRuntime } from './remote-host'

type HistoryRequest = Parameters<typeof bindRemoteHistoryContext>[0]
type HistoryPageRequest = HistoryRequest & { before?: number; limit?: number; snapshot?: string }

export function createRemoteHistoryHandlers(runtime: RemoteHostRuntime) {
  const bindRemoteHistory = (input: HistoryRequest) =>
    bindRemoteHistoryContext(input, runtime.appSessionStore().load(), runtime.resolveRemoteProjectDirectory)
  return {
    readHistoryVersion: async ({ providerId, cwd, externalSessionId, historyScope, agentProfileId }: HistoryRequest) => {
      const bound = bindRemoteHistory({ providerId, cwd, externalSessionId, historyScope, agentProfileId })
      const canonical = bound.canonical
      return readRemoteHistoryVersion({
        cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
        userDataDir: app.getPath('userData'),
        historyScope: bound.scope,
        ...(bound.profile !== undefined ? { agentProfileId: bound.profile } : {}),
        ...(providerId === 'pi' ? { piSessionRoot: join(runtime.homeDir, '.pi', 'agent', 'sessions') } : {})
      }, () => runtime.runs.activeStates().find((run) =>
        run.providerId === providerId && run.cwd === canonical &&
        (bound.profile === undefined || (run.agentProfileId ?? null) === bound.profile) &&
        (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
    },
    readHistoryTurnsPage: async ({ providerId, cwd, externalSessionId, historyScope, agentProfileId, before, limit = 3, snapshot }: HistoryPageRequest) => {
      const bound = bindRemoteHistory({ providerId, cwd, externalSessionId, historyScope, agentProfileId })
      const canonical = bound.canonical
      return readRemoteHistoryTurnsPage({
        cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
        userDataDir: app.getPath('userData'),
        historyScope: bound.scope,
        ...(bound.profile !== undefined ? { agentProfileId: bound.profile } : {}),
        ...(providerId === 'pi' ? { piSessionRoot: join(runtime.homeDir, '.pi', 'agent', 'sessions') } : {})
      }, { before, limit, snapshot }, () => runtime.runs.activeStates().find((run) =>
        run.providerId === providerId && run.cwd === canonical &&
        (bound.profile === undefined || (run.agentProfileId ?? null) === bound.profile) &&
        (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
    },
    readHistoryPreview: async ({ providerId, cwd, externalSessionId, historyScope, agentProfileId }: HistoryRequest) => {
      if (!providerId || !externalSessionId) return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
      let canonical: string
      try {
        const bound = bindRemoteHistory({ providerId, cwd, externalSessionId, historyScope, agentProfileId })
        canonical = bound.canonical
        if (historyScope !== undefined || agentProfileId !== undefined) return readRemoteProfilePreview({
          cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
          userDataDir: app.getPath('userData'), historyScope: bound.scope,
          ...(bound.profile !== undefined ? { agentProfileId: bound.profile } : {})
        }, () => runtime.runs.activeStates().find((run) => run.providerId === providerId && run.cwd === canonical &&
          (bound.profile === undefined || (run.agentProfileId ?? null) === bound.profile) && (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
      } catch { return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const } }
      const activeRun = runtime.runs.activeStates().find((run) =>
        run.providerId === providerId && run.cwd === canonical &&
        (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId))
      if (activeRun) {
        const projection = previewTraceItems(activeRun.items)
        return {
          status: 'available' as const, source: 'active_memory' as const, turns: [{
            userText: activeRun.userText,
            userTextTruncated: false,
            items: projection.items,
            truncated: projection.truncated
          }], partial: true as const, truncated: projection.truncated, bytes: 0
        }
      }
      if (!canonical) return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
      try {
        const page = await readTraceArchivePageAsync({ cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId, userDataDir: app.getPath('userData') }, { limit: 2 })
        if (!page.archive || page.archive.turns.length === 0) return { status: 'unavailable' as const, reason: 'session_not_found' as const }
        const source = page.readMode === 'indexed' ? 'indexed_archive' as const : page.readMode
        const turns = page.archive.turns.map((turn) => {
          const projection = previewTraceItems(turn.items)
          return { userText: turn.userText, userTextTruncated: false, items: projection.items, truncated: projection.truncated }
        })
        return { status: 'available' as const, source, turns, partial: true as const, truncated: page.hasOlder || turns.some((turn) => turn.truncated), bytes: 0 }
      } catch {
        return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
      }
    },
    readHistory: async ({ providerId, cwd, externalSessionId, historyScope, agentProfileId }: HistoryRequest) => {
      const scoped = historyScope !== undefined || agentProfileId !== undefined
      if (!providerId || !externalSessionId) {
        if (scoped) throw new Error('invalid_history_query')
        return []
      }
      let canonical: string
      let scope: 'session' | 'profile'
      let profile: string | null | undefined
      try {
        const bound = bindRemoteHistory({ providerId, cwd, externalSessionId, historyScope, agentProfileId })
        canonical = bound.canonical
        scope = bound.scope
        profile = bound.profile
      } catch (error) {
        if (scoped) throw error
        return []
      }
      if (scoped) return readRemoteProfileHistory({
        cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
        userDataDir: app.getPath('userData'), historyScope: scope,
        ...(profile !== undefined ? { agentProfileId: profile } : {}),
        ...(providerId === 'pi' ? { piSessionRoot: join(runtime.homeDir, '.pi', 'agent', 'sessions') } : {})
      }, () => runtime.runs.activeStates().find((run) => run.providerId === providerId && run.cwd === canonical &&
        (profile === undefined || (run.agentProfileId ?? null) === profile) && (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
      const userDataDir = app.getPath('userData')
      const archived = await readTraceArchiveAsync({ cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId, userDataDir })
      let turns: ParsedTurn[] = []
      if (providerId === 'claude' && canonical) {
        const fp = resolveTranscriptPath({ cwd: canonical, sessionId: externalSessionId, userDataDir })
        if (fp) {
          try {
            if (runtime.isShuttingDown) throw new Error('transcript parser disposed')
            const parsed = await readCachedTranscript({
              path: fp, runId: externalSessionId,
              contextKey: runtime.providerContextKey('claude', canonical)
            })
            turns = parsed.turns
          } catch { /* transcript unreadable; fall back to archive */ }
        }
      }
      const activeRun = runtime.runs.activeStates().find((run) =>
        run.providerId === providerId && run.cwd === canonical &&
        (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId))
      if (turns.length === 0 && !archived && !activeRun) return []
      const merged = mergeSessionTurns(turns, archived, { userDataDir })
      const history = merged.map((turn) => ({ userText: turn.userText, items: flattenTraceItems(turn.items) }))
      if (activeRun) {
        const bounded = runtime.boundedLiveRun(activeRun)
        history.push({ userText: bounded.userText, items: flattenTraceItems(bounded.items) })
      }
      return history
    }
  }
}
