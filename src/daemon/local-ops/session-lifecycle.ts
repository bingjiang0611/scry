import { createSessionLifecycle, type SessionDeletionRequest } from '../../main/bootstrap/session-lifecycle'
import type { DaemonLocalOpGroup } from './deps'

// Session delete, rename/pin/archive and the archived list and purge, from the lifecycle
// main uses. No dialogs here: in daemon mode the App asked the user before it sent the
// call (session-lifecycle-daemon.ts on the App side).
export const sessionLifecycleLocalOps: DaemonLocalOpGroup = (deps) => {
  const { catalog, session, events } = deps
  const lifecycle = createSessionLifecycle({
    getRuns: deps.runs,
    appSessionStore: catalog.appSessionStore,
    conversationStore: catalog.conversationStore,
    contextAdmission: session.contextAdmission,
    getStartupManagedRecovery: deps.startupManagedRecovery,
    providerContextKey: session.providerContextKey,
    providerSessionKey: session.providerSessionKey,
    deletingSessions: session.deletingSessions,
    sessionDiffBaselines: session.sessionDiffBaselines,
    sessionBaselineKey: session.sessionBaselineKey,
    recordingBlockedSessions: session.recordingBlockedSessions,
    assertLegacyConversationWriteAllowed: catalog.assertLegacyConversationWriteAllowed,
    sessionByContext: session.sessionByContext,
    adoptingSessionKeys: session.adoptingSessionKeys,
    dockBadge: session.dockBadge,
    appUserDataDir: deps.userDataDir,
    requestRunStop: deps.requestRunStop,
    prepareConversationDeletion: (conversation) => {
      if (!deps.links.prepareConversationDeletion) throw new Error('daemon_capability_unavailable:conversation-deletion')
      return deps.links.prepareConversationDeletion(conversation)
    },
    publishDataUpdated: (event) => events.append({ kind: 'data', event })
  })
  deps.links.deleteOneSession = (request, options) => lifecycle.deleteOneSession(request as SessionDeletionRequest, options as Parameters<typeof lifecycle.deleteOneSession>[1])
  return {
    // The App confirmed; the daemon reports a failure in the result, never a dialog.
    'agent:deleteSession': (request: unknown) => lifecycle.deleteOneSession(request as SessionDeletionRequest, { confirm: false, notifyFailure: false }),
    'agent:renameSession': (request: unknown, title: unknown) => lifecycle.renameSession(request, title),
    'agent:setSessionPinned': (request: unknown, pinned: unknown) => lifecycle.setSessionPinned(request, pinned),
    'agent:setSessionArchived': (request: unknown, archived: unknown) => lifecycle.setSessionArchived(request, archived),
    'agent:listArchivedSessions': () => lifecycle.listArchivedSessions(),
    // The count the App asked the user about; without it nothing is deleted.
    'agent:deleteArchivedSessions': (confirmedCount: unknown) => {
      if (typeof confirmedCount !== 'number' || !Number.isSafeInteger(confirmedCount) || confirmedCount < 0) throw new Error('已存档会话删除未经确认')
      return lifecycle.deleteArchivedSessions(confirmedCount)
    }
  }
}
