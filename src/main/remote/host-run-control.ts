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
  /**
   * The run to show, null when the registry no longer has it, or a refusal: a unified
   * conversation's run belongs to its stable conversation entry and must not be taken
   * over by the legacy session entry. A refusal is the registry's own reason, which the
   * App raises to the caller exactly as an in-process adoption did.
   */
  adopt(runId: string): ActiveRun | null | RunAdoptionRefusal
}

export interface RunAdoptionRefusal {
  refused: string
}

/**
 * Adopting a registered run: the run's own control decides whether it may be taken over
 * (a unified conversation's run refuses), and only then is the run returned to show.
 */
export function adoptRegisteredRun(entry: { state: ActiveRun; control: { adoptSession(): void } } | undefined): ActiveRun | null | RunAdoptionRefusal {
  if (!entry) return null
  if (!entry.state.done) {
    try {
      entry.control.adoptSession()
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) }
    }
  }
  return entry.state
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
    if (request.payload !== undefined && request.payload !== 'traceContext') return { error: 'invalid_request' }
    const adopted = handlers.adopt(request.runId)
    if (adopted && 'refused' in adopted) return { run: null, refused: adopted.refused }
    if (request.payload === undefined) return { run: adopted } // Older desktop clients still expect the inline snapshot.
    if (adopted === null) return { run: null }
    // No trace or attachments in this reply. The desktop trace reader handles large snapshots.
    // Omit the provider session id: it can become bound between this lookup and that read.
    return { traceContext: { cwd: adopted.cwd, providerId: adopted.providerId, agentProfileId: adopted.agentProfileId } }
  }
  return { error: 'invalid_request' }
}
