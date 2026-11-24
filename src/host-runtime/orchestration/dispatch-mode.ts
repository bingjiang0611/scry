import type { AgentSteerResult } from '../../shared/runtime'

/**
 * D2: one entry point chooses how a message reaches the session. The four modes build on what
 * already exists — the durable queue (D1), the live steer control (C2) and the stop path — so a
 * caller states an intent instead of re-implementing the delivery rules.
 *
 * - `immediate`: try to dispatch now; the authority requeues when the session is busy.
 * - `queue`: wait behind the live run and dispatch when it settles.
 * - `steer`: deliver into the run that is already streaming (native steer only).
 * - `restart`: stop the live run, then queue the message behind its terminal state.
 */
export type DispatchMode = 'immediate' | 'queue' | 'steer' | 'restart'

export const DISPATCH_MODES: ReadonlySet<DispatchMode> = new Set(['immediate', 'queue', 'steer', 'restart'])

export function isDispatchMode(value: unknown): value is DispatchMode {
  return typeof value === 'string' && DISPATCH_MODES.has(value as DispatchMode)
}

export interface DispatchDeps {
  /** Submits with the D1 claim mode; returns the run id the host recorded. */
  submit: (claimMode: 'immediate' | 'queued') => Promise<{ runId: string }>
  /** The live run this message is aimed at, when the caller named one. */
  liveRunId: () => string | undefined
  steer: (runId: string) => Promise<AgentSteerResult>
  /** Requests the stop of the live run; true when a stop was registered. */
  stop: (runId: string) => boolean
}

export type DispatchResult =
  | { status: 'submitted'; runId: string; mode: DispatchMode }
  | { status: 'steered' }
  | { status: 'stopped_and_queued'; runId: string; stoppedRunId: string }
  | { status: 'rejected'; reason: string; message: string }

export async function dispatchMessage(mode: DispatchMode, deps: DispatchDeps): Promise<DispatchResult> {
  if (mode === 'immediate') {
    const run = await deps.submit('immediate')
    return { status: 'submitted', runId: run.runId, mode }
  }
  if (mode === 'queue') {
    const run = await deps.submit('queued')
    return { status: 'submitted', runId: run.runId, mode }
  }
  if (mode === 'steer') {
    const runId = deps.liveRunId()
    if (!runId) return { status: 'rejected', reason: 'no_live_run', message: '当前没有可插话的运行' }
    const result = await deps.steer(runId)
    // C2: the steer's own evidence decides. A rejection never silently becomes a new run.
    return result.status === 'accepted'
      ? { status: 'steered' }
      : { status: 'rejected', reason: `steer_${result.status}`, message: result.message }
  }
  const stoppedRunId = deps.liveRunId()
  if (!stoppedRunId) return { status: 'rejected', reason: 'no_live_run', message: '当前没有可重启的运行' }
  if (!deps.stop(stoppedRunId)) return { status: 'rejected', reason: 'stop_rejected', message: '停止请求被拒绝，未重启' }
  // The queued submit is released by the terminal transition, so the message cannot overtake
  // the run it replaces.
  const run = await deps.submit('queued')
  return { status: 'stopped_and_queued', runId: run.runId, stoppedRunId }
}
