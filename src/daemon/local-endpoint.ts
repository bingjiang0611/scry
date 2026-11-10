import { localOpHandlersFor, type LocalEndpointHandlers, type LocalOpHandler } from '../main/remote/host-local-ops'
import { catalogChannelHandlers, providerControlChannelHandlers, providerDetectionChannelHandlers } from '../main/bootstrap/startup-channels'
import { conversationChannelTable } from '../main/bootstrap/conversation'
import { resolveSessionRunIds } from '../main/db'
import { deleteConversationHistory } from '../main/conversation-history'
import { steerObservedRun } from '../main/run-steering'
import { stopObservedBackgroundTask } from '../main/background-task-control'
import type { AppEventFeed } from '../main/remote/app-event-feed'
import type { RunRegistry } from '../main/run-registry'
import type { RunControl } from '../main/bootstrap/run-control'
import type { ActiveRun } from '../shared/trace'
import type { createSessionCatalog } from '../main/bootstrap/session-catalog'
import type { createWorkspaceRuntime } from '../main/bootstrap/workspace-runtime'
import type { createProviderRuntime } from '../main/bootstrap/provider-runtime'
import type { createPiProfileRuntime } from '../main/bootstrap/pi-profiles'
import type { createSessionState } from '../main/bootstrap/session-state'
import type { createHistoryRuntime } from '../main/bootstrap/history-runtime'
import type { createDaemonConversationSend } from './conversation-send'

// What this daemon serves on the App's own endpoint: the App channels it answers (built
// from the same handler factories Electron main registers, so both answer alike), the
// run controls bound to its live runs, and the App event feed. A paired device on the
// network endpoint reaches none of it.

export interface DaemonLocalEndpointDeps {
  catalog: ReturnType<typeof createSessionCatalog>
  workspace: ReturnType<typeof createWorkspaceRuntime>
  providers: ReturnType<typeof createProviderRuntime>
  pi: ReturnType<typeof createPiProfileRuntime>
  session: ReturnType<typeof createSessionState>
  history: ReturnType<typeof createHistoryRuntime>
  historyChannels: Record<string, (event: unknown, ...args: never[]) => unknown>
  conversationSend: ReturnType<typeof createDaemonConversationSend>
  events: AppEventFeed
  runs: () => RunRegistry<ActiveRun, RunControl>
  startupManagedRecovery: () => Promise<void>
  userDataDir: string
}

export function daemonLocalEndpoint(deps: DaemonLocalEndpointDeps): LocalEndpointHandlers {
  const { catalog, workspace, providers, pi, session, history, conversationSend, events } = deps
  const conversationTable = conversationChannelTable({
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
  const conversationLocalOps = Object.fromEntries(Object.entries({ ...conversationTable.handlers, ...deps.historyChannels })
    .map(([channel, listener]) => [channel, (...args: unknown[]) => (listener as (event: unknown, ...values: unknown[]) => unknown)(undefined, ...args)]))
  conversationLocalOps['conversation:send'] = conversationSend.answer(conversationLocalOps['conversation:send'] as (request: unknown) => Promise<unknown>)
  return {
    // Steering and background-task stops are bound to the live run, so they answer from
    // this process's registry and cannot be replayed from another process.
    runControl: {
      steer: (payload: unknown) => steerObservedRun(payload, (runId) => deps.runs().get(runId)),
      stopBackgroundTask: (payload: unknown) => stopObservedBackgroundTask(payload, (runId) => deps.runs().get(runId)),
      adopt: (runId: string) => deps.runs().get(runId)?.state ?? null
    },
    localOps: localOpHandlersFor({
      ...catalogChannelHandlers({
        appSessionStore: catalog.appSessionStore,
        listProjectCatalog: catalog.listProjectCatalog,
        recentStore: workspace.recentStore
      }),
      ...providerDetectionChannelHandlers({
        smokeProviderEnabled: providers.smokeProviderEnabled,
        smokeDetectedAgents: providers.smokeDetectedAgents,
        storedPiProfilesNotDetected: pi.storedPiProfilesNotDetected,
        providerCompatibility: providers.providerCompatibility,
        detectInstalledAgents: pi.detectInstalledAgents,
        providerRegistry: providers.providerRegistry
      }),
      ...providerControlChannelHandlers({ providerRegistry: providers.providerRegistry, withProviderOperation: session.withProviderOperation }),
      ...conversationLocalOps
    } as Record<string, LocalOpHandler>),
    events
  }
}
