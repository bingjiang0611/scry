import type { AgentStartRequest } from '../shared/runtime'
import type { ConversationItemRef, Conversation } from '../shared/conversation'
import type { mergeSessionTurns } from './session-history'
import type { readTraceArchiveAsync } from './transcript-archive'
import { ConversationStore } from './conversation-store'
import { ConversationService, type ConversationServiceDeps } from './conversation-service'
import type { AppRunStartOptions } from './app-run-start'
import type { RemoteRunCompletion } from './remote/remote-run-binding'
import type { ProviderRegistry } from './providers/registry'

export interface AppConversationRuntimeDependencies {
  getUserData: () => string
  getProviderRegistry: () => Pick<ProviderRegistry, 'continuationKey' | 'get'>
  forkNative: NonNullable<ConversationServiceDeps['forkNative']>
  startAppRun: (request: AgentStartRequest, options: AppRunStartOptions) => Promise<{ runId: string } | RemoteRunCompletion>
  readConversationHistoryItem: (userData: string, conversation: Conversation, ref: ConversationItemRef) => Promise<string>
  readTraceArchive: typeof readTraceArchiveAsync
  mergeSessionTurns: typeof mergeSessionTurns
}

export function createAppConversationRuntime(deps: AppConversationRuntimeDependencies) {
  let conversationStoreInstance: ConversationStore | undefined
  const conversationStore = (): ConversationStore => conversationStoreInstance ??= new ConversationStore(deps.getUserData())
  const adoptingSessionKeys = new Set<string>()
  let conversationServiceInstance: ConversationService | undefined
  const conversationService = (): ConversationService => conversationServiceInstance ??= new ConversationService({
    store: conversationStore(),
    resolveContinuationKey: (context) => deps.getProviderRegistry().continuationKey(context),
    forkNative: deps.forkNative,
    supportsHistoricalInput: (providerId) => deps.getProviderRegistry().get(providerId).historicalContext === true,
    supportsHistoryReader: (providerId) => deps.getProviderRegistry().get(providerId).historyReader === true,
    startAppRun: async (request, options) => {
      const result = await deps.startAppRun(request, options)
      if (!('runId' in result)) throw new Error('统一对话不能使用远程执行结果')
      return result
    },
    loadItemText: (conversation, ref) => deps.readConversationHistoryItem(deps.getUserData(), conversation, ref),
    loadTurn: async (conversation, turn) => {
      if (!turn.archive) return undefined
      const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)
      if (!binding) return undefined
      const archive = await deps.readTraceArchive({
        userDataDir: deps.getUserData(), cwd: conversation.cwd,
        sessionId: turn.archive.sessionId, providerId: binding.providerId
      })
      return archive ? deps.mergeSessionTurns([], archive, { userDataDir: deps.getUserData() }).find((candidate) => candidate.runId === turn.runId) : undefined
    }
  })
  return { conversationStore, conversationService, adoptingSessionKeys }
}
