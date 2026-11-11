import { localOpHandlersFor, type LocalEndpointHandlers } from '../main/remote/host-local-ops'
import { steerObservedRun } from '../main/run-steering'
import { stopObservedBackgroundTask } from '../main/background-task-control'
import type { DaemonLocalEndpointDeps } from './local-ops/deps'
import { catalogLocalOps } from './local-ops/catalog'
import { conversationLocalOps } from './local-ops/conversation'
import { sessionLifecycleLocalOps } from './local-ops/session-lifecycle'
import { queryLocalOps } from './local-ops/queries'
import { workbenchLocalOps } from './local-ops/workbench'
import { projectLocalOps } from './local-ops/project'

export type { DaemonLocalEndpointDeps } from './local-ops/deps'

// What this daemon serves on the App's own endpoint: the App channels it answers (built
// from the same handler factories Electron main registers, so both answer alike), the
// run controls bound to its live runs, and the App event feed. A paired device on the
// network endpoint reaches none of it. Each group of channels lives in local-ops/.

export function daemonLocalEndpoint(endpointDeps: DaemonLocalEndpointDeps): LocalEndpointHandlers {
  const deps = { ...endpointDeps, links: {} }
  return {
    // Steering and background-task stops are bound to the live run, so they answer from
    // this process's registry and cannot be replayed from another process.
    runControl: {
      steer: (payload: unknown) => steerObservedRun(payload, (runId) => deps.runs().get(runId)),
      stopBackgroundTask: (payload: unknown) => stopObservedBackgroundTask(payload, (runId) => deps.runs().get(runId)),
      adopt: (runId: string) => deps.runs().get(runId)?.state ?? null
    },
    localOps: localOpHandlersFor({
      ...catalogLocalOps(deps),
      ...conversationLocalOps(deps),
      ...sessionLifecycleLocalOps(deps),
      ...queryLocalOps(deps),
      ...workbenchLocalOps(deps),
      ...projectLocalOps(deps),
      ...deps.terminal.localOps
    }),
    events: deps.events,
    terminal: deps.terminal.feed,
    // This daemon cannot see the App's window; the App says what the user viewed (E1b).
    attention: { viewed: (sessionKey) => deps.session.dockBadge.remove(sessionKey) }
  }
}
