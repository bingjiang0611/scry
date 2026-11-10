import type { AppEventFeed } from '../../main/remote/app-event-feed'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { RunRegistry } from '../../main/run-registry'
import type { RunControl } from '../../main/bootstrap/run-control'
import type { ActiveRun } from '../../shared/trace'
import type { createSessionCatalog } from '../../main/bootstrap/session-catalog'
import type { createWorkspaceRuntime } from '../../main/bootstrap/workspace-runtime'
import type { createProviderRuntime } from '../../main/bootstrap/provider-runtime'
import type { createPiProfileRuntime } from '../../main/bootstrap/pi-profiles'
import type { createSessionState } from '../../main/bootstrap/session-state'
import type { createHistoryRuntime } from '../../main/bootstrap/history-runtime'
import type { createDaemonConversationSend } from '../conversation-send'

// What the daemon's local-op groups are built from: the same runtime objects Electron
// main builds its handlers from, owned here by the daemon.

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

/** One group's App channels, keyed by channel, called with the renderer's arguments. */
export type DaemonLocalOpGroup = (deps: DaemonLocalEndpointDeps) => Record<string, LocalOpHandler>

/** An IPC listener table (event first) as a local-op table (arguments only). */
export function withoutEvent(table: Record<string, unknown>): Record<string, LocalOpHandler> {
  return Object.fromEntries(Object.entries(table).map(([channel, listener]) =>
    [channel, ((...args: unknown[]) => (listener as (event: unknown, ...values: unknown[]) => unknown)(undefined, ...args)) as LocalOpHandler]))
}
