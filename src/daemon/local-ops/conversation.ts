import { conversationChannelTable } from '../../main/bootstrap/conversation'
import { resolveSessionRunIds } from '../../main/db'
import { deleteConversationHistory } from '../../main/conversation-history'
import { withoutEvent, type DaemonLocalOpGroup } from './deps'

// Unified conversation ledger (B4-L4-2), from the table main registers.
export const conversationLocalOps: DaemonLocalOpGroup = (deps) => {
  const { catalog, workspace, providers, session, history, conversationSend, events } = deps
  const table = conversationChannelTable({
    resolveKnownProjectDirectory: workspace.resolveKnownProjectDirectory,
    providerContextKey: session.providerContextKey,
    providerSessionKey: session.providerSessionKey,
    contextAdmission: session.contextAdmission,
    getStartupManagedRecovery: deps.startupManagedRecovery,
    appSessionStore: catalog.appSessionStore,
    conversationStore: catalog.conversationStore,
    conversationService: catalog.conversationService,
    assertLegacyConversationWriteAllowed: catalog.assertLegacyConversationWriteAllowed,
    getRuns: deps.runs,
    providerRegistry: providers.providerRegistry,
    rememberProject: workspace.rememberProject,
    deletingSessions: session.deletingSessions,
    adoptingSessionKeys: session.adoptingSessionKeys,
    // The history cache invalidated is this daemon's own; the App hears of the change
    // through the event feed.
    invalidateSessionHistoryLoad: history.invalidateSessionHistoryLoad,
    publishDataUpdated: (event) => events.append({ kind: 'data', event }),
    deleteOneSession: async () => { throw new Error('daemon_capability_unavailable:session-delete') },
    resolveSessionRunIds,
    deleteConversationHistory,
    appUserDataDir: deps.userDataDir
  })
  const ops = withoutEvent(table.handlers)
  ops['conversation:send'] = conversationSend.answer(ops['conversation:send'] as (request: unknown) => Promise<unknown>)
  return ops
}
