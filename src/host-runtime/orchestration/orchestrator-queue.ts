import type { OrchestrationCommand, RunSubmitPayload } from './orchestrator-commands'
import type { PendingOrchestrationEvent } from './types'
import { makeEvent, type OrchestratorReadView } from './orchestrator-handlers'

/**
 * D1: a session runs one live run at a time. An explicit queue request waits behind it; anything
 * else keeps the old `session_run_active` rejection so a double send still surfaces to the user.
 */
export function decideSubmitQueue(
  view: OrchestratorReadView,
  payload: RunSubmitPayload
): 'immediate' | 'queued' | 'reject' {
  if (!payload.sessionKey || payload.historicalBackfill) return 'immediate'
  if (!view.hasActiveRunForSession(payload.sessionKey)) return 'immediate'
  return payload.claimMode === 'queued' ? 'queued' : 'reject'
}

/** The `run.queued` event states the slot the user sees, not an internal counter. */
export function queuedRunEvent(
  cmd: OrchestrationCommand,
  index: number,
  payload: RunSubmitPayload,
  view: OrchestratorReadView
): PendingOrchestrationEvent {
  return makeEvent(cmd, index, {
    type: 'run.queued',
    stream: `run:${payload.runId}`,
    sessionKey: payload.sessionKey,
    runId: payload.runId,
    cwd: payload.cwd,
    payload: { runId: payload.runId, queuePosition: view.nextQueuePosition?.(payload.sessionKey ?? '') ?? 1 }
  })
}

/**
 * D1: stopping a session holds every queued run behind it. The stop cannot silently let the queue
 * keep firing; only an explicit release resumes it.
 */
export function heldQueueEvents(
  cmd: OrchestrationCommand,
  target: { runId: string; sessionKey: string | null },
  view: OrchestratorReadView
): PendingOrchestrationEvent[] {
  if (!target.sessionKey) return []
  return (view.listQueuedRuns?.(target.sessionKey) ?? []).map((queued) =>
    makeEvent(cmd, 0, {
      type: 'run.queue_held',
      stream: `run:${queued.runId}`,
      sessionKey: queued.sessionKey,
      runId: queued.runId,
      cwd: queued.cwd,
      payload: { runId: queued.runId, heldBy: target.runId }
    })
  )
}

