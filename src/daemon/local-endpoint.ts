import { localOpHandlersFor, type LocalEndpointHandlers } from '../main/remote/host-local-ops'
import { adoptRegisteredRun } from '../main/remote/host-run-control'
import { steerObservedRun } from '../main/run-steering'
import { stopObservedBackgroundTask } from '../main/background-task-control'
import type { DaemonLocalEndpointDeps } from './local-ops/deps'
import { catalogLocalOps } from './local-ops/catalog'
import { conversationLocalOps } from './local-ops/conversation'
import { sessionLifecycleLocalOps } from './local-ops/session-lifecycle'
import { queryLocalOps } from './local-ops/queries'
import { workbenchLocalOps } from './local-ops/workbench'
import { projectLocalOps } from './local-ops/project'
import { mcpLocalOps } from './local-ops/mcp'
import { billingLocalOps } from './local-ops/billing'
import { pairingLocalOps } from './local-ops/pairing'
import { backgroundServiceLocalOps } from './local-ops/background-service'
import { hostMetricsLocalOps } from './local-ops/host-metrics'

export type { DaemonLocalEndpointDeps } from './local-ops/deps'


export function daemonLocalEndpoint(endpointDeps: DaemonLocalEndpointDeps): LocalEndpointHandlers {
  const deps = { ...endpointDeps, links: endpointDeps.links ?? {} }
  return {
    runControl: {
      steer: (payload: unknown) => steerObservedRun(payload, (runId) => deps.runs().get(runId)),
      stopBackgroundTask: (payload: unknown) => stopObservedBackgroundTask(payload, (runId) => deps.runs().get(runId)),
      // The run's own control refuses a unified conversation's run, as it did in process.
      adopt: (runId: string) => adoptRegisteredRun(deps.runs().get(runId))
    },
    localOps: localOpHandlersFor({
      ...catalogLocalOps(deps),
      ...conversationLocalOps(deps),
      ...sessionLifecycleLocalOps(deps),
      ...queryLocalOps(deps),
      ...workbenchLocalOps(deps),
      ...projectLocalOps(deps),
      ...mcpLocalOps(deps),
      ...billingLocalOps(deps),
      ...pairingLocalOps(deps),
      ...backgroundServiceLocalOps(deps),
      ...hostMetricsLocalOps(deps),
      ...deps.terminal.localOps
    }),
    ...(deps.subscribe ? { subscribe: deps.subscribe } : {}),
    terminal: deps.terminal.feed,
    ...(deps.executionTargetBridge ? { executionTargetBridge: deps.executionTargetBridge } : {}),
    attention: { viewed: (sessionKey) => deps.session.dockBadge.remove(sessionKey) }
  }
}
