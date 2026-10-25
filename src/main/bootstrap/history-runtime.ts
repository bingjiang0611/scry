import type { ProviderContext } from '../../shared/provider'
import { historyCopy } from '../../shared/constants/copy'
import { attachConfiguredHookCommands, loadClaudeHookConfig } from '../hook-config'
import type { SessionHistoryPage } from '../session-history'
import { registerLoadSessionHandler, type LoadSessionDependencies } from './history-load'
import { registerOlderHistoryHandler, type SessionHistoryCache } from './history-older'

// Hook 命令附写只对当前页的事件做，而不是对整个会话的全部事件做。
function pageWithHookCommands(
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

  function invalidateSessionHistoryLoad(reason: string): void {
    loadSessionRevision += 1
    loadSessionAbortController?.abort(new Error(reason))
    loadSessionAbortController = null
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
      nextLoadSessionRevision: () => ++loadSessionRevision
    })
    registerOlderHistoryHandler({
      ...shared,
      handleTrusted: deps.handleTrusted,
      resolveKnownProjectDirectory: deps.resolveKnownProjectDirectory,
      providerRegistry: deps.providerRegistry
    })
  }
  return { register, invalidateSessionHistoryLoad }
}
