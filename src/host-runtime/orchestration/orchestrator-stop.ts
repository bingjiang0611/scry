import type { OrchestrationCommand } from './orchestrator-commands'
import {
  acceptDecision,
  makeEffect,
  makeEvent,
  stickyReject,
  type DecisionResult,
  type OrchestratorReadView
} from './orchestrator-handlers'
import { heldQueueEvents } from './orchestrator-queue'
import { isTerminalRunLifecycle } from './run-transitions'
import type { PendingOrchestrationEvent, PendingOutboxEffect } from './types'

/**
 * R11: one stop command decides one run. A run that has never started is cancelled outright — there is
 * no process to stop and no reason to hold the session queue — while a live run gets a stop request, a
 * stop effect, and a hold on everything queued behind it.
 */
export function decideRunStop(cmd: Extract<OrchestrationCommand, { type: 'run.stop' }>, view: OrchestratorReadView): DecisionResult {
  const target = view.getRun(cmd.payload.runId)
  if (!target) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  if (isTerminalRunLifecycle(target.lifecycle)) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
  // R11: a run that never started has no process to stop. Cancelling it is the whole stop, and it
  // must not hold the session queue: the stop named one entry, not the queue behind it.
  const queuedStop = target.lifecycle === 'queued'
  const stopEvent = (index: number): PendingOrchestrationEvent => makeEvent(cmd, index, {
    type: 'run.stop_requested',
    stream: `run:${target.runId}`,
    sessionKey: target.sessionKey,
    runId: target.runId,
    cwd: target.cwd,
    payload: { runId: target.runId, ...(cmd.payload.reason ? { reason: cmd.payload.reason } : {}) }
  })
  if (queuedStop) {
    const cancelled = makeEvent(cmd, 1, {
      type: 'run.cancelled',
      stream: `run:${target.runId}`,
      sessionKey: target.sessionKey,
      runId: target.runId,
      cwd: target.cwd,
      payload: {
        runId: target.runId,
        reason: cmd.payload.reason ?? 'stop_requested',
        settledAt: cmd.at,
        recoveredAt: null,
        outcome: {
          status: 'unavailable' as const,
          quality: 'unavailable' as const,
          source: ['host.stop'] as const,
          omissionReason: 'stopped_before_dispatch'
        }
      }
    })
    return acceptDecision(cmd, [stopEvent(0), cancelled], [], {
      runId: target.runId,
      lifecycle: 'cancelled',
      cascadedCount: 0
    })
  }
  const events: PendingOrchestrationEvent[] = [...heldQueueEvents(cmd, target, view), makeEvent(cmd, 0, {
      type: 'run.stop_requested',
      stream: `run:${target.runId}`,
      sessionKey: target.sessionKey,
      runId: target.runId,
      cwd: target.cwd,
      payload: { runId: target.runId, ...(cmd.payload.reason ? { reason: cmd.payload.reason } : {}) }
    })]
  const shadowOnly = Boolean(cmd.payload.shadowOnly)
  const effects: PendingOutboxEffect[] = [
    makeEffect(cmd, 0, {
      kind: 'provider.run.stop',
      runId: target.runId,
      payload: { runId: target.runId, ...(shadowOnly ? { shadowOnly: true } : {}) },
      state: shadowOnly ? 'done' : 'pending',
      leaseOwner: shadowOnly ? 'shadow:no-dispatch' : null,
      claimedAt: shadowOnly ? cmd.at : null
    })
  ]
  const visited = new Set<string>([target.runId])
  const queue = [target.runId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const child of view.listNonTerminalChildRuns(parentId)) {
      if (visited.has(child.runId)) continue
      visited.add(child.runId)
      queue.push(child.runId)
      events.push(
        makeEvent(cmd, events.length, {
          type: 'run.stop_requested',
          stream: `run:${child.runId}`,
          sessionKey: child.sessionKey,
          runId: child.runId,
          cwd: child.cwd,
          payload: { runId: child.runId, cascadeRoot: target.runId }
        })
      )
      effects.push(
        makeEffect(cmd, effects.length, {
          kind: 'provider.run.stop',
          runId: child.runId,
          payload: { runId: child.runId, cascadeRoot: target.runId, ...(shadowOnly ? { shadowOnly: true } : {}) },
          state: shadowOnly ? 'done' : 'pending',
          leaseOwner: shadowOnly ? 'shadow:no-dispatch' : null,
          claimedAt: shadowOnly ? cmd.at : null
        })
      )
    }
  }
  return acceptDecision(cmd, events, effects, { runId: target.runId, cascadedCount: events.length - 1 })
}
