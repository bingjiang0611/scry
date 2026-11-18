// Run controls the daemon answers for the App: steering a running turn, stopping one of
// its background tasks, and reading a run to adopt after a reconnect. The run registry
// lives in the daemon, so these cannot be answered from the App's own memory.
//
// Distinct from `stop`/`answerQuestion`: those are device-visible protocol ops with
// ledger semantics. These are App-only conveniences over the same registry, which is why
// the op is local-scope only (a device never sees it).
import type { AgentSteerResult } from '../../shared/runtime'
import type { BackgroundTaskStopResult } from '../../shared/background-work'
import type { ActiveRun } from '../../shared/trace'

export interface RunControlHandlers {
  steer(payload: unknown): Promise<AgentSteerResult>
  stopBackgroundTask(payload: unknown): Promise<BackgroundTaskStopResult>
  adopt(runId: string): ActiveRun | null
}

export type RunControlMethod = 'steer' | 'stopBackgroundTask' | 'adopt'

export interface RunControlRequest {
  method?: unknown
  runId?: unknown
  payload?: unknown
}

const rejected = (message: string): AgentSteerResult => ({ status: 'rejected', message })

/** A method name is not an authorization: anything unrecognized is refused, not guessed. */
export async function handleRunControl(handlers: RunControlHandlers, request: RunControlRequest): Promise<Record<string, unknown>> {
  const method = request.method
  if (method === 'steer') {
    // The steering helper validates run/provider/directory/session identity against the
    // registry; this layer only decides which handler to call.
    return { steer: await handlers.steer(request.payload) }
  }
  if (method === 'stopBackgroundTask') return { backgroundTask: await handlers.stopBackgroundTask(request.payload) }
  if (method === 'adopt') {
    if (typeof request.runId !== 'string' || request.runId.length === 0 || request.runId.length > 256) {
      return { steer: rejected('runId 无效') }
    }
    return { run: handlers.adopt(request.runId) }
  }
  return { error: 'invalid_request' }
}
