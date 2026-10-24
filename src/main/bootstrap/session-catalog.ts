import { app, type BrowserWindow } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { AgentDataUpdated, AgentStartRequest } from '../../shared/runtime'
import { createAppSessionStore, mergeProjectMetas, type ProjectMeta } from '../app-store'
import { ConversationStore, type NativeSessionScope } from '../conversation-store'
import { ConversationService, type ConversationServiceDeps } from '../conversation-service'
import type { ProviderRegistry } from '../providers/registry'
import { recoverQoderCatalogSessions } from '../trace-catalog-recovery'
import { readConversationHistoryItem } from '../conversation-history'
import { readTraceArchiveAsync } from '../transcript-archive'
import { mergeSessionTurns } from '../session-history'
import type { RemoteRunCompletion } from '../remote/remote-run-binding'
import type { AppRunStartOptions } from './run-frontdoor'
import type { createWorkspaceRuntime } from './workspace-runtime'

export function createSessionCatalog({
  recentStore, projectStore, getWindow, unsettledRuns, getProviderRegistry,
  forkManagedConversation, startAppRun
}: {
  recentStore: ReturnType<typeof createWorkspaceRuntime>['recentStore']
  projectStore: ReturnType<typeof createWorkspaceRuntime>['projectStore']
  getWindow: () => BrowserWindow | null
  unsettledRuns: () => ActiveRun[]
  getProviderRegistry: () => ProviderRegistry
  forkManagedConversation: NonNullable<ConversationServiceDeps['forkNative']>
  startAppRun: (request: AgentStartRequest, options?: AppRunStartOptions) => Promise<{ runId: string } | RemoteRunCompletion>
}) {
  let traceCatalogRecovery: Promise<void> | null = null
  // Runs in the background: the project list must not wait for an archive scan. The catalog is only a
  // recovery hint, so a failed recovery is logged and the next launch retries from the dirty index.
  const recoverTraceCatalogOnce = (): Promise<void> => {
    if (traceCatalogRecovery) return traceCatalogRecovery
    traceCatalogRecovery = recoverQoderCatalogSessions(app.getPath('userData'), appSessionStore())
      .then((recovered) => {
        // The renderer may already show a list read before recovery finished; ask it to reload.
        if (recovered > 0) getWindow()?.webContents.send('agent:dataUpdated', { kind: 'catalog_recovered' } satisfies AgentDataUpdated)
      })
      .catch((error: unknown) => {
        console.warn('[scry] trace catalog recovery failed:', error instanceof Error ? error.message : String(error))
      })
    return traceCatalogRecovery
  }
  const listProjectCatalog = async (): Promise<ProjectMeta[]> => {
    void recoverTraceCatalogOnce()
    const sessionProjects = appSessionStore().listProjects()
    const now = Date.now()
    const observed = new Map<string, number>()
    recentStore().load().forEach((cwd, index) => observed.set(cwd, now - index))
    for (const project of sessionProjects) {
      if (project.cwd) observed.set(project.cwd, Math.max(observed.get(project.cwd) ?? 0, project.mtime))
    }
    const store = projectStore()
    store.seed([...observed].map(([cwd, lastOpenedAt]) => ({ cwd, lastOpenedAt })))
    const projects = mergeProjectMetas(store.load(), sessionProjects)
    return Promise.all(projects.map(async (project) => {
      const conversations = await conversationService().list(project.cwd)
      const ownedNativeAliases = await conversationService().nativeSessionAliases(project.cwd)
      return {
        ...project,
        // Only the local sidebar projection hides aliases. Raw app/provider
        // catalogs remain unchanged and retain their native evidence.
        sessions: project.sessions.filter((session) => {
          const nativeId = session.externalSessionId ?? session.sessionId
          const alias = `${session.providerId}\0${session.agentProfileId ?? ''}\0${project.cwd}\0${nativeId}`
          return !ownedNativeAliases.has(alias)
        }),
        conversations
      }
    }))
  }
  let appSessionStoreInstance: ReturnType<typeof createAppSessionStore> | undefined
  const appSessionStore = () => appSessionStoreInstance ??= createAppSessionStore(app.getPath('userData'))
  let conversationStoreInstance: ConversationStore | undefined
  const conversationStore = () => conversationStoreInstance ??= new ConversationStore(app.getPath('userData'))
  async function assertLegacyConversationWriteAllowed(scope: NativeSessionScope, deletion?: { ownerId?: string }): Promise<void> {
    const activeIds = new Set(unsettledRuns().filter((run) => run.providerId === scope.providerId &&
      run.agentProfileId === scope.agentProfileId && (run.cwd ?? '') === scope.cwd).map((run) => run.runId))
    if (activeIds.size && (await conversationStore().list(scope.cwd)).some((conversation) =>
      conversation.turns.some((turn) => activeIds.has(turn.runId)))) {
      throw new Error('统一对话仍在执行或保存证据，不能从旧入口写入；请等待本轮收敛')
    }
    await conversationStore().assertLegacyWriteAllowed(scope, deletion)
  }
  let conversationServiceInstance: ConversationService | undefined
  const conversationService = (): ConversationService => conversationServiceInstance ??= new ConversationService({
    store: conversationStore(),
    resolveContinuationKey: (context) => getProviderRegistry().continuationKey(context),
    forkNative: forkManagedConversation,
    supportsHistoricalInput: (providerId) => getProviderRegistry().get(providerId).historicalContext === true,
    supportsHistoryReader: (providerId) => getProviderRegistry().get(providerId).historyReader === true,
    startAppRun: async (request, options) => {
      const result = await startAppRun(request, options)
      if (!('runId' in result)) throw new Error('统一对话不能使用远程执行结果')
      return result
    },
    loadItemText: (conversation, ref) => readConversationHistoryItem(app.getPath('userData'), conversation, ref),
    loadTurn: async (conversation, turn) => {
      if (!turn.archive) return undefined
      const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)
      if (!binding) return undefined
      const archive = await readTraceArchiveAsync({
        userDataDir: app.getPath('userData'), cwd: conversation.cwd,
        sessionId: turn.archive.sessionId, providerId: binding.providerId
      })
      return archive ? mergeSessionTurns([], archive, { userDataDir: app.getPath('userData') }).find((candidate) => candidate.runId === turn.runId) : undefined
    }
  })

  return {
    appSessionStore, conversationStore, conversationService,
    assertLegacyConversationWriteAllowed, listProjectCatalog
  }
}
