import type { ProviderContext } from '../../shared/provider'
import { historyCopy } from '../../shared/constants/copy'
import { attachConfiguredHookCommands, loadClaudeHookConfig } from '../hook-config'
import { projectHistoryPageSnapshots } from '../session-history-page-projection'
import type { SessionHistoryPage } from '../session-history'
import { registerLoadSessionHandler, type LoadSessionDependencies } from './history-load'
import { registerOlderHistoryHandler, type SessionHistoryCache } from './history-older'
import { registerTurnTerminalEvidenceHandler } from './turn-terminal-evidence'

// Hook 命令附写只对当前页的事件做，而不是对整个会话的全部事件做。
function pageWithHookCommands(
  page: SessionHistoryPage,
  hookConfig: ReturnType<typeof loadClaudeHookConfig> | null
): SessionHistoryPage {
  // Only trim superseded cumulative session snapshots from the page crossing IPC.
  // The archive and the main-side history cache keep the complete evidence.
  const projected = projectHistoryPageSnapshots(page)
  if (!hookConfig) return projected
  return {
    ...projected,
    turns: projected.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((event) => attachConfiguredHookCommands(event, hookConfig))
    }))
  }
}

function markIncompleteArchivePage(page: SessionHistoryPage, issue: string | undefined): SessionHistoryPage {
  if (issue === undefined && page.sourceComplete !== false) return page
  if (page.turns.length === 0) return { ...page, sourceComplete: false, completeness: 'partial' }
  const turns = [...page.turns]
  const last = turns[turns.length - 1]
  turns[turns.length - 1] = {
    ...last,
    errorHint: [last.errorHint, historyCopy.incompleteArchive].filter(Boolean).join('\n')
  }
  return { ...page, turns, sourceComplete: false, completeness: 'partial' }
}


export function createHistoryRuntime() {
  let loadSessionRevision = 0
  let loadSessionAbortController: AbortController | null = null
  // 已加载会话的单条历史缓存：翻页复用归一化事件，但附件只在页越过 IPC 前读取。
  // 这把图片 I/O/base64 与常驻内存限制在可见页；事件源仍完整解析，后续由源级索引继续收窄。
  let sessionHistoryCache: SessionHistoryCache | null = null
  // An older page reads and fsyncs its window; a new session or invalidation must not wait behind it.
  let olderHistoryAbortController: AbortController | null = null

  function abortOlderHistory(reason: string): void {
    olderHistoryAbortController?.abort(new Error(reason))
    olderHistoryAbortController = null
  }

  function invalidateSessionHistoryLoad(reason: string): void {
    loadSessionRevision += 1
    loadSessionAbortController?.abort(new Error(reason))
    loadSessionAbortController = null
    abortOlderHistory(reason)
    sessionHistoryCache = null
  }

  function register(deps: Omit<LoadSessionDependencies,
    'getLoadSessionAbortController' | 'setLoadSessionAbortController' |
    'nextLoadSessionRevision' | 'getLoadSessionRevision' |
    'getSessionHistoryCache' | 'setSessionHistoryCache' |
    'pageWithHookCommands' | 'markIncompleteArchivePage' | 'sessionHistoryCacheKey'
  >): void {
    const sessionHistoryCacheKey = (payload: ProviderContext, cwd: string): string =>
      `${deps.providerContextKey(payload.providerId, cwd, payload.agentProfileId)}\u0000${payload.externalSessionId ?? ''}`
    const shared = {
      getLoadSessionRevision: () => loadSessionRevision,
      getSessionHistoryCache: () => sessionHistoryCache,
      setSessionHistoryCache: (cache: SessionHistoryCache | null) => { sessionHistoryCache = cache },
      pageWithHookCommands, markIncompleteArchivePage, sessionHistoryCacheKey
    }
    registerLoadSessionHandler({
      ...deps, ...shared,
      getLoadSessionAbortController: () => loadSessionAbortController,
      setLoadSessionAbortController: (controller) => { loadSessionAbortController = controller },
      nextLoadSessionRevision: () => {
        abortOlderHistory('session history request superseded')
        return ++loadSessionRevision
      }
    })
    registerOlderHistoryHandler({
      ...shared,
      handleTrusted: deps.handleTrusted,
      resolveKnownProjectDirectory: deps.resolveKnownProjectDirectory,
      providerRegistry: deps.providerRegistry,
      beginOlderHistoryRequest: () => {
        abortOlderHistory('older history request superseded')
        olderHistoryAbortController = new AbortController()
        return olderHistoryAbortController.signal
      }
    })
    registerTurnTerminalEvidenceHandler({
      handleTrusted: deps.handleTrusted,
      appSessionStore: deps.appSessionStore,
      resolveKnownProjectDirectory: deps.resolveKnownProjectDirectory,
      userDataDir: deps.userDataDir
    })
  }
  return { register, invalidateSessionHistoryLoad }
}
